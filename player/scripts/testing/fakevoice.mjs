// A stand-in for a game app's voice engine (docs/plan.md Phase 52, "The
// bridge"), for the scenarios: a page script that gives the page
// `window.kineticHost` with `voice: true` and answers the page's voice
// messages as a host would, calling `window.__kineticVoice(event)`. It runs
// before the page's own scripts on either engine (puppeteer's
// evaluateOnNewDocument; the WebKit driver's addScript), apart from the
// real bridges, so the page meets the same host on Chrome and WebKit.
//
// It starts in `state` ("absent", "ready", "error" or "unsupported" with
// `message`). `install` runs from absent (or error) through installing,
// reporting progress every 100 ms over `installMs`, to ready, or to error
// while `failInstalls` is above 0 (each failure counts it down); `cancel`
// and `remove` go back to absent. `voice` answers with a voice id;
// `speak` answers after the fake's `delayMs` (or `delays[text]`) with a
// 24 kHz mono 16-bit WAV of a tone `secondsPerChar` long per character
// (at least `minSeconds`), unless the text is in `failTexts` (an error);
// `drop` cancels a line not yet answered and answers `dropped`. A text in
// `holdTexts` is not answered until `release(text)` (then after the delay).
//
// Everything is in `window.__fakeVoice`, which a test reads and changes
// with page.evaluate: `messages` (every message the page sent, as JSON
// round-trips it), `events` (every event it gave the page), `answered` and
// `dropped` (speak ids), `voices` (voice id -> { format, bytes, text }),
// and the settings above, live (`delayMs`, `delays`, `failInstalls`,
// `failTexts`, `holdTexts`), and `release(text)`.

/** The page script; pass it to evaluateOnNewDocument with its options. */
export const FAKE_VOICE_HOST = (options = {}) => {
  const o = {
    state: "absent",
    downloadBytes: 3_200_000_000,
    installMs: 1500,
    message: "",
    delayMs: 200,
    secondsPerChar: 0.04,
    minSeconds: 0.6,
    failInstalls: 0,
    holdTexts: [],
    kind: "mac-app",
    display: "window",
    ...options,
  };
  const fake = {
    messages: [],
    events: [],
    answered: [],
    dropped: [],
    voices: {},
    state: o.state,
    message: o.message,
    done: 0,
    delayMs: o.delayMs,
    delays: {},
    failInstalls: o.failInstalls,
    failTexts: [],
    holdTexts: [...o.holdTexts],
    release(text) {
      fake.holdTexts = fake.holdTexts.filter((t) => t !== text);
      for (const [id, m] of held) {
        if (m.text !== text) continue;
        held.delete(id);
        answerLater(m);
      }
    },
  };
  Object.defineProperty(window, "__fakeVoice", { value: fake });
  const pending = new Map();
  /** Speaks held back (`holdTexts`) until `release`, by id. */
  const held = new Map();
  let serial = 0;
  let installTimer = null;

  const emit = (event) => {
    fake.events.push(event);
    if (typeof window.__kineticVoice === "function") {
      window.__kineticVoice(event);
    }
  };
  const status = () => {
    const event = {
      event: "status",
      state: fake.state,
      downloadBytes: o.downloadBytes,
    };
    if (fake.state === "installing") {
      event.done = fake.done;
      event.total = o.downloadBytes;
    }
    if (fake.state === "error" || fake.state === "unsupported") {
      event.message = fake.message;
    }
    return event;
  };
  const setState = (state, message = "") => {
    fake.state = state;
    fake.message = message;
    emit(status());
  };
  const stopInstall = () => {
    clearInterval(installTimer);
    installTimer = null;
  };
  const install = () => {
    if (fake.state !== "absent" && fake.state !== "error") return;
    fake.done = 0;
    setState("installing");
    const step = (o.downloadBytes * 100) / o.installMs;
    installTimer = setInterval(() => {
      fake.done = Math.min(o.downloadBytes, fake.done + step);
      if (fake.done < o.downloadBytes) {
        emit(status());
        return;
      }
      stopInstall();
      if (fake.failInstalls > 0) {
        fake.failInstalls -= 1;
        setState("error", "The download failed: the connection dropped.");
      } else setState("ready");
    }, 100);
  };

  /** A tone `seconds` long: a 24 kHz mono 16-bit WAV, base64. */
  const wav = (seconds) => {
    const rate = 24000;
    const n = Math.round(seconds * rate);
    const bytes = new Uint8Array(44 + n * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => {
      for (let i = 0; i < s.length; i += 1)
        view.setUint8(at + i, s.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, n * 2, true);
    const ramp = rate * 0.01;
    for (let i = 0; i < n; i += 1) {
      const edge = Math.min(1, i / ramp, (n - 1 - i) / ramp);
      const v = 0.3 * edge * Math.sin((2 * Math.PI * 220 * i) / rate);
      view.setInt16(44 + i * 2, Math.round(v * 32767), true);
    }
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  };

  const later = (run, ms) => setTimeout(run, ms);
  const handle = (m) => {
    switch (m.op) {
      case "status":
        later(() => emit(status()), 5);
        return;
      case "install":
        install();
        return;
      case "cancel":
        if (fake.state === "installing") {
          stopInstall();
          setState("absent");
        }
        return;
      case "remove":
        stopInstall();
        setState("absent");
        return;
      case "voice": {
        serial += 1;
        const voiceId = `voice-${String(serial)}`;
        fake.voices[voiceId] = {
          format: m.format,
          bytes: typeof m.data === "string" ? m.data.length : 0,
          text: m.text,
        };
        later(() => emit({ event: "voice", id: m.id, voiceId }), 5);
        return;
      }
      case "speak":
        if (fake.holdTexts.includes(m.text)) held.set(m.id, m);
        else answerLater(m);
        return;
      case "drop": {
        if (held.delete(m.id)) {
          fake.dropped.push(m.id);
          later(() => emit({ event: "dropped", id: m.id }), 5);
          return;
        }
        const timer = pending.get(m.id);
        if (timer === undefined) return;
        clearTimeout(timer);
        pending.delete(m.id);
        fake.dropped.push(m.id);
        later(() => emit({ event: "dropped", id: m.id }), 5);
        return;
      }
    }
  };

  /** Answers speak `m` after its delay (an error for a failing text). */
  function answerLater(m) {
    const delay = fake.delays[m.text] ?? fake.delayMs;
    const timer = later(() => {
      pending.delete(m.id);
      if (fake.failTexts.includes(m.text)) {
        emit({
          event: "error",
          id: m.id,
          code: "engine",
          message: "The engine could not voice that line.",
        });
        return;
      }
      fake.answered.push(m.id);
      const seconds = Math.max(
        o.minSeconds,
        [...m.text].length * o.secondsPerChar,
      );
      emit({ event: "speech", id: m.id, wav: wav(seconds), seconds });
    }, delay);
    pending.set(m.id, timer);
  }

  const host = Object.freeze({
    kind: o.kind,
    display: o.display,
    voice: true,
    send(message) {
      const m = JSON.parse(JSON.stringify(message));
      fake.messages.push(m);
      if (m.type === "voice") handle(m);
    },
  });
  Object.defineProperty(window, "kineticHost", { value: host });
  window.dispatchEvent(new Event("kinetic-host"));
};

/** What the fake host holds now (see the header), read from the page. */
export const readFakeVoice = (page) =>
  page.evaluate(() => {
    const f = window.__fakeVoice;
    if (f === undefined) return null;
    return {
      messages: f.messages,
      answered: f.answered,
      dropped: f.dropped,
      voices: f.voices,
      state: f.state,
      events: f.events.map((e) =>
        e.event === "speech" ? { ...e, wav: e.wav.length } : e,
      ),
    };
  });
