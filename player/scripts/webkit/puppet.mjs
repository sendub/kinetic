// The subset of puppeteer's Browser, Page and CDPSession that the scenario
// harness uses, over the WebKit driver (apps/macos/driver, built by
// build.mjs). Scenario files keep their code; harness.openScenario picks
// the engine (KINETIC_ENGINE=webkit). docs/verify-player.md, "WebKit".
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TEST_AUDIO_SCRIPT } from "../testing/testaudio.mjs";
import { ensureDriver } from "./build.mjs";

// Every private WebKit hook the driver relies on (its ready line reports
// each): without one, results would be silently wrong, so none may be
// missing.
export const REQUIRED_HOOKS = [
  "_setWindowOcclusionDetectionEnabled:",
  "_setHiddenPageDOMTimerThrottlingEnabled:",
  "_setPageVisibilityBasedProcessSuppressionEnabled:",
  "_setOverrideDeviceScaleFactor:",
  "_simulateMouseMove:",
  "_doAfterNextPresentationUpdate:",
];

/**
 * The hook that keeps the driver silent: it mutes its page (`_setPageMuted:`,
 * apps/macos/driver/main.swift). Without it a run would play a game's sound
 * aloud, so the adapter refuses that driver too.
 */
export const MUTE_HOOK = "_setPageMuted:";

const PROTOCOL_TIMEOUT_MS = 30000;
const START_TIMEOUT_MS = 15000;

/** The JSON-lines connection to one driver process. */
function connect(proc) {
  let next = 1;
  const pending = new Map();
  const listeners = new Map();
  let buffer = "";
  let stderr = "";
  let settleStart;
  // Resolves with the ready line; rejects on a fatal line or an early exit.
  const started = new Promise((resolve, reject) => {
    settleStart = { resolve, reject };
  });
  const fire = (event, msg) => {
    for (const fn of listeners.get(event) ?? []) fn(msg);
  };
  // A write after the driver died must fail the request, not the process.
  proc.stdin.on("error", () => {});
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.event === "ready") settleStart.resolve(msg);
      else if (msg.event === "fatal") {
        settleStart.reject(new Error(`WebKit driver: ${msg.error}`));
        fire("fatal", msg);
      } else if (msg.event !== undefined) fire(msg.event, msg);
      else if (pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.ok) resolve(msg.value);
        else reject(new Error(cleanError(msg.error)));
      }
    }
  });
  proc.on("error", (error) =>
    settleStart.reject(
      new Error(`WebKit driver did not start: ${error.message}`),
    ),
  );
  proc.on("exit", (code, signal) => {
    const why = `WebKit driver exited (code ${code}, signal ${signal})${
      stderr.trim() === "" ? "" : `: ${stderr.trim()}`
    }`;
    settleStart.reject(new Error(why));
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(why));
    }
    pending.clear();
  });
  const send = (cmd, params = {}, timeoutMs = PROTOCOL_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        reject(new Error("WebKit driver is gone"));
        return;
      }
      const id = next++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`WebKit driver: ${cmd} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    });
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  };
  const once = (event, fn) => {
    const wrapper = (msg) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== wrapper),
      );
      fn(msg);
    };
    on(event, wrapper);
  };
  return { send, on, once, started };
}

/** The page exception text inside a WKErrorDomain description. */
function cleanError(text) {
  const m = /WKJavaScriptExceptionMessage=([^,}]*)/.exec(String(text));
  return m ? m[1].trim() : String(text);
}

const wrap = (expr) =>
  `const __v = await (${expr}); return JSON.stringify(__v === undefined ? { u: 1 } : { v: __v });`;
const unwrap = (json) => {
  const parsed = JSON.parse(json);
  return "u" in parsed ? undefined : parsed.v;
};
const callOf = (fn, args) =>
  typeof fn === "function"
    ? `(${fn.toString()})(...${JSON.stringify(args)})`
    : `(0, eval)(${JSON.stringify(fn)})`;

// puppeteer key names to [code, text] for page.keyboard.press.
const KEY_CODES = {
  Enter: ["Enter", "\r"],
  Escape: ["Escape", ""],
  Tab: ["Tab", ""],
  " ": ["Space", " "],
  Space: ["Space", " "],
  ArrowUp: ["ArrowUp", ""],
  ArrowDown: ["ArrowDown", ""],
  ArrowLeft: ["ArrowLeft", ""],
  ArrowRight: ["ArrowRight", ""],
  Backspace: ["Backspace", ""],
};
function keyParams(key) {
  if (KEY_CODES[key])
    return {
      key: key === "Space" ? " " : key,
      code: KEY_CODES[key][0],
      text: KEY_CODES[key][1],
    };
  if (/^[a-z]$/i.test(key))
    return { key, code: `Key${key.toUpperCase()}`, text: key };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, text: key };
  throw new Error(`WebKit: keyboard.press("${key}") has no mapping`);
}

/** The CDP calls the harness makes, mapped onto driver requests. */
class CDPShim {
  constructor(page) {
    this.page = page;
  }
  async send(method, params = {}) {
    const { rpc } = this.page;
    switch (method) {
      case "Input.dispatchKeyEvent": {
        if (params.type === "char") return {};
        const type = params.type === "keyUp" ? "keyUp" : "keyDown";
        await rpc.send("key", { ...params, type });
        return {};
      }
      case "Input.dispatchMouseEvent": {
        // Chrome divides a dispatched wheel delta by the emulated device
        // scale factor; a scenario at 4x relies on it.
        const scale = this.page.view.deviceScaleFactor ?? 1;
        const wheel =
          params.type === "mouseWheel"
            ? {
                deltaX: (params.deltaX ?? 0) / scale,
                deltaY: (params.deltaY ?? 0) / scale,
              }
            : {};
        await rpc.send("mouse", { ...params, ...wheel });
        return {};
      }
      case "Runtime.evaluate":
        try {
          const value = unwrap(
            await rpc.send("eval", {
              body: wrap(`(0, eval)(${JSON.stringify(params.expression)})`),
            }),
          );
          return { result: { type: typeof value, value } };
        } catch (error) {
          return { exceptionDetails: { text: error.message } };
        }
      case "Browser.setDownloadBehavior":
      case "Page.setDownloadBehavior":
        await rpc.send("downloads", {
          dir: params.behavior === "deny" ? null : params.downloadPath,
        });
        return {};
      default:
        throw new Error(`WebKit: CDP ${method} is not supported`);
    }
  }
  async detach() {}
}

class Page {
  constructor(rpc) {
    this.rpc = rpc;
    this.handlers = new Map();
    this.view = { width: 800, height: 600, deviceScaleFactor: 1 };
    this.currentUrl = "about:blank";
    this.styleTags = 0;
    // Beyond puppeteer (harness.mjs uses them on both engines): what the
    // page sent the game app's bridge with its recording host installed
    // (installHost), and whether the page closed its own tab.
    this.hostMessages = [];
    this.closedByPage = false;
    rpc.on("hostmessage", (m) => this.hostMessages.push(m.message));
    // WebKit only: each key the page left unhandled, which came back from
    // the web view to the game app's window class, as { fate, code,
    // repeat }: fate "dropped" (the window kept it from AppKit) or
    // "appkit" (it reached NSWindow's own keyDown).
    this.windowKeys = [];
    rpc.on("windowkey", ({ fate, code, repeat }) =>
      this.windowKeys.push({ fate, code, repeat }),
    );
    // WebKit only: each time a keydown held with ⌘ was offered to the
    // window as a key equivalent, as { code, claimed }. The web view claims
    // it to give the page its turn; a key the page leaves comes back
    // unclaimed, where the game app's main menu gets it.
    this.keyEquivalents = [];
    rpc.on("keyequivalent", ({ code, claimed }) =>
      this.keyEquivalents.push({ code, claimed }),
    );
    rpc.on("windowclose", () => {
      this.closedByPage = true;
      this.fire("close");
    });
    rpc.on("console", (m) =>
      this.fire("console", { type: () => m.type, text: () => m.text }),
    );
    rpc.on("pageerror", (m) => this.fire("pageerror", new Error(m.text)));
    // The host's own failures (it became active, its window had to hide)
    // fail the session's console check.
    for (const event of ["hosterror", "fatal"])
      rpc.on(event, (m) =>
        this.fire(
          "pageerror",
          new Error(`[WebKit driver] ${m.text ?? m.error}`),
        ),
      );
    this.keyboard = {
      press: async (key) => {
        const p = keyParams(key);
        await rpc.send("key", { ...p, type: "keyDown" });
        await rpc.send("key", { ...p, type: "keyUp" });
      },
    };
    // puppeteer's mouse (left button), for the creators' testing library
    // (player/scripts/testing): the wheel and the button act where the
    // last move left the pointer.
    const at = { x: 0, y: 0 };
    const mouse = (type, extra = {}) =>
      rpc.send("mouse", { type, x: at.x, y: at.y, ...extra });
    this.mouse = {
      move: async (x, y) => {
        at.x = x;
        at.y = y;
        await mouse("mouseMoved");
      },
      down: () => mouse("mousePressed"),
      up: () => mouse("mouseReleased"),
      click: async (x, y) => {
        await this.mouse.move(x, y);
        await mouse("mousePressed");
        await mouse("mouseReleased");
      },
      // Divided by the device scale factor, as Chrome does (CDPShim).
      wheel: ({ deltaX = 0, deltaY = 0 } = {}) => {
        const scale = this.view.deviceScaleFactor ?? 1;
        return mouse("mouseWheel", {
          deltaX: deltaX / scale,
          deltaY: deltaY / scale,
        });
      },
    };
  }
  fire(event, value) {
    for (const fn of this.handlers.get(event) ?? []) fn(value);
  }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return this;
  }
  async goto(url) {
    this.currentUrl = await this.rpc.send("goto", { url });
    return null;
  }
  async reload() {
    await this.rpc.send("reload");
    return null;
  }
  /** The next finished navigation (load + first presentation), any cause. */
  waitForNavigation(options = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("waitForNavigation timed out")),
        options.timeout ?? PROTOCOL_TIMEOUT_MS,
      );
      this.rpc.once("navigated", (m) => {
        clearTimeout(timer);
        this.currentUrl = m.url;
        resolve(null);
      });
    });
  }
  url() {
    return this.currentUrl;
  }
  /** True once the page's window.close() was allowed (a tab would go). */
  isClosed() {
    return this.closedByPage;
  }
  /**
   * The game app's page-to-host bridge (apps/macos/WebViewSetup.swift)
   * with a recording host, before the first goto: `display` is the mode
   * it starts in; each message the page sends lands in hostMessages.
   * `voice: true` also gives it the app's own voice host
   * (apps/macos/VoiceEngine.swift), set up from the environment the driver
   * started with (launchWebKit's `env`): the page gets `voice: true` and
   * its voice messages go there, not to hostMessages.
   */
  async installHost(kind, display, { voice = false } = {}) {
    await this.rpc.send("host", { kind, display, voice });
  }
  /** The host's display mode changed, as the reader's own control would. */
  async setHostDisplay(mode) {
    await this.rpc.send("hostDisplay", { mode });
  }
  /**
   * Beyond puppeteer: hides (false) or shows (true) the page, as minimising
   * the game app's window would; resolves with the page's
   * `document.visibilityState` once it has changed.
   */
  setVisible(visible) {
    return this.rpc.send("visible", { visible });
  }
  async evaluate(fn, ...args) {
    return unwrap(
      await this.rpc.send("eval", { body: wrap(callOf(fn, args)) }),
    );
  }
  async evaluateOnNewDocument(fn, ...args) {
    await this.rpc.send("addScript", {
      source:
        typeof fn === "function"
          ? `(${fn.toString()})(...${JSON.stringify(args)});`
          : fn,
    });
  }
  /** Polls in the page until `fn` is truthy; re-arms across navigations. */
  async waitForFunction(fn, options = {}, ...args) {
    const timeout = options.timeout ?? PROTOCOL_TIMEOUT_MS;
    const interval = typeof options.polling === "number" ? options.polling : 10;
    const deadline = Date.now() + timeout;
    let lastError = null;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `Waiting failed: ${timeout}ms exceeded${lastError ? ` (last error: ${lastError})` : ""}`,
        );
      }
      const body = `const __t0 = performance.now(); for (;;) { const __v = await ${callOf(fn, args)}; if (__v) return JSON.stringify({ v: __v }); if (performance.now() - __t0 > ${left}) return JSON.stringify({ timeout: 1 }); await new Promise((r) => setTimeout(r, ${interval})); }`;
      try {
        const parsed = JSON.parse(
          await this.rpc.send("eval", { body }, left + PROTOCOL_TIMEOUT_MS),
        );
        if (!parsed.timeout)
          return { jsonValue: async () => parsed.v, dispose: async () => {} };
      } catch (error) {
        // A navigation under the wait, or a predicate that throws: retry
        // until the deadline, as puppeteer does.
        lastError = error.message;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
  /** Adds a <style>; returns a handle whose evaluate(fn) gets the element. */
  async addStyleTag({ content }) {
    this.styleTags += 1;
    const tag = `kdrv-style-${this.styleTags}`;
    await this.evaluate(
      (css, id) => {
        const style = document.createElement("style");
        style.textContent = css;
        style.dataset.kdrv = id;
        document.head.append(style);
      },
      content,
      tag,
    );
    return {
      evaluate: (fn, ...args) =>
        this.evaluate(
          `(${fn.toString()})(document.querySelector('[data-kdrv="${tag}"]'), ...${JSON.stringify(args)})`,
        ),
      dispose: async () => {},
    };
  }
  async setViewport(viewport) {
    this.view = { deviceScaleFactor: 1, ...viewport };
    await this.rpc.send("viewport", {
      width: viewport.width,
      height: viewport.height,
      scale: this.view.deviceScaleFactor,
    });
  }
  viewport() {
    return this.view;
  }
  async screenshot(options = {}) {
    const base64 = await this.rpc.send("screenshot", { clip: options.clip });
    const buffer = Buffer.from(base64, "base64");
    if (options.path) writeFileSync(options.path, buffer);
    return options.encoding === "base64" ? base64 : buffer;
  }
  waitForFileChooser(options = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("waitForFileChooser timed out")),
        options.timeout ?? PROTOCOL_TIMEOUT_MS,
      );
      this.rpc.once("filechooser", () => {
        clearTimeout(timer);
        resolve({
          accept: (files) => this.rpc.send("chooser", { files }),
          cancel: () => this.rpc.send("chooser", { files: null }),
        });
      });
    });
  }
  async createCDPSession() {
    return new CDPShim(this);
  }
  async close() {}
}

/**
 * One driver process: one fresh profile and one page, like one
 * puppeteer.launch() with its first page. `profile` (a folder) keeps the
 * page's storage on disk there instead, so a later launch with the same
 * folder resumes it. `requireGestureForAudio` makes sound wait for a key or
 * click, as Safari does (test only: the game app plays sound at launch).
 * `env` adds variables to the driver's environment (the voice host's test
 * overrides, KINETIC_VOICE_DIR and the rest: apps/README.md).
 * Its page gets the test sound flag before anything loads (testaudio.mjs).
 * Throws, with the driver killed, when the driver cannot start, would show
 * its window, or lacks a hook.
 */
export async function launchWebKit(options = {}) {
  // `command` stands in for the driver in the adapter's own tests.
  const [file, ...args] = options.command ?? [ensureDriver()];
  if (options.profile) args.push(`--profile=${options.profile}`);
  if (options.requireGestureForAudio) args.push("--require-gesture-for-audio");
  const proc = spawn(file, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...options.env },
  });
  const rpc = connect(proc);
  let timer;
  let ready;
  try {
    ready = await Promise.race([
      rpc.started,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `WebKit driver sent no ready line in ${START_TIMEOUT_MS} ms`,
              ),
            ),
          START_TIMEOUT_MS,
        );
      }),
    ]);
    const missing = REQUIRED_HOOKS.filter(
      (name) => ready.hooks?.[name] !== true,
    );
    if (missing.length > 0) {
      throw new Error(
        `WebKit driver: this macOS's WebKit lacks the private hook${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, which the WebKit engine needs to give true results. Run the suite on Chrome (without --webkit).`,
      );
    }
    if (ready.hooks?.[MUTE_HOOK] !== true) {
      throw new Error(
        `WebKit driver: this macOS's WebKit lacks the private hook ${MUTE_HOOK}, which keeps the WebKit engine silent; it would play sound aloud. Run on Chrome (without --webkit).`,
      );
    }
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
  // Before any page loads: the player holds its master gain at 0, as the
  // page mute is not shown to silence Web Audio (testaudio.mjs).
  await rpc.send("addScript", { source: TEST_AUDIO_SCRIPT });
  const page = new Page(rpc);
  const contexts = new Set();
  const browser = {
    ready,
    process: () => proc,
    newPage: async () => page,
    pages: async () => [page],
    target: () => ({ createCDPSession: async () => new CDPShim(page) }),
    // A fresh profile is a fresh driver process.
    createBrowserContext: async () => {
      const other = await launchWebKit({ ...options, profile: undefined });
      contexts.add(other);
      return { newPage: () => other.newPage(), close: () => other.close() };
    },
    disconnect: async () => {},
    close: async () => {
      await Promise.all([...contexts].map((c) => c.close()));
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      rpc.send("quit").catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    },
  };
  return browser;
}
