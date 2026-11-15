"""Chatterbox multilingual v3 on PyTorch (Windows), from Resemble AI's own
``chatterbox-tts`` package (MIT), on CUDA when an NVIDIA GPU is usable and
otherwise on the CPU.

The package's ``ChatterboxMultilingualTTS`` is not used: it loads the v2
checkpoint, re-reads the reference clip on every line, runs T3 with
attention outputs and an alignment analyser (eager attention, a Python
step loop), and applies Resemble's Perth watermark. The engine builds the
package's own model classes (``T3``, ``S3Gen``, ``VoiceEncoder``,
``MTLTokenizer``), loads the v3 weights from the voice folder's ``models/``
(a Hugging Face hub cache the helper filled; nothing reaches the hub) and
runs the same pipeline as the Mac engine (``engine_mlx.py``), with the same
settings from the lock's ``engine`` object:

- each voice's conditionals are computed once, with the decoder's
  reference prompt cut to ``promptSeconds``;
- ``flowSteps`` flow-matching steps (the package: 10);
- T3 runs the package's loop, without the alignment analyser (the Mac
  engine has none either), as a plain KV-cache loop that samples as the
  Mac engine does (repetition penalty, then min-p on the untempered
  distribution, then temperature), from a random generator seeded from
  the line's text, so a line's tokens are the same streamed or not;
- T3 is not quantized (the Mac engine quantizes it to 8 bits): PyTorch's
  dynamic int8 quantization on the CPU halved T3's time per token but
  broke lines (Whisper word error 0.61 on one, the pause before a
  stressed word lost), where float32 matched CUDA;
- ``speak_stream`` cuts the line into chunks (``streaming.py``) decoded
  from the voice's prompt and the tokens before each cut, with the same
  re-rendered, crossfaded joins as the Mac engine.

The Perth watermarker is not applied: the Mac engine makes no watermark
either, and the helper needs none of the package's other callers. Its
other dependencies are optional in the package and left out of the lock
(``pykakasi`` for Japanese, ``spacy-pkuseg`` for Chinese word
segmentation, ``dicta-onnx`` for Hebrew, ``russian-text-stresser``):
those languages' text is tokenized without their preprocessing.
"""

from __future__ import annotations

import gc
import os
import sys
import tempfile
import types
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .engine import Engine
from .install import model_dir
from .streaming import ChunkPlan, Joiner

SPEECH_VOCAB = 6561  # S3 speech tokens; above are start/stop markers
S3_SR = 16000
S3GEN_SR = 24000
# Streamed joins, as in engine_mlx.py.
MARGIN = 8
CROSSFADE = 8
CONTEXT = 16
HOP = 480


def resolve_device(override: str, cuda_available: bool) -> str:
    """``"cuda"`` or ``"cpu"``. ``override`` is ``KINETIC_VOICE_DEVICE``:
    empty or ``auto`` picks CUDA when it is usable."""
    choice = (override or "auto").lower()
    if choice == "auto":
        return "cuda" if cuda_available else "cpu"
    if choice == "cpu":
        return "cpu"
    if choice == "cuda":
        if not cuda_available:
            raise RuntimeError("KINETIC_VOICE_DEVICE=cuda but CUDA is not "
                               "usable on this machine")
        return "cuda"
    raise ValueError(f"KINETIC_VOICE_DEVICE={override!r}: expected auto, "
                     "cuda or cpu (not a gpu name)")


_PUNCTUATION = [
    ("...", ", "), ("…", ", "), (":", ","), (" - ", ", "), (";", ", "),
    ("—", "-"), ("–", "-"), (" ,", ","), ("“", '"'), ("”", '"'),
    ("‘", "'"), ("’", "'"),
]
_ENDERS = (".", "!", "?", "-", ",", "、", "，", "。", "？", "！")


def punc_norm(text: str) -> str:
    """Chatterbox's own punctuation cleanup (``chatterbox.mtl_tts``, MIT;
    copied because that module also imports the watermarker)."""
    if len(text) == 0:
        return "You need to add some text for me to talk."
    if text[0].islower():
        text = text[0].upper() + text[1:]
    text = " ".join(text.split())
    for old, new in _PUNCTUATION:
        text = text.replace(old, new)
    text = text.rstrip(" ")
    if not text.endswith(_ENDERS):
        text += "."
    return text


@dataclass
class TorchVoice:
    """A voice: T3's conditioning and S3Gen's reference dictionary."""

    t3: object
    gen: dict


class ChatterboxTorch(Engine):
    name = "chatterbox-torch"

    def __init__(self, root: Path, lock: dict) -> None:
        super().__init__(root, lock)
        self.settings = lock["engine"]
        self.revisions = {m["repo"]: m["revision"]
                          for m in lock.get("model", [])}
        self.device = "cpu"
        self.t3 = None
        self.s3gen = None
        self.ve = None
        self.tokenizer = None
        self._warmed = False

    def identity(self) -> dict:
        return {"engine": self.name, "model": self.revisions,
                "settings": self.settings,
                "device": os.environ.get("KINETIC_VOICE_DEVICE", "")
                .lower() or "auto"}

    # Loading

    def load(self) -> None:
        lib = str(self.root / "lib")
        if lib not in sys.path:
            sys.path.insert(0, lib)
        tmp = self.root / "cache" / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        tempfile.tempdir = str(tmp)
        try:
            import torch
        except ImportError as err:
            raise RuntimeError(
                "PyTorch is not installed in the voice folder (run the "
                f"install first): {err}") from None
        self.device = resolve_device(
            os.environ.get("KINETIC_VOICE_DEVICE", ""),
            torch.cuda.is_available())
        self._chatterbox_models()
        from chatterbox.models.s3gen import S3Gen
        from chatterbox.models.t3 import T3
        from chatterbox.models.t3.modules.t3_config import T3Config
        from chatterbox.models.tokenizers import MTLTokenizer
        from chatterbox.models.voice_encoder import VoiceEncoder
        from safetensors.torch import load_file

        repo = self.settings["repo"]
        snapshot = (model_dir(self.root, repo) / "snapshots"
                    / self.revisions[repo])
        files = self.settings["files"]

        def weights(key: str) -> dict:
            return load_file(str(snapshot / files[key]))

        with torch.inference_mode():
            ve = VoiceEncoder()
            ve.load_state_dict(weights("ve"))
            t3 = T3(T3Config.multilingual())
            state = weights("t3")
            if "model" in state:  # the package's own handling
                state = state["model"][0]
            t3.load_state_dict(state)
            s3gen = S3Gen()
            # The safetensors file leaves out two buffers the constructor
            # computes (the checkpoint ``.pt`` has them).
            missing, unexpected = s3gen.load_state_dict(
                weights("s3gen"), strict=False)
            if unexpected or set(missing) - set(S3Gen.ignore_state_dict_missing):
                raise RuntimeError(
                    f"s3gen weights do not fit: missing {missing}, "
                    f"unexpected {unexpected}")
            for model in (ve, t3, s3gen):
                model.to(self.device).eval()
        self.tokenizer = MTLTokenizer(str(snapshot / files["tokenizer"]))
        self.t3, self.s3gen, self.ve = t3, s3gen, ve
        self._warmed = False
        self.loaded = True

    @staticmethod
    def _chatterbox_models() -> None:
        """Make ``chatterbox.models`` importable without running the
        package's ``__init__``, which imports every Chatterbox model and
        Resemble's watermarker."""
        if "chatterbox" in sys.modules:
            return
        import importlib.util
        spec = importlib.util.find_spec("chatterbox")
        if spec is None or not spec.submodule_search_locations:
            raise RuntimeError("the chatterbox-tts package is not installed")
        stub = types.ModuleType("chatterbox")
        stub.__path__ = list(spec.submodule_search_locations)
        sys.modules["chatterbox"] = stub

    def unload(self) -> None:
        self.t3 = self.s3gen = self.ve = self.tokenizer = None
        self.loaded = False
        gc.collect()
        try:
            import torch
        except ImportError:
            return
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    # Voices

    def prepare_voice(self, reference: Path) -> object:
        import librosa
        import torch
        from chatterbox.models.t3.modules.cond_enc import T3Cond
        t3, s3gen = self.t3, self.s3gen
        with torch.inference_mode():
            wav, _ = librosa.load(str(reference), sr=S3GEN_SR)
            ref16 = librosa.resample(wav, orig_sr=S3GEN_SR, target_sr=S3_SR)
            gen = s3gen.embed_ref(wav[:10 * S3GEN_SR], S3GEN_SR,
                                  device=self.device)
            # The decoder's prompt: its first promptSeconds (50 mel frames
            # and 25 tokens a second).
            tokens = int(self.settings["promptSeconds"] * 25)
            gen["prompt_token"] = gen["prompt_token"][:, :tokens]
            gen["prompt_token_len"] = torch.tensor(
                [gen["prompt_token"].shape[1]], device=self.device)
            gen["prompt_feat"] = gen["prompt_feat"][:, :2 * tokens]
            plen = t3.hp.speech_cond_prompt_len
            prompt, _ = s3gen.tokenizer.forward([ref16[:6 * S3_SR]],
                                                max_len=plen)
            prompt = torch.atleast_2d(prompt).to(self.device)
            embed = torch.from_numpy(
                self.ve.embeds_from_wavs([ref16], sample_rate=S3_SR))
            embed = embed.mean(axis=0, keepdim=True).to(self.device)
            cond = T3Cond(
                speaker_emb=embed, cond_prompt_speech_tokens=prompt,
                emotion_adv=self.settings["exaggeration"]
                * torch.ones(1, 1, 1)).to(device=self.device)
            t3.prepare_conditioning(cond)  # caches the prompt's embedding
        voice = TorchVoice(cond, gen)
        if not self._warmed:
            # The first generation pays for the GPU's kernel selection and
            # the CPU's first-use costs: do it now, so the reader's first
            # line is as quick as the rest. Streaming too.
            self.speak(voice, "Ready.", "en")
            for _ in self.speak_stream(voice, "Ready, and steady.", "en"):
                pass
            self._warmed = True
        return voice

    # Lines

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        import torch
        seed = zlib.crc32(text.encode())
        with torch.inference_mode():
            tokens = list(self._tokens(voice, text, lang, seed))
            if not tokens:
                return b"\0\0" * (S3GEN_SR // 5), S3GEN_SR
            torch.manual_seed(seed)  # the decoder's and vocoder's noise
            mel = self._flow(voice, tokens, True)
            wav, _ = self.s3gen.hift_inference(mel, None)
            trim = self.s3gen.trim_fade
            wav[:, :len(trim)] *= trim
            pcm = self._pcm(wav)
        self._free()
        return pcm, S3GEN_SR

    def speak_stream(self, voice: object, text: str,
                     lang: str) -> Iterator[tuple[bytes, int, bool]]:
        """The line in chunks (streaming.py), as engine_mlx does it."""
        import numpy as np
        import torch
        s3gen = self.s3gen
        opts = self.settings["stream"]
        plan = ChunkPlan(opts["firstSeconds"], opts["chunkSeconds"],
                         opts["growth"], opts["limitSeconds"])
        joiner = Joiner(CROSSFADE * HOP)
        context = round(opts["contextSeconds"] * 25)
        seed = zlib.crc32(text.encode())
        tokens: list[int] = []
        state: dict = {"offset": 0, "cache": None, "first": True}

        def chunk(final: bool) -> bytes:
            torch.manual_seed(seed + len(tokens))
            start = max(0, state["offset"] - context)
            mel = self._flow(voice, tokens[start:], final)
            mel = mel[:, :, (state["offset"] - start) * 2:]
            state["offset"] = len(tokens) if final else plan.cut(len(tokens))
            drop = 0
            if state["cache"] is not None:
                drop = state["cache"][0].shape[2] - CROSSFADE - MARGIN
                mel = torch.cat([state["cache"][0], mel], dim=2)
                source = state["cache"][1]
            else:
                source = torch.zeros(1, 1, 0, device=self.device)
            wav, source = s3gen.hift_inference(mel, source)
            if not final:
                keep = min(CONTEXT + CROSSFADE + MARGIN, mel.shape[2])
                state["cache"] = (mel[:, :, -keep:],
                                  source[:, :, -keep * HOP:])
            wav = wav.reshape(-1).float().cpu().numpy()[drop * HOP:]
            if not final:
                wav = wav[:len(wav) - MARGIN * HOP]
            if state["first"]:
                fade = s3gen.trim_fade.cpu().numpy()
                n = min(len(fade), len(wav))
                wav = wav.copy()
                wav[:n] *= fade[:n]
                state["first"] = False
            out = joiner.push(wav, final)
            return (np.clip(out, -1.0, 1.0) * 32767).astype("<i2").tobytes()

        with torch.inference_mode():
            for token in self._tokens(voice, text, lang, seed):
                tokens.append(token)
                if plan.due(len(tokens)):
                    yield chunk(False), S3GEN_SR, False
            yield chunk(True), S3GEN_SR, True
        self._free()

    def _flow(self, voice: TorchVoice, tokens: list[int], final: bool):
        """The mel for ``tokens`` after the voice's prompt: the package's
        ``CausalMaskedDiffWithXvec.inference`` for one sequence, with the
        pad mask taken after the lookahead is cut (the package's mask
        keeps the cut frames, so an unfinished chunk fails there)."""
        import torch
        import torch.nn.functional as F
        from chatterbox.models.s3gen.utils.mask import make_pad_mask
        flow, gen = self.s3gen.flow, voice.gen
        with torch.inference_mode():
            token = torch.tensor([tokens], dtype=torch.long,
                                 device=self.device)
            embedding = flow.spk_embed_affine_layer(
                F.normalize(torch.atleast_2d(gen["embedding"]), dim=1))
            prompt_feat = gen["prompt_feat"]
            token = torch.cat([gen["prompt_token"].long(), token], dim=1)
            length = torch.tensor([token.shape[1]], device=self.device)
            mask = (~make_pad_mask(length)).unsqueeze(-1).to(embedding)
            h, _ = flow.encoder(flow.input_embedding(token) * mask, length)
            if not final:
                h = h[:, :-flow.pre_lookahead_len * flow.token_mel_ratio]
            prompt_frames = prompt_feat.shape[1]
            h = flow.encoder_proj(h)
            conds = torch.zeros([1, h.shape[1], flow.output_size],
                                device=self.device).to(h.dtype)
            conds[:, :prompt_frames] = prompt_feat
            feat, _ = flow.decoder(
                mu=h.transpose(1, 2).contiguous(),
                mask=torch.ones(1, 1, h.shape[1]).to(h), spks=embedding,
                cond=conds.transpose(1, 2),
                n_timesteps=self.settings["flowSteps"], noised_mels=None,
                meanflow=False)
            return feat[:, :, prompt_frames:]

    def _free(self) -> None:
        if self.device == "cuda":
            import torch
            torch.cuda.empty_cache()

    @staticmethod
    def _pcm(wav: object) -> bytes:
        import numpy as np
        audio = wav.reshape(-1).float().cpu().numpy()  # type: ignore[attr-defined]
        return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()

    def _tokens(self, voice: TorchVoice, text: str, lang: str,
                seed: int) -> Iterator[int]:
        """The line's speech tokens as T3 makes them: the package's
        ``T3.inference`` without its alignment analyser and attention
        outputs, the sampling of engine_mlx."""
        import torch
        import torch.nn.functional as F
        t3, s = self.t3, self.settings
        hp = t3.hp
        cfg, limit = s["cfgWeight"], s["maxTokens"]
        penalty, min_p = s["repetitionPenalty"], s["minP"]
        temperature = s["temperature"]
        ids = self.tokenizer.text_to_tokens(
            punc_norm(text), language_id=lang.lower() or None)
        ids = ids.to(self.device)
        ids = torch.cat([ids, ids], dim=0)  # two sequences for CFG
        ids = F.pad(ids, (1, 0), value=hp.start_text_token)
        ids = F.pad(ids, (0, 1), value=hp.stop_text_token)
        start = hp.start_speech_token * torch.ones_like(ids[:, :1])
        embeds, _ = t3.prepare_input_embeds(
            t3_cond=voice.t3, text_tokens=ids, speech_tokens=start,
            cfg_weight=cfg)
        # [cond | text | BOS | BOS]: CFG runs the batch twice, the second
        # without the text's conditioning.
        bos = t3.speech_emb(start[:1]) + t3.speech_pos_emb.get_fixed_embedding(0)
        out = t3.tfmr(inputs_embeds=torch.cat(
            [embeds, torch.cat([bos, bos])], dim=1), use_cache=True)
        past = out.past_key_values
        hidden = out.last_hidden_state
        generator = torch.Generator(device=self.device)
        generator.manual_seed(seed)
        seen = torch.full((1, limit + 1), hp.start_speech_token,
                          dtype=torch.long, device=self.device)
        for step in range(limit):
            logits = t3.speech_head(hidden[:, -1, :]).float()  # (2, vocab)
            cond, uncond = logits[0:1], logits[1:2]
            logits = cond + cfg * (cond - uncond)
            previous = seen[:, :step + 1]
            score = logits.gather(1, previous)
            logits = logits.scatter(
                1, previous, torch.where(score < 0, score * penalty,
                                         score / penalty))
            probs = torch.softmax(logits, dim=-1)
            keep = probs >= min_p * probs.max(dim=-1, keepdim=True).values
            logits = logits.masked_fill(~keep, float("-inf")) / temperature
            token = torch.multinomial(torch.softmax(logits, dim=-1), 1,
                                      generator=generator)
            seen[:, step + 1] = token[:, 0]
            value = int(token.item())
            if value == hp.stop_speech_token:
                return
            if value < SPEECH_VOCAB:
                yield value
            embed = (t3.speech_emb(token)
                     + t3.speech_pos_emb.get_fixed_embedding(step + 1))
            out = t3.tfmr(inputs_embeds=torch.cat([embed, embed]),
                          past_key_values=past, use_cache=True)
            past = out.past_key_values
            hidden = out.last_hidden_state

    def stats(self) -> dict:
        if not self.loaded:
            return {}
        stats: dict = {"device": self.device}
        if self.device == "cuda":
            import torch
            stats["gpu"] = torch.cuda.get_device_name()
            stats["memoryBytes"] = torch.cuda.memory_allocated()
            stats["peakMemoryBytes"] = torch.cuda.max_memory_allocated()
        return stats
