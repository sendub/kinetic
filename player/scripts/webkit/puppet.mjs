// The subset of puppeteer's Browser, Page and CDPSession that the scenario
// harness uses, over the WebKit driver (apps/macos/driver, built by
// build.mjs). Scenario files keep their code; harness.openScenario picks
// the engine (KINETIC_ENGINE=webkit). docs/verify-player.md, "WebKit".
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
 * puppeteer.launch() with its first page. Throws, with the driver killed,
 * when the driver cannot start, would show its window, or lacks a hook.
 */
export async function launchWebKit(options = {}) {
  // `command` stands in for the driver in the adapter's own tests.
  const [file, ...args] = options.command ?? [ensureDriver()];
  const proc = spawn(file, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
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
  } catch (error) {
    proc.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
      const other = await launchWebKit(options);
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
