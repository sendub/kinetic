// The page side of the page-to-host protocol (docs/plan.md Phase 43 item 9;
// apps/README.md). A game app (the macOS app, the Windows exe) gives the
// page `window.kineticHost = { kind, display, send(message) }` and fires a
// `kinetic-host` event on `window` whenever the object appears or its
// `display` changes, including a change the reader makes with the system's
// own controls. The object may arrive after the page loads. The page sends
// `{ type: "quit" }` and `{ type: "display", mode }`; the host owns the
// display mode and its memory.
//
// In a browser tab there is no host: the page owns a Display setting (kept
// with the other settings) and uses the Fullscreen API. With a host present
// the page never asks for element fullscreen. Every host kind behaves the
// same from the page's side.
//
// `windowActions` holds the Esc screen's two decisions (what the Fullscreen
// / Window switch shows and does, what Exit does) over injected effects,
// so both routes are unit-tested without a browser.

/** The two display modes: the protocol's words, and the switch's halves. */
export type DisplayMode = "fullscreen" | "window";

/** What the page may send its host. */
export type HostMessage =
  | { readonly type: "quit" }
  | { readonly type: "display"; readonly mode: DisplayMode };

/** The host object as the page reads it. */
export interface KineticHost {
  /** Which host: `"mac-app"` or `"windows-app"` (the page treats all alike). */
  readonly kind: string;
  /** The display mode the host is in now. */
  readonly display: DisplayMode;
  send(message: HostMessage): void;
}

/** The event a host fires on `window` when it appears or its display changes. */
export const HOST_EVENT = "kinetic-host";

/**
 * `value` (the page's `window.kineticHost`) as a host, or null when it is
 * not one: a host has a `send` function. A display other than `"window"`
 * reads as fullscreen, the apps' start. Never throws (a getter that throws
 * reads as no host).
 */
export function readHost(value: unknown): KineticHost | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as {
      kind?: unknown;
      display?: unknown;
      send?: unknown;
    };
    const send = candidate.send;
    if (typeof send !== "function") return null;
    return {
      kind: typeof candidate.kind === "string" ? candidate.kind : "",
      display: candidate.display === "window" ? "window" : "fullscreen",
      send: (message) => {
        send.call(value, message);
      },
    };
  } catch {
    return null;
  }
}

/** The page's live link to its host, if any. */
export interface HostLink {
  /** The host as it is now; null in a browser tab. */
  host(): KineticHost | null;
  /** Calls `listener` on every `kinetic-host` event. */
  subscribe(listener: () => void): () => void;
  /** Asks the host to quit; false when there is no host. */
  quit(): boolean;
  /** Asks the host for a display mode; false when there is no host. */
  setDisplay(mode: DisplayMode): boolean;
}

/** The slice of `window` the link reads. */
export interface HostWindow {
  readonly kineticHost?: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/**
 * Reads `win.kineticHost` whenever asked (so an object that arrives after
 * load, or a display the host changed in place, is seen) and tells its
 * subscribers on every `kinetic-host` event. A message that the host's
 * `send` refuses (it throws) is dropped quietly: the console stays clean,
 * and the page carries on as before.
 */
export function connectHost(win: HostWindow): HostLink {
  const listeners = new Set<() => void>();
  win.addEventListener(HOST_EVENT, () => {
    for (const listener of [...listeners]) listener();
  });
  const host = (): KineticHost | null => readHost(win.kineticHost);
  const send = (message: HostMessage): boolean => {
    const current = host();
    if (current === null) return false;
    try {
      current.send(message);
    } catch {
      // A host that refuses the message leaves things as they are.
    }
    return true;
  };
  return {
    host,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    quit: () => send({ type: "quit" }),
    setDisplay: (mode) => send({ type: "display", mode }),
  };
}

/** What the Esc screen's window controls act through (main.ts wires it). */
export interface WindowEffects {
  readonly link: HostLink;
  /** The browser tab's Display setting (no host). */
  setting(): DisplayMode;
  /** Keeps a new Display setting (persisted with the other settings). */
  saveSetting(mode: DisplayMode): void;
  /** Whether the page is in element fullscreen now. */
  isFullscreen(): boolean;
  /** Asks for element fullscreen (the click on the switch is the gesture). */
  enterFullscreen(): void;
  exitFullscreen(): void;
  /**
   * Whether the browser lets this page close its own tab: a tab with one
   * history entry, or one a script opened (the rule Chrome, Safari and
   * Firefox share). A refused `window.close()` logs a console warning, so
   * it is only tried where it can work.
   */
  tabClosable(): boolean;
  closeTab(): void;
  /** Runs `run` after `ms`; used to see whether the tab really closed. */
  later(run: () => void, ms: number): void;
  /** The tab is still here: say so (the shell's pill, over the Esc screen). */
  tabStayed(): void;
}

/** How long Exit waits for a closing tab before saying it stayed. */
export const CLOSE_WAIT_MS = 400;

export interface WindowActions {
  /** The switch's pressed half: the host's mode, else the tab's setting. */
  shown(): DisplayMode;
  /** A click on a half of the switch. */
  choose(mode: DisplayMode): void;
  /** Exit: the host quits, else the tab closes or says it cannot. */
  exit(): void;
}

export function windowActions(effects: WindowEffects): WindowActions {
  return {
    shown() {
      return effects.link.host()?.display ?? effects.setting();
    },
    choose(mode) {
      const host = effects.link.host();
      if (host !== null) {
        // The host switches and tells the page (`kinetic-host`); the page
        // never asks for element fullscreen under a host.
        if (host.display !== mode) effects.link.setDisplay(mode);
        return;
      }
      if (effects.setting() !== mode) effects.saveSetting(mode);
      if (mode === "fullscreen") {
        if (!effects.isFullscreen()) effects.enterFullscreen();
      } else if (effects.isFullscreen()) {
        effects.exitFullscreen();
      }
    },
    exit() {
      if (effects.link.quit()) return;
      if (!effects.tabClosable()) {
        effects.tabStayed();
        return;
      }
      effects.closeTab();
      // A closed tab runs no more timers; one still here was refused.
      effects.later(() => effects.tabStayed(), CLOSE_WAIT_MS);
    },
  };
}
