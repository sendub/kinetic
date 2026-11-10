# Future features

Features the user has asked for but not yet scheduled. None of them is in
docs/progress.md. When the user schedules one, it becomes a phase in
docs/plan.md with its checklist items, and its entry here goes.

## Read-aloud (requested 2026-11-10)

The player speaks each line itself when the game has no voice file for
it, using the browser's speech synthesis (the Web Speech API's
`speechSynthesis`). It is an on/off setting. Phase 47 plays a game's own
recorded voice lines (an item's `audio.voice`); read-aloud covers games
and lines that have none.

To settle when it is planned:

- What is read: narration and dialogue, and whether a speaker's name is
  spoken.
- Where it works: Safari, Chrome, the Mac app (WKWebView) and the Windows
  app (WebView2), and from `file://`. Voices differ by browser and
  operating system, and some engines may offer none.
- How it fits Phase 47's sound: the Voice volume, `v`, pausing under the
  Esc screen and on a hidden page, and auto-forward waiting for the line
  to end (as it waits for a voice line).
- A line with a recorded voice keeps it; read-aloud never speaks over
  one.
- Testing: automated browsers are silent and agents cannot hear, so the
  tests can only check what the player asked the engine to speak and
  when. The user checks it by ear.
