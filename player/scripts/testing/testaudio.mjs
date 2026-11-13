// The test-only sound flag every page the tools open gets before the
// player starts (core.mjs launchChrome for Chrome, ../webkit/puppet.mjs
// launchWebKit for the WebKit driver). The player (src/render/audio.ts)
// holds its master gain at 0 under `mute`, just before the destination,
// so its Web Audio graph runs, the test hook's volumes are read before the
// master, and nothing is heard: the WebKit driver's page mute leaves the
// output running (a page playing a buffer of zeros opened a Core Audio
// output; one with no audio did not; macOS 27.2, 2026-11-13), so it is not
// shown to silence Web Audio, and Chrome's fake output stream
// (`--disable-audio-output`) stays as the second guard. The player also
// puts its context and mix in the flag's `mix`, for a tap that records the
// mix (../scenarios/soundtap.mjs). The game apps never set it.
export const TEST_AUDIO_SCRIPT = `(() => {
  const flag = window.KINETIC_TEST_AUDIO ?? {};
  flag.mute = true;
  window.KINETIC_TEST_AUDIO = flag;
})();`;
