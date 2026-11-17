# The voice helper

`kinetic_voice` is the Python program a Kinetic game app runs to install
the speech model on the reader's machine and then voice a game's lines
(docs/plan.md, Phase 52). The app embeds this folder's files, writes them
into the machine's voice folder and runs them with a private Python 3.12
(python-build-standalone). Outside the engine module the helper uses the
standard library only, so it runs before anything is installed.

## Files

- `kinetic_voice/__main__.py`: the command line; keeps every library's
  files inside the voice folder and points stdout's file descriptor at
  stderr, so stray prints cannot break the protocol.
- `kinetic_voice/server.py`: the protocol below, a reading thread, an
  install thread and one engine thread.
- `kinetic_voice/install.py`: the lock file, downloads with resume and
  sha256 checks, the offline pip step, `status` sizes and `remove`.
- `kinetic_voice/jobs.py`: the engine thread's priority queue.
- `kinetic_voice/cache.py`: the cache of generated lines and the stored
  reference clips.
- `kinetic_voice/engine.py`: the engine interface, the fake engine and the
  WAV writer. `engine_mlx.py` is Chatterbox multilingual v3 on MLX;
  `engine_torch.py` is the same model on PyTorch for Windows (CUDA only).
- `kinetic_voice/pipe.py`: reads requests from stdin without leaving a
  read pending on Windows (see "Windows" below).
- `kinetic_voice/streaming.py`: when a streamed line is cut into chunks
  and how the chunks join (engine-side; it uses numpy).
- `lock-macos-arm64.json`, `lock-windows-x64.json`: everything each
  install fetches, pinned.
- `tests/`: `.venv/bin/pytest apps/voice/tests -q`.

## Running it

The app writes `kinetic_voice/` and the lock into `<voice>/helper/`, as
they sit here, and starts:

```text
<voice>/python/bin/python3 -I -B <voice>/helper/kinetic_voice/__main__.py --root <voice>
```

`-I` keeps the reader's `PYTHON*` variables and user site-packages out.
`python -m kinetic_voice` with `helper/` on `sys.path` works too.

| Option | Meaning |
| --- | --- |
| `--root DIR` | The voice folder (required). |
| `--lock FILE` | The lock file. Default: `lock-<platform>.json` beside the package, so `helper/lock-macos-arm64.json`. |
| `--engine NAME` | `chatterbox-mlx` (the Mac lock's default), `chatterbox-torch` (the Windows lock's) or `fake`. |
| `--fake-delay S` | Seconds the fake engine spends on each line. |

The fake engine needs no install: a voice is a tone whose pitch comes from
the reference clip's hash, and a line lasts 0.2 s plus 0.05 s a character.
A streamed line comes in 0.5 s chunks, `--fake-delay` spread over them.
The apps' driver tests run the helper with it.

The helper writes only protocol lines to stdout. Its stderr carries pip's
output, library messages and tracebacks; the app should keep it in a log.
It exits when it reads `quit` or the end of its input.

## The voice folder

| Path | Owner | What |
| --- | --- | --- |
| `python/` | app | The private Python, unpacked by the app. |
| `helper/` | app | This package and the lock, written by the app. |
| `lib/` | helper | The pinned wheels, installed by `pip --target`. |
| `models/` | helper | The model files, laid out as a Hugging Face hub cache: `models--<org>--<name>/snapshots/<revision>/<file>` and `refs/main`. |
| `downloads/` | helper | Wheels while they download and install; deleted after. |
| `cache/lines/` | helper | Generated lines, `<key[:2]>/<key>.wav` and `.json`. |
| `cache/voices/` | helper | Each registered reference clip, `<voiceId>.<format>`. |
| `cache/tmp/`, `cache/hf/` | helper | The engine's temporary files and the hub's home. |
| `state.json` | helper | What is installed: lock id, engine, Python version, wheels, model files, time. |

`remove` deletes every helper-owned path and leaves `python/` and
`helper/` to the app. While the helper runs, the Hugging Face hub is
offline (`HF_HUB_OFFLINE=1`) with its cache at `models/` and its home in
`cache/hf/`, so nothing reaches `~/.cache/huggingface`. pip runs with no
cache, no index and its temporary files in `downloads/tmp/`.

## The lock

```json
{
  "id": "macos-arm64-1",
  "python": {"version", "release", "url", "sha256", "size"},
  "wheels": [{"name", "url", "sha256", "size", "minMacos"?}],
  "cudaMinDriver"?: "570.65",
  "modelBaseUrl": "https://huggingface.co",
  "model": [{"repo", "revision", "path", "sha256", "size"}],
  "engine": {"id": "chatterbox-mlx", "repo", "quantizeBits",
             "quantizeGroupSize", "cfgWeight", "exaggeration",
             "temperature", "minP", "repetitionPenalty", "maxTokens",
             "flowSteps", "promptSeconds",
             "stream": {"firstSeconds", "chunkSeconds", "growth",
                        "limitSeconds", "contextSeconds"}}
}
```

- `python` is for the app, which downloads and unpacks it before it can
  start the helper. The helper ignores it.
- A package with builds per macOS version (`mlx`, `mlx-metal`) lists each
  with its `minMacos`; the install takes the newest one the system meets.
  On macOS older than 14 `status` and `install` fail with
  `unsupported-system`.
- `cudaMinDriver` (the Windows lock) is the oldest NVIDIA driver its CUDA
  build of PyTorch runs on. The helper does not read it: the Windows exe
  checks the card and the driver before it offers the install
  (apps/README.md, "Spoken lines"), and the install refuses with
  `unsupported` on a PC with no NVIDIA card or an older driver. The lock
  has one build of each package; there is no CPU variant (it ran about
  1.6 times real time, too slow).
- The wheel's file name is the last part of its URL.
- Model files download from `<modelBaseUrl>/<repo>/resolve/<revision>/<path>`.
- A new `id` means a new install: `status` reports `installed: false`
  until `install` has run for it. A change to `engine` alone keeps the
  `id`: the files are the same, and the line cache's keys include the
  engine settings, so lines made with the old settings are not served.

### The engine settings

The MLX engine reads them all from the lock, and every one is part of the
line cache's key.

| Setting | Value | Meaning |
| --- | --- | --- |
| `repo` | `mlx-community/chatterbox-multilingual-v3` | The model. |
| `quantizeBits`, `quantizeGroupSize` | 8, 64 | The text-to-token transformer (T3) quantized at load. |
| `cfgWeight`, `exaggeration` | 0.5, 0.5 | Chatterbox's guidance and emotion settings. |
| `temperature`, `minP`, `repetitionPenalty`, `maxTokens` | 0.8, 0.05, 1.2, 1000 | T3's sampling, mlx-audio's defaults; 1000 tokens is 40 s. |
| `flowSteps` | 5 | The decoder's flow-matching steps (mlx-audio: 10). |
| `promptSeconds` | 6 | How much of the reference clip the decoder works over with each line (mlx-audio: 10). |
| `stream` | 2.5, 2.5, 1.2, 8, 2 | Streamed lines (below): the first chunk after `firstSeconds` of speech, the next after `chunkSeconds`, each later one `growth` times the one before, at most `limitSeconds`; each decoded with `contextSeconds` of the line before it. |

Phase 52 item 2b chose `flowSteps` and `promptSeconds` by measurement
(`.tmp/voice-speed/RESULTS.md` on the machine that ran it): the decoder
runs over the voice's prompt and the line together at every step, so
fewer steps and a shorter prompt cut its work most, and the speaker match
stayed within 0.02 of the old settings. The engine also runs T3's loop
pipelined (the next step queued on the GPU before the current token is
read back), with the same tokens as mlx-audio's loop for the same random
draws. T3 draws from a key made from the line's text, so a line's tokens
are the same streamed or not. On an M2 a line takes 0.53-0.56 of its
length after warm-up (item 2 measured 1.03-1.11).

The Mac lock fetches 3.29 GB on macOS 14 and 15 and 3.32 GB on macOS 26
or later: the model 2.71 GB, its speech tokenizer 0.49 GB, the wheels
80 to 113 MB. The Python build adds 25 MB, fetched by the app.

## The Windows engine

`lock-windows-x64.json` runs `chatterbox-torch`: Resemble AI's own
`chatterbox-tts` 0.1.7 (MIT) models on PyTorch 2.8.0, on CUDA; if
`torch.cuda.is_available()` is false the engine refuses to load.
The package's `ChatterboxMultilingualTTS` is not used: it loads the v2
weights, recomputes the voice on every line, runs T3 with attention
outputs and an alignment analyser, and applies Resemble's Perth
watermark. The engine builds the package's `T3`, `S3Gen`, `VoiceEncoder`
and `MTLTokenizer` itself (importing `chatterbox.models` through a stub
parent, so the package's `__init__` and with it Perth never load), loads
the v3 weights from the `ResembleAI/chatterbox` snapshot in `models/`
(`t3_mtl23ls_v3.safetensors`, `s3gen_v3.safetensors`, `ve.safetensors`,
the tokenizer's vocabulary and `Cangjie5_TC.json`; revision pinned, 3.21
GB) and runs the Mac engine's pipeline with the same `engine` settings
(cfg 0.5, exaggeration 0.5, the same sampling constants, 5 flow steps, a
6 s decoder prompt, the same streaming chunks and joins): voices prepared
once, a KV-cache T3 loop with the repetition penalty, min-p and
temperature of the Mac loop and a generator seeded from the line's text,
and a copy of the package's flow decoder step with its pad mask taken
after the lookahead cut (the package's own fails on an unfinished
chunk). T3 is not quantized on either device: PyTorch's dynamic int8
quantization halved T3's time per token on the CPU (23 ms against 47 for
float32, and 36 for bfloat16) but broke lines (below).

What differs from the Mac engine: no Perth watermark (the Mac engine has
none either); T3 has no alignment analyser (nor has mlx-audio's); the
optional per-language text helpers (`pykakasi`, `spacy-pkuseg`,
`dicta-onnx`, `russian-text-stresser`) are not in the lock, so Japanese,
Chinese segmentation, Hebrew diacritics and Russian stress marks are
skipped (the package skips them itself when they are missing); CUDA runs
float32, with no pipelined loop (the GPU waits on one `item()` per
token).

The lock's 61 wheels are the imports of load, prepare_voice, speak and
speak_stream, found by running them with the package's full dependency
set (83 distributions) and listing which were imported, then installing
only those with `--no-deps` and running again: `torch` and `torchaudio`
(CUDA 12.8 builds from `download.pytorch.org/whl/cu128`; the 5090 needs
12.8), `numpy` 1.26 (the package pins below
2), `librosa` with `numba`, `llvmlite`, `scipy`, `scikit-learn`, `soxr`,
`soundfile`, `audioread`, `pooch`, `joblib`, `lazy-loader`, `decorator`,
`msgpack`, `transformers` 5.2 with `huggingface-hub`, `tokenizers`,
`safetensors`, `regex`, `pyyaml` and `httpx`, `diffusers` 0.29 (three
attention classes), `s3tokenizer` with `onnx` (`ml-dtypes`, `protobuf`),
`conformer`, `einops`, `omegaconf`, `sympy` with `mpmath` and `jinja2`
(PyTorch's own imports), and `rich`, `click`, `cloudpickle`, `pillow`.
Left out of the package's list: `gradio`, `resemble-perth` (and its
`pandas`, `pkg_resources`), `pyloudnorm`, `pykakasi`, `spacy-pkuseg`,
`networkx`, `fsspec`, `hf-xet`, `typer`, `pydantic`.

Download, on the 5090 PC: 6.83 GB (the wheels 3.62 GB, of which PyTorch
3.46 GB, and the model 3.21 GB); the Python build adds 47 MB, fetched by
the app. (A CPU build was measured and dropped, below.)
The CUDA install took 181 s there and holds 11.35 GB on disk.

Two Windows facts the helper is built around, both found on a real
install: a child process that inherits the helper's stdin pipe hangs at
startup (pip, so `run_pip` gives it no stdin), and a thread blocked
reading that pipe makes the first `import numpy` on another thread hang,
which is why `pipe.py` polls stdin with `PeekNamedPipe` on Windows.

Speeds and scores: see "Measured on Windows" below.

## Measured on Windows

A Ryzen 7 9800X3D (8 cores) with an RTX 5090 (driver 617.42), native
Windows, helper started as the app starts it (`python.exe -I -B`),
reference clip `fixtures/voices/helen.flac`, three synthetic lines of 3.6
to 5.6 s. The PC was also rendering in Blender at times, which slows every
number below by up to 2x (CUDA runs are launch-bound);
ranges are the quiet-machine best to the loaded worst.

| | CUDA (5090) | CPU (float32; measured, then dropped) |
| --- | --- | --- |
| Install (real downloads) | 6.83 GB, 181 s, 11.35 GB on disk | 3.98 GB, 137 s, 7.10 GB on disk |
| `warm` (engine load) | 10-12 s | 15 s |
| `voice` (prepare + warm-up line) | 20-30 s | 20 s |
| Whole line, seconds of work per second of audio | 0.32-0.34 quiet, 0.6-0.8 loaded | about 1.6 (stages timed) |
| Streamed line, same | 0.39-0.42 quiet, up to 1.0 loaded | about 2 (estimated) |
| Streamed line's first chunk | 0.94-0.97 s quiet, 1.4-2.7 s loaded | about 5 s (estimated) |
| GPU memory | 3.3 GB held, 3.4 GB peak | |

The CPU row's speed is from the stages timed apart on the CPU (T3 47 ms a
token, so 1.9 s per second of speech... not quite: 135 tokens are 5.4 s of
speech and took 6.8 s; the flow 2.1 s; the vocoder 0.2 s), and the
CPU-variant install's own run with T3 quantized (1.0-1.1x whole, 1.5-1.7x
streamed, first chunk 3.2 s). Float32 on the CPU is therefore too slow to
keep ahead of a reader, and even the int8 numbers only just are. The
Windows app therefore offers spoken lines only with an NVIDIA card, and
the lock and the engine have no CPU path.

Quality, scored with Whisper large-v3-turbo as for the Mac models
(`.tmp/voice-models/scripts/score.py`): on CUDA all six lines (whole and
streamed) came back with word error 0, and the pause before "You" in "Not
someone. You." was 0.56 s whole and 0.54 s streamed. On the CPU in float32
the same three lines scored 0, 0 and 0, with a pause of 0.58 s; with T3
dynamically quantized to int8 they scored 0, 0 and 0.61 (a garbled line)
with a pause of 0.15 s, so the engine does not quantize.

## The protocol

One JSON object a line each way. A request is
`{"id": <number or string>, "op": "<op>", ...}`. Its answer carries the
same `id`:

```json
{"id": 4, "ok": true, ...}
{"id": 4, "ok": false, "error": "<message for a log>", "code": "<code>"}
```

Answers can come in any order: the helper answers `status` and `cancel`
at once while an install or a line is running. Events have no `id`:

```json
{"event": "progress", "phase": "packages", "done": 104857600, "total": 3320765822, "file": "mlx_metal-0.32.4-py3-none-macosx_26_0_arm64.whl"}
{"event": "log", "message": "engine loaded", "seconds": 5.1}
```

`done` and `total` count the whole install, packages and model together,
on the same scale as `status`'s `downloadBytes`. Progress comes at most
four times a second, and after every file. Log events are for the app's
log; one with `"message": "speaking", "target": <id>, "lang": <lang>`
marks a line starting on the engine.

| Op | Request fields | Answer fields |
| --- | --- | --- |
| `status` | | `installed`, `lock`, `downloadBytes` (the whole install), `remainingBytes` (what an install would still fetch), `installedBytes` (helper-owned files on disk), `engine`, `warm`, `installing`; `memoryBytes` and `peakMemoryBytes` once an engine that reports them is loaded; the PyTorch engine adds `device` (`cuda`) and `gpu` |
| `install` | | `alreadyInstalled`, `seconds` |
| `cancel` | `target`: a request id | `cancelled`; `state` (`queued`, `running`, `done`, `unknown`) when it was not cancelled |
| `remove` | | |
| `warm` | | `loadSeconds` (0 when already loaded) |
| `voice` | `voice`: the reference clip's bytes in base64; `format`: `wav`, `flac` or `mp3`; `text`: its transcript (optional, unused by Chatterbox) | `voiceId`: the clip's sha256 |
| `speak` | `voiceId`, `text`, `priority` (integer, default 0), `lang` (default `en`; one of the engine's languages below), `stream` (default `false`) | `wav`: base64 WAV, 24 kHz 16-bit mono; `seconds`; `genSeconds` (0 for a cached line); `cached`; `firstSeconds` (a streamed line that was generated: seconds to its first chunk) |
| `quit` | | (then the helper exits with status 0) |

- **install** runs the lock's steps with progress events: download the
  wheels, check each sha256, install them with
  `pip install --target lib --no-deps --require-hashes --only-binary :all: --no-index`
  from those files, then download the model files, checking each size and
  sha256, and write `state.json`. A run after an interruption continues a
  partial model file with a Range request; finished files are not fetched
  again, and a run with everything installed answers
  `alreadyInstalled: true` without touching the network. `cancel` with the
  install's id stops it; it then answers `cancelled` and partial files
  stay for the next run.
- **voice** stores the clip in `cache/voices/`, loads the engine if needed
  and computes the voice's conditionals once. The first voice after a
  load also runs one short line, so the Metal kernels are compiled before
  the reader's first line. A `speak` naming a voice registered in an
  earlier run works: the helper prepares it from the stored clip.
- **speak** takes `lang`, the engine's language for the text, one of
  Chatterbox multilingual's 23: `ar da de el en es fi fr he hi it ja ko ms
  nl no pl pt ru sv sw tr zh` (`engine.py` `LANGUAGES`; the player keeps
  the same list in player/src/render/linevoice.ts and maps a BCP 47 tag to
  it by its primary subtag, `nb` and `nn` to `no`, as `engine_language`
  does). Another value is a `bad-request`. The fake engine raises its
  tone a little for each language but English, so a test hears which one
  a line was made in.
- **speak** answers at once from the cache when the line is there. The
  cache key is the sha256 of the engine id, the model revisions, the
  engine settings, the voiceId, the language and the text. Otherwise the
  line joins the queue: control jobs (`warm`, `voice`, `remove`) first,
  then lines by `priority`, highest first, in arrival order within a
  priority. `cancel` drops a queued line, whose own answer is then
  `cancelled`; a line already running finishes and is cached.
- **speak with `stream: true`** sends the line in chunks as they are
  ready, then the normal answer with the whole line:

  ```json
  {"event": "chunk", "target": 7, "index": 0, "wav": "<base64 WAV>", "seconds": 0.84, "final": false}
  {"event": "chunk", "target": 7, "index": 1, "wav": "<base64 WAV>", "seconds": 2.0, "final": false}
  {"event": "chunk", "target": 7, "index": 2, "wav": "<base64 WAV>", "seconds": 1.32, "final": true}
  {"id": 7, "ok": true, "wav": "<base64 WAV>", "seconds": 4.16, "genSeconds": 2.3, "cached": false, "firstSeconds": 0.9}
  ```

  `index` counts from 0, `final` marks the last chunk, and the chunks
  played back to back are the whole line: the answer's `wav` is their
  samples joined, and that is what the cache keeps. A line already in
  the cache, and a queued line that is cancelled, get the answer alone
  with no chunk events, so a page must play either: the chunks as they
  come, or the answer's `wav` when no chunk came first. If the engine
  fails partway, the chunks already sent are followed by an
  `engine-failed` answer. A non-streamed `speak` never sends chunks.

  The joins have no seam. Each chunk is decoded from the voice's prompt
  and the tokens from `contextSeconds` before the last cut (the flow
  keeps the mel frames from the cut on, and the decoder looks 3 tokens
  past each cut). A chunk's last 160 ms are not sent, because the vocoder
  rendered them with nothing after them; the next chunk renders them
  again from the same mel frames and source signal, with 320 ms of past
  before them, and the 160 ms before those are sent crossfaded between
  the two renderings with complementary raised-cosine fades
  (`streaming.py`). On the bench the two renderings of a crossfade
  differ by 0.4% RMS (median), so a join cannot be heard. A streamed
  line's samples differ slightly from the same line made whole (the same
  tokens, decoded in parts); whichever is made first is cached and served
  to both.

  A streamed line costs more: every chunk decodes the voice's prompt
  again, so a 6 s line takes about 1.6 times as long in all (0.8-0.9 of
  its length on an M2), with its first chunk after about 1.7 s instead of
  the whole line after about 3 s, and no gap between chunks. Stream the
  line the reader is waiting for, not the ones fetched ahead.
- **remove** waits for a running line, unloads the engine and deletes the
  helper-owned files. It answers `busy` while an install runs.

Error codes:

| Code | When |
| --- | --- |
| `bad-request` | Not JSON, no `op`, or a field of the wrong kind (empty text, an unsupported format, bad base64). The answer's `id` is `null` when the line had none. |
| `unknown-op` | An `op` the helper does not know. |
| `busy` | `install` while an install or remove runs, or `remove` while an install runs. |
| `cancelled` | The answer to a cancelled `install` or `speak`. |
| `hash-mismatch` | A download's sha256 differs from the lock. The file is deleted, so a re-run fetches it again. |
| `download-failed` | A network error, an HTTP error or a short download. A partial file is kept for the next run. |
| `pip-failed` | pip refused the wheels; its last lines are in `error`, all of it on stderr. |
| `unsupported-system` | The system is older than every build of a package needs. |
| `not-installed` | `warm`, `voice` or `speak` before the install (not with the fake engine). |
| `unknown-voice` | `speak` with a voiceId never registered on this machine. |
| `engine-failed` | The engine raised: a traceback is on stderr. |
| `install-failed` | Anything else that went wrong in the install. |
