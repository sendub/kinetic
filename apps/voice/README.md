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
  WAV writer. `engine_mlx.py` is Chatterbox multilingual v3 on MLX; the
  Windows backend will add `engine_torch.py` beside it.
- `kinetic_voice/streaming.py`: when a streamed line is cut into chunks
  and how the chunks join (engine-side; it uses numpy).
- `lock-macos-arm64.json`: everything the Mac install fetches, pinned.
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
| `--engine NAME` | `chatterbox-mlx` (the Mac lock's default) or `fake`. |
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
log; one with `"message": "speaking", "target": <id>` marks a line
starting on the engine.

| Op | Request fields | Answer fields |
| --- | --- | --- |
| `status` | | `installed`, `lock`, `downloadBytes` (the whole install), `remainingBytes` (what an install would still fetch), `installedBytes` (helper-owned files on disk), `engine`, `warm`, `installing`; `memoryBytes` and `peakMemoryBytes` once the MLX engine is loaded |
| `install` | | `alreadyInstalled`, `seconds` |
| `cancel` | `target`: a request id | `cancelled`; `state` (`queued`, `running`, `done`, `unknown`) when it was not cancelled |
| `remove` | | |
| `warm` | | `loadSeconds` (0 when already loaded) |
| `voice` | `voice`: the reference clip's bytes in base64; `format`: `wav`, `flac` or `mp3`; `text`: its transcript (optional, unused by Chatterbox) | `voiceId`: the clip's sha256 |
| `speak` | `voiceId`, `text`, `priority` (integer, default 0), `lang` (default `en`), `stream` (default `false`) | `wav`: base64 WAV, 24 kHz 16-bit mono; `seconds`; `genSeconds` (0 for a cached line); `cached`; `firstSeconds` (a streamed line that was generated: seconds to its first chunk) |
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
