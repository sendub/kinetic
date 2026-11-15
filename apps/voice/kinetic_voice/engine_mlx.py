"""Chatterbox multilingual v3 on MLX (Apple silicon), through mlx-audio.

The model loads from the voice folder's ``models/``, a Hugging Face hub
cache that the helper filled itself; ``__main__`` has put the hub
offline, so mlx-audio's own lookup of the speech tokenizer
(``mlx-community/S3TokenizerV2``, by repo id) resolves to that folder
and never reaches the network. The speed-ups (docs/plan.md, Phase 52):
the text-to-token transformer quantized to 8 bits at load, and each
voice's conditionals computed once.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from .engine import Engine
from .install import model_dir


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
        model = self.model
        conds = model.prepare_conditionals(  # type: ignore[union-attr]
            str(reference), model.sample_rate,  # type: ignore[union-attr]
            self.settings["exaggeration"])
        if not self._warmed:
            # The first generation compiles Metal kernels: do it now, so
            # the reader's first line is as quick as the rest.
            self._generate(conds, "Ready.", "en", 0)
            self._warmed = True
        return conds

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        import zlib
        audio, rate = self._generate(voice, text, lang,
                                     zlib.crc32(text.encode()))
        import numpy as np
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        return pcm, rate

    def _generate(self, conds: object, text: str, lang: str,
                  seed: int) -> tuple[object, int]:
        import mlx.core as mx
        import numpy as np
        mx.random.seed(seed)
        results = list(self.model.generate(  # type: ignore[union-attr]
            text=text, conds=conds, lang_code=lang,
            cfg_weight=self.settings["cfgWeight"],
            exaggeration=self.settings["exaggeration"], verbose=False))
        # The audio comes back unevaluated: evaluating it runs the speech
        # decoder (flow matching and vocoder), most of a line's time.
        mx.eval([r.audio for r in results])
        audio = np.concatenate([np.array(r.audio).reshape(-1)
                                for r in results]).astype(np.float32)
        rate = results[0].sample_rate
        mx.clear_cache()
        return audio, rate

    def stats(self) -> dict:
        if not self.loaded:
            return {}
        import mlx.core as mx
        return {"memoryBytes": mx.get_active_memory(),
                "peakMemoryBytes": mx.get_peak_memory()}
