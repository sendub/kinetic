# Voice reading

What we learned in November 2026 about giving every line of a Kinetic
game a generated voice, and the decisions now in force. docs/plan.md
Phase 52 builds it, the Mac app first; the Windows app is in progress.
The first round of research (Fish and Zonos, 2026-11-15) is kept at the
end, under "Earlier research".

## Decisions in force

- Lines are generated live on the reader's machine with Chatterbox
  multilingual v3 (MIT, Resemble AI), each character cloned from a
  reference clip. The reader opts in to a download; no game folder holds
  a model.
- Reference clips are cast at author time with Qwen3-TTS 1.7B
  VoiceDesign: the author describes a character, listens to several
  takes and picks one, or supplies their own recording
  (`tools/cast_voices.py`, CREATE.md, "Giving characters voices").
- No Fish recording support, and no direction markup: lines are spoken
  as written.
- The browser's built-in speech (`speechSynthesis`) is a no-go. Its
  voices depend on the reader's machine, it has no per-character design,
  no direction and no cloning, and it lost clearly in a side-by-side
  listen.
- Recorded voice tracks (an item's `audio.voice`) are mono Opus at 16
  kb/s. By ear, 12 kb/s is still usable and 8 kb/s is not. A recorded
  line always wins over a generated one.

## Speed

A ratio below is generation time over audio length: 0.5 means a line is
made in half the time it lasts. (The engines table under "Earlier
research" counts the other way, so its "6-7x real time" is 6 to 7 seconds
of audio per second.)

On an M2 with 16 GB, after item 2b of Phase 52 (5 flow steps, a 6 s
decoder prompt and a pipelined token loop), lines take 0.53-0.56 of their
length in the real helper. A streamed line's first chunk arrives after
1.6-1.8 s, and its whole line after 4.7-4.8 s for a line of 5.5-5.9 s.
A cached line answers in 2 ms. The research's earlier 0.35x was wrong: its
timer stopped before mlx-audio's lazily evaluated decoder ran. With the
decoder counted, the same 8-bit setup took 1.03-1.11. "Chatterbox at live
speed", below, has the table.

## Casting, then reading

**Casting** happens once, on the author's Apple silicon Mac. The author
describes each character, `design` makes four takes of one standard
phrase for each with Qwen3-TTS VoiceDesign, and the author picks one by
ear. A description narrows a voice without fixing it, so the take is the
voice. The picked take ships in the game folder as a FLAC under `voices/`,
with its transcript and description in the manifest (docs/content-format.md,
"Voices"). An author can record the clip instead.

**Reading** happens on the reader's machine. The app's helper clones each
speaker from their clip and generates lines ahead of the reader. Each
clip's voice conditioning is computed once, the text-to-token transformer
is quantized to 8 bits as it loads, and generated lines are cached on
disk, so a reread is instant. The model, a private Python and the pinned
packages live in one per-machine voice folder, installed by a download the
reader starts (apps/README.md, "Spoken lines"; apps/voice/README.md).

The standard phrase the casting tool speaks:

```text
Hello there. I've been waiting a long time to tell you this story, so
please, sit down and listen. Some of it is funny, some of it is sad, and
all of it is true.
```

## Models that run on a Mac

mlx-audio (github.com/Blaizzy/mlx-audio) runs about 40 speech models on
Apple silicon. Six were tried, each cloning both characters of the test
scene from the same reference take:

| Model | Download | Peak memory | Speed on M2 | License |
| --- | --- | --- | --- | --- |
| Zonos3-Mini | 1.4 GB | 2.3 GB | 0.87 (0.15 on Zyphra's own server) | Apache-2.0 |
| Qwen3-TTS 0.6B Base | 2.5 GB | 7.2 GB | 2.1 | Apache-2.0 |
| Qwen3-TTS 1.7B Base | 4.5 GB | 9.1 GB | 2.9 | Apache-2.0 |
| VoxCPM2 (8-bit) | 3.2 GB | 9.3 GB | 5.8 | Apache-2.0 |
| Ming-3.0-tts 0.5B | 3.0 GB | 4.0 GB | 2.2 | MIT |
| Chatterbox multilingual v3 | 2.7 GB | 4.8 GB | 2.0 | MIT |

Speeds are as downloaded, measured while other work loaded the machine.
Only Zonos on its own server was fast enough to voice lines live, and the
mlx-audio ports are not tuned for speed (Ming's card reports about real
time on an M4 Pro). Chatterbox was the one worth tuning; see "Chatterbox
at live speed".

Seen but not tried:

- **Higgs TTS 3** (Boson, 4B): the only model with explicit pause tokens,
  but its license is research and non-commercial, and at 8-10 GB in bf16
  it is tight on 16 GB.
- **OmniVoice** (k2-fsa, 0.6B): in mlx-audio. Its weights are reported as
  CC-BY-NC, which was not confirmed.
- **MOSS-VoiceGenerator** (1.7B, Apache-2.0), **Maya1** (3.3B,
  Apache-2.0) and **Tencent AuK** (1.5B, MIT): voice design, with no MLX
  port found.

## Voice design

Qwen3-TTS 1.7B VoiceDesign, VoxCPM2 and Ming-3.0 each made the standard
phrase three times from each description. Unlike Fish, all three follow
the description's gender and rough age: every Wren take was high-pitched
and every Helen take lower. Each take is still a different person: the
takes of one description scored -0.01 to 0.65 against each other (ECAPA).
Qwen3-TTS VoiceDesign was the most repeatable (0.34 to 0.65) and failed no
take. One Ming take ran on into 30 seconds of noise. Qwen3-TTS VoiceDesign
was the only usable voice designer, so it is the casting tool's model,
at about twice real time on an M2.

## Line readings

The test line is Helen's "Not someone. You. Your grandmother always said
you'd find your way here, one day.", which wants a pause before "You" and
stress on it. Four takes per model, measured with Whisper word timings,
the silence between the words, and "You"'s loudness and pitch against the
rest of the line:

| Model | Pause before "You" (s) | "You" louder (dB) | "You" higher (semitones) |
| --- | --- | --- | --- |
| Zonos3-Mini | 0.27-0.57 | -2.0 to 3.9 | 1.1 to 5.0 |
| Qwen3-TTS 0.6B | 0.28-0.69 | -1.8 to 3.9 | -1.9 to 1.2 |
| Qwen3-TTS 1.7B | 0.18-0.66 | 0.3 to 4.0 | -2.1 to 4.4 |
| VoxCPM2 | 0 | -6.5 to -1.1 | -7.3 to -1.1 |
| Ming-3.0 0.5B | 0.34-0.38 | 2.5 to 4.6 | 2.0 to 6.4 |
| Chatterbox v3 | 0.32-0.50 | -2.1 to 2.0 | 0.1 to 8.5 |

- By these measures Ming-3.0 was the only model to pause and stress "You"
  in every take. Its cost is voice match: its takes scored 0.67-0.71
  against the reference, the lowest of the six (the others 0.73-0.82).
- The user listened to this line and the whole scene and ranked
  Chatterbox multilingual v3 first, then Ming-3.0, then Qwen3-TTS 1.7B.
  Chatterbox is the engine.
- VoxCPM2 ran the line together in every take, and one take said "Not
  someone new". Qwen3-TTS asked "You?" in two of four 0.6B takes.
- Game text is used as written. For the record, capitals broke Zonos,
  which read "YOU" as "You owe you".

## Chatterbox at live speed

Chatterbox as downloaded ran at about real time on an M2 (0.97 on a quiet
machine). Two changes in the research, and then Phase 52's items 2 and
2b, brought it to the speed in force:

- Compute each character's voice conditioning once and reuse it.
- Quantize the text-to-token transformer (T3) when the model loads, with
  MLX's `nn.quantize` (8 bits, group size 64). That needs no extra
  download. The research found T3 the bottleneck and measured 0.35x with
  it at 8 bits; that timer left out the decoder, so the figure is T3
  alone.

The measurements of the real settings, on the six-line scene plus three
more takes of the key line (49.3 s of audio), through mlx-audio 0.6.5
with T3 at 8 bits, while other jobs loaded the machine (differences
under about 0.08 are noise):

| Settings | Ratio | Speaker match, mean | Pause before "You" |
| --- | --- | --- | --- |
| 10 flow steps (mlx-audio's) | 1.15 | 0.816 | 0.44 s |
| 5 steps | 0.74 | 0.815 | 0.43 s |
| 4 steps | 0.83 | 0.807 | 0.44 s |
| 5 steps, 4 s decoder prompt | 0.53 | 0.779 (one line 0.652) | 0.43 s |
| 5 steps, 6 s prompt, pipelined T3 (used) | 0.53-0.61 | 0.801 | 0.42 s |
| Turbo's one-step decoder behind the same tokens | 0.41 | 0.793 | 0.45 s |

- The decoder runs over the voice's prompt and the line together at every
  step, so fewer steps and a shorter prompt cut its work most. The rule
  was a speaker match within 0.02 of 10 steps and a Whisper word error
  rate of 0; 5 steps with a 6 s prompt meets it (0.801 against 0.816).
- Pipelining T3's loop (queueing the next step before reading the
  current token back) took 13.1 to 10.9 ms a token with identical tokens.
- Chatterbox Turbo's one-step decoder works behind the multilingual
  tokens, but the speaker match fell 0.023 or more and it needs another
  415 MB, so it was rejected. `mx.compile` was slower (every line has a
  new shape) and f16 or bf16 gained nothing.
- Streaming decodes the prompt again for each chunk, so a streamed line
  costs about 1.6x the work: only the line a reader is waiting for
  streams. Chunks join by re-rendering the previous chunk's last 160 ms
  and crossfading; the two renderings differ by 0.4% RMS (median).
- Peak MLX memory was 3.6 GB and the helper's maximum RSS 3.35 GB.
- The 4-bit transformer reached 0.28x in the research, with the same
  caveat. It is not used: it would be worth it only for a smaller
  download, and there is no smaller MLX copy to fetch (question a).

## Questions for the user

The choices the orchestrator made while the user was away, listed to
review when trying the demo (`fixtures/voice-demo`):

a. **Download size.** About 3.3 GB, because the only MLX copy of the
   model is full precision (2.7 GB) and Kinetic does not host a smaller
   one. Quantizing to 8 bits happens on load, so it saves memory and time,
   not download.
b. **On by default.** Spoken lines are on once installed, and Download
   turns them on. The switch can turn them off.
c. **Thoughts.** A thought is spoken in its speaker's normal voice.
d. **No speaker.** Lines with no speaker use the game's narrator voice;
   a speaker with no voice stays silent.
e. **Auto-forward.** It waits up to 20 s for a line still being made,
   then moves on.
f. **Speed over match.** 5 flow steps and a 6 s voice prompt lower the
   speaker match slightly (0.801 against 0.816 for 10 steps) for twice
   the speed.
g. **One folder per machine.** One voice folder serves every Kinetic game
   on the machine, and Remove deletes all of it, for every game.
h. **macOS 14.** Voices need macOS 14 or later (the MLX packages), while
   the app itself runs on macOS 12. On an older Mac the row says so.
i. **Clips as FLAC.** Reference clips ship in the game as FLAC under
   `voices/`, about 270-340 KB each for a 9-13 s clip.
j. **Chinese.** Chinese text segmentation is degraded because a library
   was left out of the install. English is the target.
k. **Watermark.** Resemble's PyTorch package adds a PerTh watermark to
   what it generates. The MLX path through mlx-audio has no watermark
   step in its code, but a detector was not run on its output. Whether
   that is acceptable is the user's call. The Windows path uses the
   PyTorch package, so it would carry the mark.
l. **Windows.** The Windows engine runs Resemble's PyTorch code on an
   NVIDIA GPU when its driver is new enough, else on the CPU. On an RTX
   5090 lines took 0.32-0.34x real time (first streamed chunk under 1 s),
   but the download is 6.8 GB (CUDA PyTorch alone is 3.5 GB). On the CPU
   (a Ryzen 7 9800X3D) lines took about 1.6x real time, too slow to keep
   ahead of a reader, for a 4.0 GB download; int8 quantization doubled the
   speed but garbled lines. Should the Windows app offer voices without an
   NVIDIA GPU, with a warning that the reader will wait for lines, or not
   at all?
m. **Four takes.** The casting tool makes 4 takes of each voice by
   default and the author picks by ear; `--takes` changes the number.

## Earlier research

The first round, on 2026-11-15, compared Fish Audio Drama 3 and Zonos3-Mini
and the browser's own speech. Fish cloned best from a reference recording
but needs a 32 GB NVIDIA card, so it could only be an author-time tool,
and the user chose to drop it. Zonos ran live on a Mac but read some lines
weakly. Their numbers are kept below because the measurement method
(ECAPA speaker match, Whisper, PESQ) is the one the later rounds use.

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
reader's machine, and Zonos's lines read weaker than Chatterbox's, so
neither is used (Decisions in force).

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
written. Chatterbox has one emotion setting for a whole line
(`exaggeration`, fixed at 0.5) and no per-line direction, so Kinetic adds
no direction field: lines are spoken as written.

## Audio size

These numbers matter for recorded voice tracks only; a generated line is
never stored in a game folder. Twelve Fish takes were encoded at falling
bitrates and scored against the 44.1 kHz original with PESQ wideband
(ITU P.862.2, maximum about 4.64):

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

The same game's images and videos take 47 GB, so recording its voices would
add under 2 per cent. Spoken lines add nothing but one reference clip per
speaker, a FLAC of about 300 KB, 202 clips in all.

## Running the engines

Notes from the first round, kept for anyone who wants to repeat it; Kinetic
runs neither.

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

- **Chatterbox multilingual v3.** MIT, Resemble AI. The PyTorch package
  watermarks its output (question k in "Questions for the user").
- **Qwen3-TTS and Ming-3.0.** Apache-2.0 and MIT. Voices designed with
  Qwen3-TTS ship as reference clips, so the clips are generated audio,
  not recordings of anyone.
- **Zonos3-Mini (not used).** Weights Apache-2.0, code MIT.
- **Fish Drama 3 (not used).** Fish Audio Community License 1.0:
  - free for commercial use while yearly revenue is under USD 500,000;
  - a product that uses the model must show "Built with Fish Audio";
  - no imitating a real person's voice without their consent;
  - the user owns the outputs.

  Whether a game that ships only generated audio counts as a product that
  uses the model is unclear. Fish's hosted API ($50 per million characters)
  is the alternative for authors without a large NVIDIA card.
