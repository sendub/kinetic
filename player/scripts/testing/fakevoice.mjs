// A stand-in for a game app's voice engine (docs/plan.md Phase 52, "The
// bridge"), for the scenarios: a page script that gives the page
// `window.kineticHost` with `voice: true` and answers the page's voice
// messages as a host would, calling `window.__kineticVoice(event)`. It runs
// before the page's own scripts on either engine (puppeteer's
// evaluateOnNewDocument; the WebKit driver's addScript), apart from the
// real bridges, so the page meets the same host on Chrome and WebKit.
//
// It starts in `state` ("absent", "ready", "error" or "unsupported" with
// `message` and `problem`, the status's `code` and its numbers, as the apps
// send them: docs/plan.md Phase 56 item 7). `install` runs from absent (or
// error) through installing, reporting progress every 100 ms over
// `installMs`, to ready, or to error (`download-failed`) while
// `failInstalls` is above 0 (each failure counts it down); `cancel`
// and `remove` go back to absent. `voice` answers with a voice id;
// `speak` answers after the fake's `delayMs` (or `delays[text]`) with a
// 24 kHz mono 16-bit WAV of a tone `secondsPerChar` long per character
// (at least `minSeconds`), unless the text is in `failTexts` (an error);
// `drop` cancels a line not yet answered and answers `dropped`. A text in
// `holdTexts` is not answered until `release(text)` (then after the delay).
//
// A `speak` with `stream: true` is answered as the helper does
// (apps/voice/README.md): the line's tone is cut into chunks, `chunk` events
// `{ event: "chunk", id, index, wav, seconds, final }` the first after the
// delay, each later one `chunkMs` after the one before, and then the usual
// `speech` with the whole line `replyMs` after the last chunk. The tone is
// one continuous sine across the chunks (only the line's ends are faded), so
// a tap of the mix hears a gap or a click at a seam. The chunks are
// `chunkSeconds` long (the last takes what is left). A text in `cachedTexts`
// (or, with the `cache` option, one answered before) is answered at once
// (after `cachedMs`) with the `speech` alone, `cached: true`, streamed or
// not; a line already running when dropped finishes and answers (the page
// ignores it), as the helper's does.
//
// Everything is in `window.__fakeVoice`, which a test reads and changes
// with page.evaluate: `messages` (every voice message the page sent, as
// JSON round-trips it), `hostMessages` (the page's other messages, its
// `language` ones), `events` (every event it gave the page), `answered` and
// `dropped` (speak ids), `voices` (voice id -> { format, bytes, text }),
// and the settings above, live (`delayMs`, `delays`, `failInstalls`,
// `failTexts`, `holdTexts`, `chunkSeconds`, `chunkMs`, `replyMs`, `cachedMs`,
// `cachedTexts`), `release(text)`, and `setStatus(state, message,
// problem)`, which moves to a state and tells the page as the apps do.

/** The page script; pass it to evaluateOnNewDocument with its options. */
export const FAKE_VOICE_HOST = (options = {}) => {
  const o = {
    state: "absent",
    downloadBytes: 3_200_000_000,
    installMs: 1500,
    message: "",
    problem: {},
    delayMs: 200,
    secondsPerChar: 0.04,
    minSeconds: 0.6,
    failInstalls: 0,
    holdTexts: [],
    chunkSeconds: 0.5,
    chunkMs: 100,
    replyMs: 50,
    cachedMs: 5,
    cache: false,
    kind: "mac-app",
    display: "window",
    ...options,
  };
  const fake = {
    messages: [],
    hostMessages: [],
    events: [],
    answered: [],
    dropped: [],
    voices: {},
    state: o.state,
    message: o.message,
    problem: o.problem,
    done: 0,
    delayMs: o.delayMs,
    delays: {},
    failInstalls: o.failInstalls,
    failTexts: [],
    holdTexts: [...o.holdTexts],
    chunkSeconds: o.chunkSeconds,
    chunkMs: o.chunkMs,
    replyMs: o.replyMs,
    cachedMs: o.cachedMs,
    cachedTexts: [],
    setStatus(state, message = "", problem = {}) {
      setState(state, message, problem);
    },
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
      Object.assign(event, fake.problem);
    }
    return event;
  };
  const setState = (state, message = "", problem = {}) => {
    fake.state = state;
    fake.message = message;
    fake.problem = problem;
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
        setState("error", "The download failed: the connection dropped.", {
          code: "download-failed",
        });
      } else setState("ready");
    }, 100);
  };

  const RATE = 24000;
  /** A tone `seconds` long at 220 Hz, 16-bit samples, faded in and out at its ends. */
  const tone = (seconds) => {
    const n = Math.round(seconds * RATE);
    const pcm = new Int16Array(n);
    const ramp = RATE * 0.01;
    for (let i = 0; i < n; i += 1) {
      const edge = Math.min(1, i / ramp, (n - 1 - i) / ramp);
      const v = 0.3 * edge * Math.sin((2 * Math.PI * 220 * i) / RATE);
      pcm[i] = Math.round(v * 32767);
    }
    return pcm;
  };
  /** 16-bit samples as a 24 kHz mono WAV, base64. */
  const wavOf = (pcm) => {
    const n = pcm.length;
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
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) view.setInt16(44 + i * 2, pcm[i], true);
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
        const run = pending.get(m.id);
        // A line already running finishes, as the helper's does.
        if (run === undefined || run.started) return;
        for (const timer of run.timers) clearTimeout(timer);
        pending.delete(m.id);
        fake.dropped.push(m.id);
        later(() => emit({ event: "dropped", id: m.id }), 5);
        return;
      }
    }
  };

  /** Answers speak `m` (see the header): whole, in chunks, or from the cache. */
  function answerLater(m) {
    const run = { timers: [], started: false, failed: false };
    const at = (ms, fn) => {
      run.timers.push(later(fn, ms));
    };
    pending.set(m.id, run);
    const seconds = Math.max(
      o.minSeconds,
      [...m.text].length * o.secondsPerChar,
    );
    const reply = (extra = {}) => {
      pending.delete(m.id);
      fake.answered.push(m.id);
      if (o.cache && !fake.cachedTexts.includes(m.text)) {
        fake.cachedTexts.push(m.text);
      }
      emit({
        event: "speech",
        id: m.id,
        wav: wavOf(tone(seconds)),
        seconds,
        ...extra,
      });
    };
    if (fake.cachedTexts.includes(m.text)) {
      at(fake.cachedMs, () => reply({ genSeconds: 0, cached: true }));
      return;
    }
    const delay = fake.delays[m.text] ?? fake.delayMs;
    const fail = () => {
      pending.delete(m.id);
      emit({
        event: "error",
        id: m.id,
        code: "engine",
        message: "The engine could not voice that line.",
      });
    };
    if (m.stream !== true) {
      at(delay, () => (fake.failTexts.includes(m.text) ? fail() : reply()));
      return;
    }
    // Streamed: one tone across the chunks, cut at `chunkSeconds`.
    const whole = tone(seconds);
    const size = Math.max(1, Math.round(fake.chunkSeconds * RATE));
    const count = Math.max(1, Math.ceil(whole.length / size));
    for (let index = 0; index < count; index += 1) {
      at(delay + index * fake.chunkMs, () => {
        run.started = true;
        if (run.failed) return;
        if (fake.failTexts.includes(m.text)) {
          run.failed = true;
          fail();
          return;
        }
        const part = whole.slice(index * size, (index + 1) * size);
        emit({
          event: "chunk",
          id: m.id,
          index,
          wav: wavOf(part),
          seconds: part.length / RATE,
          final: index === count - 1,
        });
      });
    }
    at(delay + (count - 1) * fake.chunkMs + fake.replyMs, () => {
      if (!run.failed) {
        reply({ genSeconds: 1, cached: false, firstSeconds: delay / 1000 });
      }
    });
  }

  const host = Object.freeze({
    kind: o.kind,
    display: o.display,
    voice: true,
    send(message) {
      const m = JSON.parse(JSON.stringify(message));
      if (m.type !== "voice") {
        fake.hostMessages.push(m);
        return;
      }
      fake.messages.push(m);
      handle(m);
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
      hostMessages: f.hostMessages,
      answered: f.answered,
      dropped: f.dropped,
      voices: f.voices,
      state: f.state,
      events: f.events.map((e) =>
        e.event === "speech" || e.event === "chunk"
          ? { ...e, wav: e.wav.length }
          : e,
      ),
    };
  });
