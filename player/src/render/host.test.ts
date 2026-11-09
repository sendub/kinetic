import { describe, expect, it, vi } from "vitest";
import {
  CLOSE_WAIT_MS,
  connectHost,
  type DisplayMode,
  HOST_EVENT,
  type HostMessage,
  type HostWindow,
  readHost,
  type WindowEffects,
  windowActions,
} from "./host";

// The page side of the page-to-host protocol (docs/plan.md Phase 43 item 9):
// the host object read live, its event, the two messages, and the Esc
// screen's window controls deciding between a host and a browser tab.

/** A `window` with an event target and a settable `kineticHost`. */
class FakeWindow implements HostWindow {
  kineticHost?: unknown;
  private readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

/** A host as the apps' bridges build it: a live `display` getter. */
function appHost(display: DisplayMode = "fullscreen") {
  const sent: HostMessage[] = [];
  let mode = display;
  return {
    sent,
    set(next: DisplayMode) {
      mode = next;
    },
    object: {
      kind: "mac-app",
      get display() {
        return mode;
      },
      send(message: HostMessage) {
        sent.push(message);
      },
    },
  };
}

describe("readHost", () => {
  it("reads a host object: its kind, display and send", () => {
    const host = appHost("window");
    const read = readHost(host.object);
    expect(read?.kind).toBe("mac-app");
    expect(read?.display).toBe("window");
    read?.send({ type: "quit" });
    expect(host.sent).toEqual([{ type: "quit" }]);
  });

  it("is no host without a send function, or for a non-object", () => {
    expect(readHost(undefined)).toBeNull();
    expect(readHost(null)).toBeNull();
    expect(readHost("mac-app")).toBeNull();
    expect(readHost({ kind: "mac-app", display: "window" })).toBeNull();
    expect(readHost({ send: "nope" })).toBeNull();
  });

  it("reads any display but window as fullscreen, and any kind as a host", () => {
    const send = () => {};
    expect(readHost({ send, display: "big" })?.display).toBe("fullscreen");
    expect(readHost({ send })?.display).toBe("fullscreen");
    expect(readHost({ kind: "windows-app", send })?.kind).toBe("windows-app");
    expect(readHost({ kind: 7, send })?.kind).toBe("");
  });

  it("reads a host whose getter throws as no host", () => {
    const object = {
      send() {},
      get display(): string {
        throw new Error("gone");
      },
    };
    expect(readHost(object)).toBeNull();
  });
});

describe("connectHost", () => {
  it("is no host in a browser tab: nothing is sent", () => {
    const link = connectHost(new FakeWindow());
    expect(link.host()).toBeNull();
    expect(link.quit()).toBe(false);
    expect(link.setDisplay("window")).toBe(false);
  });

  it("sends the two message shapes to the host", () => {
    const win = new FakeWindow();
    const host = appHost();
    win.kineticHost = host.object;
    const link = connectHost(win);
    expect(link.quit()).toBe(true);
    expect(link.setDisplay("window")).toBe(true);
    expect(link.setDisplay("fullscreen")).toBe(true);
    expect(host.sent).toEqual([
      { type: "quit" },
      { type: "display", mode: "window" },
      { type: "display", mode: "fullscreen" },
    ]);
  });

  it("finds a host that arrives after load, and tells subscribers on its event", () => {
    const win = new FakeWindow();
    const link = connectHost(win);
    const heard = vi.fn();
    link.subscribe(heard);
    expect(link.host()).toBeNull();
    const host = appHost();
    win.kineticHost = host.object;
    win.fire(HOST_EVENT);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(link.host()?.display).toBe("fullscreen");
    expect(link.quit()).toBe(true);
    expect(host.sent).toEqual([{ type: "quit" }]);
  });

  it("reads the display live, as the host changes it in place", () => {
    const win = new FakeWindow();
    const host = appHost("fullscreen");
    win.kineticHost = host.object;
    const link = connectHost(win);
    host.set("window");
    win.fire(HOST_EVENT);
    expect(link.host()?.display).toBe("window");
  });

  it("stops telling a subscriber that unsubscribed", () => {
    const win = new FakeWindow();
    const link = connectHost(win);
    const heard = vi.fn();
    const stop = link.subscribe(heard);
    stop();
    win.fire(HOST_EVENT);
    expect(heard).not.toHaveBeenCalled();
  });

  it("swallows a send that throws: the page carries on", () => {
    const win = new FakeWindow();
    win.kineticHost = {
      send() {
        throw new Error("bridge gone");
      },
    };
    const link = connectHost(win);
    expect(() => link.quit()).not.toThrow();
    expect(link.quit()).toBe(true);
  });
});

/** WindowEffects over a fake link, recording every effect. */
function effects(options: {
  host?: ReturnType<typeof appHost>;
  setting?: DisplayMode;
  fullscreen?: boolean;
  closable?: boolean;
}) {
  const win = new FakeWindow();
  if (options.host !== undefined) win.kineticHost = options.host.object;
  const log: string[] = [];
  const timers: (() => void)[] = [];
  let setting = options.setting ?? "fullscreen";
  let fullscreen = options.fullscreen ?? false;
  const fx: WindowEffects = {
    link: connectHost(win),
    setting: () => setting,
    saveSetting: (mode) => {
      setting = mode;
      log.push(`save ${mode}`);
    },
    isFullscreen: () => fullscreen,
    enterFullscreen: () => {
      fullscreen = true;
      log.push("enter");
    },
    exitFullscreen: () => {
      fullscreen = false;
      log.push("exit");
    },
    tabClosable: () => options.closable ?? false,
    closeTab: () => log.push("close"),
    later: (run, ms) => {
      log.push(`wait ${ms}`);
      timers.push(run);
    },
    tabStayed: () => log.push("stayed"),
  };
  return { fx, log, timers, win };
}

describe("windowActions with a host (a game app)", () => {
  it("shows the host's display mode, following its changes", () => {
    const host = appHost("fullscreen");
    const { fx, win } = effects({ host, setting: "window" });
    const actions = windowActions(fx);
    expect(actions.shown()).toBe("fullscreen");
    host.set("window");
    win.fire(HOST_EVENT);
    expect(actions.shown()).toBe("window");
  });

  it("asks the host for the other mode and never uses element fullscreen", () => {
    const host = appHost("fullscreen");
    const { fx, log } = effects({ host });
    const actions = windowActions(fx);
    actions.choose("window");
    expect(host.sent).toEqual([{ type: "display", mode: "window" }]);
    // The page waits for the host to switch: nothing changes here.
    expect(log).toEqual([]);
    expect(actions.shown()).toBe("fullscreen");
  });

  it("sends nothing for the pressed half", () => {
    const host = appHost("window");
    const { fx, log } = effects({ host });
    windowActions(fx).choose("window");
    expect(host.sent).toEqual([]);
    expect(log).toEqual([]);
  });

  it("Exit sends quit and touches no tab", () => {
    const host = appHost();
    const { fx, log } = effects({ host, closable: true });
    windowActions(fx).exit();
    expect(host.sent).toEqual([{ type: "quit" }]);
    expect(log).toEqual([]);
  });
});

describe("windowActions in a browser tab (no host)", () => {
  it("shows the tab's Display setting", () => {
    expect(windowActions(effects({ setting: "window" }).fx).shown()).toBe(
      "window",
    );
    expect(windowActions(effects({ setting: "fullscreen" }).fx).shown()).toBe(
      "fullscreen",
    );
  });

  it("Window saves the setting and leaves fullscreen", () => {
    const { fx, log } = effects({ setting: "fullscreen", fullscreen: true });
    const actions = windowActions(fx);
    actions.choose("window");
    expect(log).toEqual(["save window", "exit"]);
    expect(actions.shown()).toBe("window");
  });

  it("Fullscreen saves the setting and asks for fullscreen (the click is the gesture)", () => {
    const { fx, log } = effects({ setting: "window", fullscreen: false });
    windowActions(fx).choose("fullscreen");
    expect(log).toEqual(["save fullscreen", "enter"]);
  });

  it("the pressed Fullscreen half asks again when the reader has left fullscreen", () => {
    const { fx, log } = effects({ setting: "fullscreen", fullscreen: false });
    windowActions(fx).choose("fullscreen");
    expect(log).toEqual(["enter"]);
  });

  it("the pressed half in the mode already shown changes nothing", () => {
    const full = effects({ setting: "fullscreen", fullscreen: true });
    windowActions(full.fx).choose("fullscreen");
    const windowed = effects({ setting: "window", fullscreen: false });
    windowActions(windowed.fx).choose("window");
    expect([...full.log, ...windowed.log]).toEqual([]);
  });

  it("Exit closes a tab the page may close, and says so if it is still there after a moment", () => {
    const { fx, log, timers } = effects({ closable: true });
    windowActions(fx).exit();
    expect(log).toEqual(["close", `wait ${CLOSE_WAIT_MS}`]);
    for (const run of timers) run(); // the tab did not go
    expect(log[log.length - 1]).toBe("stayed");
  });

  it("Exit in a tab the browser will not let close says so at once, trying nothing", () => {
    const { fx, log } = effects({ closable: false });
    windowActions(fx).exit();
    expect(log).toEqual(["stayed"]);
  });
});
