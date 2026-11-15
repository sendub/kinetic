# Voice reading

What we learned on 2026-11-15 about giving every line of a Kinetic game a
generated voice, the choices made so far and the ones still open. The
read-aloud entry in docs/future.md points here.

## Decisions so far

- The browser's built-in speech (`speechSynthesis`) is a no-go. Its voices
  depend on the reader's machine, it has no per-character design, no
  direction and no cloning, and it lost clearly in a side-by-side listen.
- Fish Audio Drama 3 is usable. Its lines cloned from a reference
  recording, read neutrally, were the best result.
- The Zonos3-Mini standard-phrase methods are acceptable, but some line
  readings are weak.
- Voice tracks are mono Opus at 16 kb/s. By ear, 12 kb/s is still usable
  and 8 kb/s is not.
- Not decided: whether authors pre-record every line with Fish, or readers
  generate lines live with Zonos. Kinetic may support both, as below.

## Two paths

### Recorded with Fish

For an author with an NVIDIA card of 32 GB or more, or who pays for Fish's
hosted API. A Kinetic utility runs the pipeline below against a Fish server
and writes ordinary voice tracks (an item's `audio.voice`,
docs/content-format.md, "Item audio"). The reader needs nothing extra.

Fish cannot make a voice from a description (Casting with Fish, below), so
each character's reference comes from one of:

- the author's own recording;
- a standard phrase designed with Zonos's sliders, which do follow gender
  and age;
- Fish candidates, with the author picking one by ear.

### Live with Zonos

For an author without that hardware. The author describes each character.
The build maps each description to a Zonos starting voice plus sliders,
renders the standard phrase and stores that take's speaker embedding: 192
numbers, under 1 KB per character, shipped in the game folder. A reader who
wants spoken lines downloads the Zonos core files once, about 1.2 GB, and
the player then speaks each line from its character's embedding on the
reader's machine. On an M2 that runs at 6-7x real time, fast enough to
voice the next line while the reader reads the current one.

The download conflicts with the rule that a game folder needs no network
access at play time (docs/content-format.md, "Folder layout"), so it has to
be a separate, opt-in install outside the folder.

## The pipeline

For the recorded path the build runs all four steps. For the live path the
build casts and the reader's machine voices, without the check.

1. **Cast.** Each character gets a reference recording, about 10 to 13
   seconds long. It is the author's own recording when there is one.
   Otherwise the build renders a standard phrase several times and the author
   picks the take that fits the character. The picked take, with its
   transcript, is the character's voice from then on.
2. **Voice.** Every line of that character is cloned from the reference,
   with the line's direction added when it has one.
3. **Check.** Speech recognition transcribes every take. A take whose word
   error rate is above 0.1 is generated again with a new seed, up to three
   times, and then reported.
4. **Ship.** Each take is trimmed, encoded as mono Opus at 16 kb/s and
   listed as a voice track.

The standard phrase used so far:

```text
Hello there. I've been waiting a long time to tell you this story, so
please, sit down and listen. Some of it is funny, some of it is sad, and
all of it is true.
```

## Engines compared

| | Browser built-in | Zonos3-Mini | Fish Drama 3 (int4) |
| --- | --- | --- | --- |
| Where it runs | the reader's browser | Apple Silicon (MLX); NVIDIA, CPU and WebGPU untested | NVIDIA with 32 GB or more |
| Download | none | 1.2 GB core, 5.6 GB more for clip cloning | 22 GB, plus a 1.9 GB codec |
| Speed measured | real time | 6-7x real time on an M2 | 5x real time on an RTX 5090 |
| Voice from a description | pick an installed voice | starting voice plus sliders (gender, age, pitch, accent, texture) | no: a description gives a random voice |
| Cloning | no | from a clip or a 192-number embedding | from a clip and its transcript |
| Direction | none | mood and emotion sliders | free text in brackets, anywhere in the line |
| License | none needed | Apache-2.0 | Fish Audio Community License |

Fish's open release needs a 48 GB NVIDIA card. The int4 build fits a 32 GB
card with about 3 GB to spare. No Drama 3 build is small enough for a
reader's machine, so Fish is an author-time tool only. Zonos is the only
candidate if speech is ever generated on the reader's machine.

## Measurements

Every number comes from the same six-line, two-character scene, rendered by
each method. The ECAPA speaker model (SpeechBrain, VoxCeleb) scored voice
similarity: 1.0 is identical, and two different characters scored 0.08 to
0.30. Whisper large-v3-turbo scored intelligibility.

| Method | Same character, line to line | Take to its reference |
| --- | --- | --- |
| macOS system voice | 0.76-0.89 | - |
| Zonos, design applied to every line | 0.74-0.78 | 0.76 |
| Zonos, clone of a standard-phrase clip | 0.74-0.76 | 0.75-0.76 |
| Zonos, embedding of a standard-phrase clip | 0.76-0.80 | 0.77-0.78 |
| Zonos, clone of an author recording | 0.69-0.76 | 0.69-0.70 |
| Fish, clone of a Zonos standard phrase | 0.60-0.62 | 0.68-0.71 |
| Fish, clone of an author recording | 0.58-0.72 | 0.66-0.80 |
| Fish casting, then Fish clones | 0.76-0.80 | 0.81-0.86 |
| Fish casting, then Zonos clones | 0.71-0.77 | 0.65-0.76 |

- Cloning Fish's own cast take gave Fish its most consistent voices. The
  speaker model also reacts to delivery, so part of the lower Fish scores
  elsewhere is Fish varying its reading more.
- Intelligibility was high everywhere. Of about 150 generated takes, two
  fell short: one dropped its last sentence, and one lost a "'d". The check
  step is still required.
- An earlier Zonos test that rendered each line three times scored 0.76
  with the design applied per line, and 0.79-0.83 when every line was cloned
  from a standard phrase. A description alone drifts, and the standard
  phrase fixes the voice.

## Casting with Fish

Fish takes no voice description. A bracketed description before the text
("a young American woman in her twenties, with a bright, quick, friendly
voice") was not spoken, but it did not set the voice either. Of ten
candidates per character, three "young woman" takes and three "older woman"
takes had female-range pitch, and the candidates of one description scored
-0.03 to 0.66 against each other, so they were different people. Casting
therefore means generating candidates and having the author choose. Pitch
can pre-filter the candidates, but only a listener can judge age, accent and
character.

## Directions

Fish reads free-text direction in square brackets wherever it appears, such
as `[flustered and apologetic, a little out of breath]` at the start of a
line, or `[sighs]` and `[whispering]` partway through it. It also has paired
tags such as `<emphasis>...</emphasis>`. Zonos has mood and emotion
controls, set per request or over character spans, plus whisper, tempo and
loudness.

Kinetic's `text` is plain text with no markup, and the player draws it as
written. Directions therefore need their own place, which the reader never
sees. Two shapes are possible:

- **Per line.** An optional `direction` string on an item, read only by the
  voice build.
- **Inline.** An optional `speech` string on an item: the spoken form of
  `text`, with directions in brackets where they apply, such as
  `"speech": "[sighs] Fine. [laughs] Well, maybe that's fair."`. When it is
  absent, the build speaks `text`.

Either field could also live in a separate voice file keyed by item id, as
the translations entry in docs/future.md proposes for language files. That
keeps voice work out of the manifest and lets it change without touching
the story.

## Audio size

Twelve Fish takes were encoded at falling bitrates and scored against the
44.1 kHz original with PESQ wideband (ITU P.862.2, maximum about 4.64):

| Codec | Measured kb/s | MB per hour | PESQ-WB |
| --- | --- | --- | --- |
| Opus 48k | 45.4 | 20.4 | 4.54 |
| Opus 32k | 31.3 | 14.1 | 4.46 |
| Opus 24k | 24.5 | 11.0 | 4.36 |
| Opus 20k | 20.9 | 9.4 | 4.29 |
| Opus 16k | 17.9 | 8.1 | 4.11 |
| Opus 12k | 13.7 | 6.2 | 3.96 |
| Opus 8k | 10.2 | 4.6 | 3.00 |
| AAC-LC 64k | 67.4 | 30.3 | 4.37 |
| AAC-LC 32k | 35.1 | 15.8 | 3.67 |
| HE-AAC 24k | 26.7 | 12.0 | 3.18 |
| MP3 48k | 48.7 | 21.9 | 4.24 |

- Mono Opus in WebM, which Kinetic already accepts, is the clear choice.
  By ear, 16 kb/s is good, 12 kb/s is usable and 8 kb/s is not, which
  matches where the scores fall.
- PESQ wideband stops at 8 kHz, so it cannot see Opus narrowing its audio
  band at low bitrates. Listening has to confirm the choice.
- A neural codec could go further: Fish and Zonos store speech as codec
  tokens at about 2 kb/s, or 1 MB an hour. Playing them back needs the
  codec's decoder in the player, 0.45 to 1.9 GB of weights, so it does not
  pay at game scale.
- An assembled folder ships each audio file as a base64 script, which adds
  a third to every voice file.

## A large game

One converted game holds 109,898 text lines, of which 80,955 are distinct,
spoken by 202 named speakers. Its distinct lines hold 659,696 words, and one
of its three episodes holds 296,034. Fish read the test scene at 146 words a
minute, including each take's lead-in and tail silence.

| | One episode | Whole game |
| --- | --- | --- |
| Speech | about 34 hours | about 75 hours |
| Opus 16k | 275 MB | 610 MB |
| Opus 16k as base64 scripts | 365 MB | 815 MB |
| Opus 12k as base64 scripts | 280 MB | 620 MB |
| Fish on one RTX 5090, one request at a time | about 7 hours | about 15 hours |

The same game's images and videos take 47 GB, so voicing it adds under 2
per cent. On the live path the folder carries under 1 KB per speaker
instead. Running several requests at once should shorten the generation
time, which was not measured.

## Running the engines

**Zonos3-Mini on a Mac.** Clone `Zyphra/ZONOS3-Mini`, run `uv sync --locked
--package zonos3-mlx`, download the `gguf/` folder of the Hugging Face repo
(only the backbone, `zac-keep2`, `spk-encoder` and `steer` files are needed
for embedding voices), and start `servers/mlx/scripts/serve.sh`.
`POST /v2/generate` takes `speaker_mode` `embedding` or `reference`. The
first request with a new clip takes 30 to 60 seconds while the clip encoder
loads. The stock script also installs espeak-ng, which is GPL and not
needed.

**Fish Drama 3 on a 32 GB NVIDIA card.** It runs through SGLang Omni, which
is Linux only, so on Windows it runs in WSL. Install SGLang Omni from source
with the `fishaudio` extra and download `fishaudio/drama-3-int4`. On an RTX
5090 under WSL, without root, it needed these fixes:

- `CUDA_HOME` pointing at the venv's `nvidia/cu13` wheel, because there is
  no system CUDA toolkit.
- `nvidia-cuda-nvcc`, `nvidia-cuda-crt` and `nvidia-nvvm` pinned to 13.0 to
  match the CUDA runtime headers. The installer pulls in 13.5, and the JIT
  kernel builds then fail.
- Links to `libcudart.so` and to WSL's `/usr/lib/wsl/lib/libcuda.so.1`
  in the wheel's `lib64`, for the kernel builds to link.
- Memory settings that fit 32 GB:

  ```bash
  sgl-omni serve --model-path drama-3-int4 --port 8000 \
    --tts_engine.gpu_memory_fraction 0.79 \
    --vocoder.gpu_memory_fraction 0.105 \
    --preprocessing.factory.max_reference_audio_seconds 13 \
    --preprocessing.total_reserve_bytes 2147483648 \
    --preprocessing.factory.reference_encode_graph_max_seconds 0 \
    --tts_engine.engine.cuda_graph_backend_prefill disabled \
    --tts_engine.factory.max_new_tokens 800 \
    --tts_engine.factory.max_running_requests 4
  ```

The int4 weights take 24.3 GB on the card, not the published 20.8 GB, and
the server uses 29.5 GB in all. It also downloads the S2-Pro codec on first
start. Requests go to `POST /v1/audio/speech` with `input`, `references`
(base64 audio in `data`, transcript in `text`) and `response_format`.
This build of SGLang Omni refuses speaker tags other than 0, so a whole
scene in one request, which Drama 3 supports, was not tried.

## Licensing

- **Zonos3-Mini.** Weights Apache-2.0, code MIT.
- **Fish Drama 3.** Fish Audio Community License 1.0:
  - free for commercial use while yearly revenue is under USD 500,000;
  - a product that uses the model must show "Built with Fish Audio";
  - no imitating a real person's voice without their consent;
  - the user owns the outputs.

  Whether a game that ships only generated audio counts as a product that
  uses the model is unclear. Fish's hosted API ($50 per million characters)
  is the alternative for authors without a large NVIDIA card.

## To settle

- Whether to build the recorded path, the live path, or both, and in which
  order.
- For the live path: where Zonos runs for the reader (the Mac app on MLX,
  the Windows app on ggml, or the browser on WebGPU, of which only MLX was
  tried), how the opt-in download works, and how a description becomes a
  starting voice and sliders.
- Per-line `direction`, inline `speech`, or a separate voice file, how the
  validator checks them, and how a Fish direction maps to Zonos's mood
  controls.
- Whether thoughts (`thought: true`) are voiced, and how they should sound.
- Whether narration without a speaker is voiced, and by whom.
- Where the cast references live, and how the build caches takes so that
  a rebuild regenerates only changed lines. Generation is not bit-exact
  from a seed, so the takes are author assets rather than something
  `kinetic-media rebuild` can reproduce.
- Silence trimming and loudness matching between takes.
- Whether the recorded path drives a local server, the hosted API, or both.
