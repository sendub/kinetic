# Voice demo reference clips

The reference clips of fixtures/build_voice_demo.py's voices
(docs/content-format.md, "Voices"). They are designed voices, made by a
model from a written description: none is a recording of anyone.

Each is mono FLAC at 24 kHz, the model's own rate, encoded with the
converter's pinned ffmpeg (`.media-tools/`). Each says the casting
tool's standard phrase (`PHRASE` in tools/cast_voices.py): "Hello there.
I've been waiting a long time to tell you this story, so please, sit
down and listen. Some of it is funny, some of it is sad, and all of it
is true."

The model is Qwen3-TTS 1.7B VoiceDesign through mlx-audio,
`mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16` at revision
`7d3824abff87e49756bb0f83fb5411de75d160c4`, language English, with the
seed set by `mx.random.seed` before each take.

| File | Description | Take | Seed | Length | Median pitch |
| --- | --- | --- | --- | --- | --- |
| `wren.flac` | A young American woman in her twenties with a bright, quick, friendly voice. | 1 of 3 | 1 | 9.36 s | 269 Hz |
| `helen.flac` | An older British woman in her sixties with a warm, low, unhurried voice. | 1 of 3 | 1 | 13.44 s | 141 Hz |
| `narrator.flac` | A calm, warm middle-aged male narrator with a clear, measured voice. | 1 of 3 | 1 | 12.16 s | 96 Hz |
| `radio.flac` | A brisk, crisp male radio newsreader in his thirties with a formal, clear broadcast voice. | 3 of 3 | 3 | 10.64 s | 139 Hz |

Wren and Helen come from the voice designer comparison of Phase 52
(docs/voice-reading.md): three takes each, the user judging take 1 of
each usable. The narrator was made with the casting tool,
`tools/cast_voices.py design --takes 3`, and shipped with `pick
narrator=1`. All three of its takes transcribed word for word under
Whisper large-v3-turbo; take 1 has the lowest median pitch (96 Hz,
against 117 and 104 Hz), the deepest of the three for a male narrator.

The radio was made the same way, `tools/cast_voices.py design --takes 3`,
and shipped with `pick Radio=3`. All three takes transcribed under
Whisper large-v3-turbo with the phrase intact (takes 1 and 3 differ from
the written phrase by punctuation only), at 10.08, 8.80 and 10.64 s and
median pitches of 225, 197 and 139 Hz. Take 3 is the lowest, the only
one in a male range, and 43 Hz above the narrator's 96 Hz; its pitch is
near Helen's, but its timbre is a man's.
