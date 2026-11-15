"""Chatterbox multilingual v3 on MLX (Apple silicon), through mlx-audio.

The model loads from the voice folder's ``models/``, a Hugging Face hub
cache that the helper filled itself; ``__main__`` has put the hub
offline, so mlx-audio's own lookup of the speech tokenizer
(``mlx-community/S3TokenizerV2``, by repo id) resolves to that folder
and never reaches the network.

The speed-ups (docs/plan.md, Phase 52, items 2 and 2b), all set in the
lock's ``engine`` object:

- the text-to-token transformer (T3) quantized to 8 bits at load;
- each voice's conditionals computed once, with the decoder's reference
  prompt cut to ``promptSeconds`` (the flow decoder works over the
  prompt and the line together at every step, so a 10 s prompt was most
  of its work);
- ``flowSteps`` flow-matching steps instead of mlx-audio's 10;
- the T3 loop pipelined (the next step is queued on the GPU before the
  current token is read back), drawing its samples from the line's own
  random key, so a line's tokens are the same streamed or not.

The T3 loop is mlx-audio 0.6.5's ``T3.inference`` (with
``Model.generate``'s preparation) rewritten as a generator, so a line can
be decoded in chunks while its tokens are still coming
(``speak_stream``; ``streaming.py`` has the scheme).
"""

from __future__ import annotations

import sys
import tempfile
import zlib
from collections.abc import Iterator
from pathlib import Path

from .engine import Engine
from .install import model_dir
from .streaming import ChunkPlan, Joiner

SPEECH_VOCAB = 6561  # S3 speech tokens; above are start/stop markers
# A streamed chunk's joins, in mel frames (20 ms each): the previous
# chunk's last MARGIN frames are never sent (the vocoder rendered them with
# no frames after them); the CROSSFADE frames before them are sent
# crossfaded with their second rendering, which has CONTEXT frames of past
# before it. Measured on the bench, the two renderings of the crossfade
# differ by 0.4% RMS (median; 5% at most), so the join is seamless.
MARGIN = 8
CROSSFADE = 8
CONTEXT = 16
HOP = 480  # samples per mel frame at 24 kHz


class ChatterboxMLX(Engine):
    name = "chatterbox-mlx"

    def __init__(self, root: Path, lock: dict) -> None:
        super().__init__(root, lock)
        self.settings = lock["engine"]
        self.revisions = {m["repo"]: m["revision"] for m in lock["model"]}
        self.model = None
        self._warmed = False

    def identity(self) -> dict:
        return {"engine": self.name, "model": self.revisions,
                "settings": self.settings}

    def load(self) -> None:
        lib = str(self.root / "lib")
        if lib not in sys.path:
            sys.path.insert(0, lib)
        tmp = self.root / "cache" / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        tempfile.tempdir = str(tmp)
        import mlx.nn as nn
        from mlx_audio.tts.utils import load_model

        repo = self.settings["repo"]
        snapshot = model_dir(self.root, repo) / "snapshots" / (
            self.revisions[repo])
        model = load_model(snapshot)
        group = self.settings["quantizeGroupSize"]
        nn.quantize(model.t3.tfmr, group_size=group,
                    bits=self.settings["quantizeBits"],
                    class_predicate=lambda _, m: isinstance(m, nn.Linear)
                    and m.weight.shape[-1] % group == 0)
        model.s3gen.flow.n_timesteps = self.settings["flowSteps"]
        self.model = model
        self._warmed = False
        self.loaded = True

    def unload(self) -> None:
        self.model = None
        self.loaded = False
        import gc

        import mlx.core as mx
        gc.collect()
        mx.clear_cache()

    def prepare_voice(self, reference: Path) -> object:
        import mlx.core as mx
        model = self.model
        conds = model.prepare_conditionals(  # type: ignore[union-attr]
            str(reference), model.sample_rate,  # type: ignore[union-attr]
            self.settings["exaggeration"])
        # The decoder's prompt: its first promptSeconds (50 mel frames and
        # 25 tokens a second).
        tokens = int(self.settings["promptSeconds"] * 25)
        gen = dict(conds.gen)
        gen["prompt_token"] = gen["prompt_token"][:, :tokens]
        gen["prompt_token_len"] = mx.array([gen["prompt_token"].shape[1]])
        gen["prompt_feat"] = gen["prompt_feat"][:, :2 * tokens]
        gen["prompt_feat_len"] = mx.array([gen["prompt_feat"].shape[1]])
        mx.eval(list(gen.values()))
        conds.gen = gen
        if not self._warmed:
            # The first generation compiles Metal kernels: do it now, so
            # the reader's first line is as quick as the rest. Streaming
            # too, whose chunks have other shapes.
            self.speak(conds, "Ready.", "en")
            for _ in self.speak_stream(conds, "Ready, and steady.", "en"):
                pass
            self._warmed = True
        return conds

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        import mlx.core as mx
        seed = zlib.crc32(text.encode())
        tokens = list(self._tokens(voice, text, lang, seed))
        mx.random.seed(seed)  # the vocoder's noise
        wav = self.model.s3gen(  # type: ignore[union-attr]
            speech_tokens=mx.array([tokens], dtype=mx.int32),
            ref_dict=voice.gen, finalize=True)  # type: ignore[attr-defined]
        pcm = self._pcm(wav)
        mx.clear_cache()
        return pcm, self.model.sample_rate  # type: ignore[union-attr]

    def speak_stream(self, voice: object, text: str,
                     lang: str) -> Iterator[tuple[bytes, int, bool]]:
        """The line in chunks (streaming.py): each decodes the prompt and
        the tokens from contextSeconds before the previous cut, keeps the
        mel from the cut on, and re-vocodes the previous chunk's last
        frames with its source signal for the crossfade."""
        import mlx.core as mx
        import numpy as np
        s3gen = self.model.s3gen  # type: ignore[union-attr]
        rate = self.model.sample_rate  # type: ignore[union-attr]
        opts = self.settings["stream"]
        plan = ChunkPlan(opts["firstSeconds"], opts["chunkSeconds"],
                         opts["growth"], opts["limitSeconds"])
        joiner = Joiner(CROSSFADE * HOP)
        context = round(opts["contextSeconds"] * 25)
        seed = zlib.crc32(text.encode())
        tokens: list[int] = []
        state: dict = {"offset": 0, "cache": None, "first": True}

        def chunk(final: bool) -> bytes:
            mx.random.seed(seed + len(tokens))  # the vocoder's noise
            # The tokens from contextSeconds before the last cut: the
            # frames after the cut need that much context, and a window
            # keeps a long line's later chunks as quick as its first.
            start = max(0, state["offset"] - context)
            mel = s3gen.flow_inference(
                mx.array([tokens[start:]], dtype=mx.int32),
                ref_dict=voice.gen, finalize=final)  # type: ignore[attr-defined]
            mel = mel[:, :, (state["offset"] - start) * 2:]
            state["offset"] = len(tokens) if final else plan.cut(len(tokens))
            # The vocoder renders the previous chunk's last frames again,
            # from the same mel and source signal, with CONTEXT frames of
            # past; that context's samples are dropped.
            drop = 0
            if state["cache"] is not None:
                drop = state["cache"][0].shape[2] - CROSSFADE - MARGIN
                mel = mx.concatenate([state["cache"][0], mel], axis=2)
                source = state["cache"][1]
            else:
                source = mx.zeros((1, 1, 0))
            wav, source = s3gen.hift_inference(mel, source)
            if not final:
                keep = min(CONTEXT + CROSSFADE + MARGIN, mel.shape[2])
                state["cache"] = (mel[:, :, -keep:],
                                  source[:, :, -keep * HOP:])
            wav = np.array(wav).reshape(-1).astype(np.float32)[drop * HOP:]
            if not final:
                wav = wav[:len(wav) - MARGIN * HOP]
            if state["first"]:
                # The fade-in mlx-audio gives a whole line's start.
                fade = np.array(s3gen.trim_fade)
                n = min(len(fade), len(wav))
                wav[:n] *= fade[:n]
                state["first"] = False
            out = joiner.push(wav, final)
            return (np.clip(out, -1.0, 1.0) * 32767).astype("<i2").tobytes()

        for token in self._tokens(voice, text, lang, seed):
            tokens.append(token)
            if plan.due(len(tokens)):
                yield chunk(False), rate, False
        yield chunk(True), rate, True
        mx.clear_cache()

    @staticmethod
    def _pcm(wav: object) -> bytes:
        import numpy as np
        audio = np.array(wav).reshape(-1).astype(np.float32)
        return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()

    def _tokens(self, conds: object, text: str, lang: str,
                seed: int) -> Iterator[int]:
        """The line's speech tokens as T3 makes them."""
        import mlx.core as mx
        from mlx_audio.lm.models.cache import make_prompt_cache
        from mlx_audio.lm.sample_utils import (
            apply_min_p,
            make_logits_processors,
        )
        model, s = self.model, self.settings
        t3 = model.t3  # type: ignore[union-attr]
        cfg = s["cfgWeight"]
        limit = s["maxTokens"]
        text_tokens = model._tokenize_text(text, lang)  # type: ignore[union-attr]
        text_tokens = mx.concatenate([text_tokens, text_tokens], axis=0)
        sot = mx.full((2, 1), t3.hp.start_text_token, dtype=mx.int32)
        eot = mx.full((2, 1), t3.hp.stop_text_token, dtype=mx.int32)
        text_tokens = mx.concatenate([sot, text_tokens, eot], axis=1)
        mx.clear_cache()
        embeds = t3._prepare_inference_context(
            t3_cond=conds.t3, text_tokens=text_tokens,  # type: ignore[attr-defined]
            cfg_weight=cfg)
        cache = make_prompt_cache(t3.tfmr)
        penalties = make_logits_processors(
            logit_bias=None, repetition_penalty=s["repetitionPenalty"],
            repetition_context_size=limit)
        key = [mx.random.key(seed)]

        def sample(hidden: object, ids: object) -> object:
            logits = t3.speech_head(hidden[:, -1:, :]).squeeze(1)
            cond, uncond = logits[0:1, :], logits[1:2, :]
            logits = cond + cfg * (cond - uncond)
            for penalty in penalties:
                logits = penalty(ids, logits)
            logits = logits.astype(mx.float32)
            logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
            key[0], sub = mx.random.split(key[0])
            return mx.random.categorical(
                apply_min_p(logprobs, s["minP"]) * (1 / s["temperature"]),
                key=sub)

        # [cond | text | BOS | BOS]: CFG runs the batch twice, the second
        # without the text's conditioning.
        ids = mx.array([[t3.hp.start_speech_token]], dtype=mx.int32)
        hidden = t3.tfmr.model(inputs=None, input_embeddings=embeds,
                               cache=cache)
        token = sample(hidden, ids)
        mx.async_eval(token)
        for step in range(limit):
            ids = mx.concatenate(
                [ids, token.reshape(1, 1).astype(mx.int32)], axis=1)
            following = None
            if step + 1 < limit:
                embed = (t3.speech_emb(token.reshape(1, 1))
                         + t3.speech_pos_emb.get_fixed_embedding(step + 1))
                hidden = t3.tfmr.model(
                    inputs=None,
                    input_embeddings=mx.concatenate([embed, embed], axis=0),
                    cache=cache)
                following = sample(hidden, ids)
                mx.async_eval(following, ids)
            value = int(token.item())
            if value == t3.hp.stop_speech_token:
                return
            if value < SPEECH_VOCAB:
                yield value
            if following is None:
                return
            token = following

    def stats(self) -> dict:
        if not self.loaded:
            return {}
        import mlx.core as mx
        return {"memoryBytes": mx.get_active_memory(),
                "peakMemoryBytes": mx.get_peak_memory()}
