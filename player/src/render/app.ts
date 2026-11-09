// The shell that binds machine state to the DOM (docs/plan.md Phase 5). The
// subscribe/notify seam is the only coupling to the machine: this module reads
// state, it never mutates it, and the leaf renderers stay independent of each
// other and of the machine's commands.

import type { Machine } from "../machine/machine";
import type { MachineState, Manifest } from "../machine/types";
import { endCardText } from "./endcard";
import { createTextOverlayLayer } from "./overlay";
import { createVisualLayer } from "./visual";

/** A route announcement pill's visible hold (docs/plan.md Phase 18). */
export const ROUTE_PILL_MS = 1600;

/**
 * The hold of a notice the reader must read to the end or act on (an
 * Import refusal, a tab that will not close itself): longer than a mode
 * pill's, which names one word of state.
 */
export const NOTICE_LONG_MS = 4000;

/**
 * The pill never covers a choice screen with news the reader did not ask
 * for (docs/progress.md): `#choice` fills the window, so no spot is clear
 * of its title, hint and rows. A choice opening drops the pill on screen
 * and any route message still queued — the leftover "Route: <label>" of a
 * short route that has just ended — and no route pill shows while the
 * choice is open; a pick closes it before its route pill shows, and `b` is
 * inert there. The MODE pills are the exception (docs/plan.md Phase 43):
 * `a` and Tab work on a choice screen, and a skip burst can stop at one, so
 * "Auto-forward on/off" and "Skip on/off" (`mode`) show over it — the
 * brief cover answers the reader's own key, or says honestly that skip
 * stopped there. The branch map is covered for every pill (docs/plan.md
 * Phase 31): opening it drops a pill still holding, none shows while it is
 * up, and a map jump closes it before its route pill.
 */
export interface PillGate {
  /** Report the choice screen's state; true when the pill must go now. */
  choiceChanged(open: boolean): boolean;
  /**
   * Report whether a panel the pill must not cover (the branch map) is up;
   * true when the pill must go now.
   */
  coverChanged(covered: boolean): boolean;
  /**
   * Whether a pill may show now; a `mode` pill may show over an open
   * choice, never over the map.
   */
  mayShow(mode?: boolean): boolean;
}

export function createPillGate(): PillGate {
  let choiceOpen = false;
  let coveredNow = false;
  return {
    choiceChanged(open) {
      const opened = open && !choiceOpen;
      choiceOpen = open;
      return opened;
    },
    coverChanged(covered) {
      const opened = covered && !coveredNow;
      coveredNow = covered;
      return opened;
    },
    mayShow(mode = false) {
      return !coveredNow && (mode || !choiceOpen);
    },
  };
}

/**
 * One queued pill: its text, and whether it is a mode pill ("Skip on",
 * "Auto-forward off"…) or a notice answering the reader's own click on the
 * Esc screen ("Progress exported"), either of which may cover a choice and
 * leads its sequence. `holdMs`, when given, is how long it holds before
 * the next message shows (the queue's hold otherwise).
 */
export interface PillMessage {
  readonly text: string;
  readonly mode: boolean;
  readonly holdMs?: number;
}

/** The timers and the pill itself, injected so the queue is testable. */
export interface PillQueueIo {
  /** Run `fn` once the current task's own work is done (a microtask). */
  defer(fn: () => void): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  show(message: PillMessage): void;
}

/**
 * The route pill's queue (`flashSequence`). Announcements made in the same
 * task (docs/plan.md Phase 43) join ONE sequence, each message holding
 * `holdMs` before the next, rather than the later wiping the earlier
 * unseen. The mode pills lead, in the order made, then the route pills: a
 * mode pill answers the key just pressed, so it shows at once — Space
 * stopping a skip burst in auto-forward says "Skip off" then "Auto-forward
 * off", and a pick whose armed skip cannot run says "Skip off" then its
 * "Route: <label>". A later task's announcement still wins over whatever
 * is queued (Phase 18). A message given its own hold keeps the next one
 * waiting that long.
 */
export interface PillQueue {
  add(messages: readonly string[], mode: boolean, holdMs?: number): void;
  /** A choice opened: drop every queued message but the mode pills. */
  dropGated(): void;
  /** Drop every queued message (the map opened, unmount). */
  dropAll(): void;
}

export function createPillQueue(
  io: PillQueueIo,
  holdMs: number = ROUTE_PILL_MS,
): PillQueue {
  // This task's announcements, until the deferred start schedules them.
  let batch: PillMessage[] | null = null;
  // Scheduled messages not shown yet.
  let queued: { handle: unknown; message: PillMessage }[] = [];

  function cancel(keep: (message: PillMessage) => boolean): void {
    queued = queued.filter((entry) => {
      if (keep(entry.message)) return true;
      io.clearTimer(entry.handle);
      return false;
    });
  }

  function start(): void {
    const messages = batch ?? [];
    batch = null;
    if (messages.length === 0) return;
    cancel(() => false); // the newest announcement wins
    const ordered = [
      ...messages.filter((message) => message.mode),
      ...messages.filter((message) => !message.mode),
    ];
    let at = 0;
    for (const message of ordered) {
      const entry = { handle: null as unknown, message };
      entry.handle = io.setTimer(() => {
        queued = queued.filter((other) => other !== entry);
        io.show(message);
      }, at);
      queued.push(entry);
      at += message.holdMs ?? holdMs;
    }
  }

  return {
    add(messages, mode, ownHoldMs) {
      if (batch === null) {
        batch = [];
        io.defer(start);
      }
      for (const text of messages) {
        batch.push(
          ownHoldMs === undefined
            ? { text, mode }
            : { text, mode, holdMs: ownHoldMs },
        );
      }
    },
    dropGated() {
      if (batch !== null) batch = batch.filter((message) => message.mode);
      cancel((message) => message.mode);
    },
    dropAll() {
      if (batch !== null) batch = [];
      cancel(() => false);
    },
  };
}

export interface Shell {
  /** The `h` toggle: hide or show the text overlay, visual untouched. */
  toggleText(): void;
  setTextVisible(visible: boolean): void;
  isTextVisible(): boolean;
  /**
   * The key help's black screen (docs/plan.md Phase 13b): false hides the
   * whole stage — media included, playing elements — while the help is up;
   * true restores it. The hidden attribute, with `.stage[hidden]` declared
   * in index.html so the panel-level rule beats `.display` of `.stage`.
   */
  setStageVisible(visible: boolean): void;
  /**
   * The Esc screen's and the branch map's timeline pause (docs/plan.md Phase 18): true
   * holds a playing video in place, false lets it play on.
   */
  setMediaPaused(paused: boolean): void;
  /** The visual element currently painted, for `b`-key thumbnail capture. */
  currentVisual(): HTMLImageElement | HTMLVideoElement | null;
  /**
   * A small transient notice — the `b` confirmation flash (Phase 8). It is
   * its own element, outside `#overlay`, so `h` never touches it, and it
   * fades and removes itself; nothing lingers on screen.
   */
  flash(message: string): void;
  /**
   * Show several pills in order — the route announcements' "Back to try
   * another route" before its "Route: <label>". Each message holds for
   * ROUTE_PILL_MS (~1.6 s, docs/plan.md Phase 18) before the next replaces
   * it; calls made in the same task join one sequence (`createPillQueue`).
   * `mode` marks a mode pill, which may show over an open choice
   * (`PillGate`) and leads its task's sequence.
   */
  flashSequence(
    messages: readonly string[],
    options?: { mode?: boolean },
  ): void;
  /**
   * A notice answering the reader's own click on the Esc screen ("Progress
   * exported", an Import refusal, a tab that will not close): the pill,
   * queued as a mode pill is (it may show over the choice the screen
   * covers, and leads its task's sequence), held `holdMs` (ROUTE_PILL_MS
   * by default; NOTICE_LONG_MS for text to read to the end). The pill is
   * hidden from assistive tech, so a polite status region says it too.
   * Nothing on the Esc screen moves for it.
   */
  notify(message: string, options?: { holdMs?: number }): void;
  /**
   * A full-screen panel that the pill must not cover (the branch map) has
   * opened (true): the pill and its queued messages go, and no pill shows
   * until it closes (false).
   */
  setPillsCovered(covered: boolean): void;
  /**
   * A quiet standing notice (`#notice`, the resume notice of docs/plan.md
   * Phase 18): it stays until the reader's next key, click or wheel notch,
   * and yields to the end card, which already offers the same key.
   */
  showNotice(message: string): void;
  unmount(): void;
}

export interface ShellOptions {
  /** The `#app` element from index.html. */
  root: HTMLElement;
  manifest: Manifest;
  machine: Machine;
}

export function mountShell({ root, manifest, machine }: ShellOptions): Shell {
  const doc = root.ownerDocument;
  const stage = doc.createElement("div");
  stage.id = "stage";
  stage.className = "stage";
  const overlay = doc.createElement("div");
  overlay.id = "overlay";
  overlay.className = "overlay";
  // The end card (docs/plan.md Phase 18, "End card"): a small quiet panel
  // while an ending shows — how many routes (and other content) are still
  // unseen and the `u` key to the next, or that everything has been seen.
  // Outside `#overlay` so the caption layer never repaints it; `h` hides it
  // with the captions.
  const quietStyle = {
    position: "fixed",
    top: "3%",
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: "min(90vw, 36em)",
    textAlign: "center",
    color: "rgba(244, 239, 230, 0.86)",
    textShadow: "0 1px 3px rgba(0, 0, 0, 0.9)",
    font: "400 clamp(12px, 1.5vh, 16px)/1.35 ui-sans-serif, system-ui, sans-serif",
    letterSpacing: "0.03em",
    pointerEvents: "none",
    userSelect: "none",
    zIndex: "5",
  };
  const endCard = doc.createElement("div");
  endCard.id = "end-card";
  endCard.hidden = true;
  Object.assign(endCard.style, quietStyle, {
    padding: "8px 16px",
    borderRadius: "8px",
    background: "rgba(10, 10, 12, 0.5)",
    border: "1px solid rgba(244, 239, 230, 0.14)",
  });
  const endCardTitle = doc.createElement("div");
  endCardTitle.className = "end-card-title";
  const endCardHint = doc.createElement("div");
  endCardHint.className = "end-card-hint";
  Object.assign(endCardHint.style, {
    marginTop: "2px",
    fontStyle: "italic",
    color: "rgba(244, 239, 230, 0.66)",
  });
  endCard.append(endCardTitle, endCardHint);
  // The resume notice (`showNotice`): one quiet italic line, no panel.
  const notice = doc.createElement("div");
  notice.id = "notice";
  notice.hidden = true;
  Object.assign(notice.style, quietStyle, {
    fontStyle: "italic",
    color: "rgba(244, 239, 230, 0.78)",
  });
  // The notices' words for assistive tech (`notify`): a polite status
  // region present from the start (one added with its text is not reliably
  // read), visually hidden, so it takes no room anywhere.
  const status = doc.createElement("div");
  status.id = "flash-status";
  status.setAttribute("role", "status");
  Object.assign(status.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  });
  root.replaceChildren(stage, overlay, endCard, notice, status);

  const visuals = createVisualLayer(stage, manifest, {
    // A standalone video's `ended` (or an autoplay rejection, see
    // render/visual.ts) is the machine's media-end signal.
    onVideoEnded: () => machine.mediaEnded(),
  });
  const captions = createTextOverlayLayer(overlay);
  let textVisible = true;
  // The decision overlay hides the story text while it waits for an
  // answer (docs/plan.md Phase 13): a caption under the prompt would be
  // the item the decision hangs off, not anything the reader can act on.
  // `h` keeps its own state underneath — closing the choice restores it.
  let choiceOpen = false;
  // A skip burst paces by pictures (docs/plan.md Phase 18): its lines take
  // zero time, so the caption hides while `skipping` and the line the burst
  // stops on shows the moment it ends.
  let skipping = false;
  let endCardDue = false;
  let noticeDue = false;

  function applyCaptions(): void {
    captions.setHidden(!textVisible || choiceOpen || skipping);
    endCard.hidden = !textVisible || !endCardDue;
    notice.hidden = !textVisible || !noticeDue || endCardDue;
  }

  function dismissNotice(): void {
    if (!noticeDue) return;
    noticeDue = false;
    for (const type of ["keydown", "pointerdown", "wheel"]) {
      doc.removeEventListener(type, dismissNotice, true);
    }
    applyCaptions();
  }

  function showNotice(message: string): void {
    notice.textContent = message;
    noticeDue = true;
    for (const type of ["keydown", "pointerdown", "wheel"]) {
      doc.addEventListener(type, dismissNotice, true);
    }
    applyCaptions();
  }

  function render(state: MachineState): void {
    // The visual is the machine's, so a `text` item keeps the earlier media
    // on screen; the caption is the cursor's own line. Playback mode
    // (still / loop-once / loop-forever) derives from the same state.
    visuals.update(manifest.items[machine.visualIndex()], state);
    captions.update(manifest.items[state.cursor]);
    choiceOpen = state.choice !== undefined;
    if (pillGate.choiceChanged(choiceOpen)) {
      // The pill on screen is old news; a mode pill still queued may show
      // over the choice (`PillGate`).
      pills.dropGated();
      clearFlash();
    }
    skipping = state.skipping;
    endCardDue = state.endCard !== undefined;
    if (state.endCard !== undefined) {
      const text = endCardText(state.endCard);
      endCardTitle.textContent = text.title;
      endCardHint.textContent = text.hint ?? "";
      endCardHint.hidden = text.hint === undefined;
    }
    applyCaptions();
    schedulePreload(state);
  }

  // Decode preload (docs/plan.md Phase 12, docs/perf.md): warm the next
  // media files when the machine is idle — the item settled (it waits on
  // the reader) or skip is dwelling — so a file's fetch + decode never
  // lands on the navigation frame. One idle task at a time, reading the
  // cursor WHEN IT RUNS: a fast run of state changes stays one preload, and
  // requestIdleCallback keeps it off busy frames (a ~0 ms timer where the
  // host has no idle API).
  let preloadQueued = false;
  const requestIdle: (fn: () => void) => void =
    typeof globalThis.requestIdleCallback === "function"
      ? (fn) => {
          globalThis.requestIdleCallback(fn, { timeout: 200 });
        }
      : (fn) => {
          globalThis.setTimeout(fn, 0);
        };

  function schedulePreload(state: MachineState): void {
    if (!(state.settled || state.skipping) || preloadQueued) return;
    preloadQueued = true;
    requestIdle(() => {
      preloadQueued = false;
      visuals.preloadUpcoming(machine.getState().cursor);
    });
  }

  function setTextVisible(visible: boolean): void {
    textVisible = visible;
    applyCaptions();
  }

  // The confirmation flash (docs/plan.md Phase 8): a pill centred near the
  // top that fades itself away. Styled inline because the player's contract
  // is "index.html + app.js + manifest.js" — no new file, and `h` never
  // reaches it because it is not the overlay. `#flash` is the driver's
  // selector for "a bookmark was taken".
  let flashElement: HTMLElement | null = null;
  let flashTimers: ReturnType<typeof setTimeout>[] = [];
  const pillGate = createPillGate();
  // The `flashSequence` queue. Its timers live apart from `flashTimers` on
  // purpose: `flash` clears its own pill's timers, and must never cancel
  // the message still queued behind it.
  const pills = createPillQueue({
    defer: (fn) => queueMicrotask(fn),
    setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimer: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    show: (message) =>
      flash(message.text, message.holdMs ?? ROUTE_PILL_MS, message.mode),
  });

  function clearFlash(): void {
    for (const timer of flashTimers) globalThis.clearTimeout(timer);
    flashTimers = [];
    if (flashElement !== null) {
      flashElement.remove();
      flashElement = null;
    }
  }

  function flash(message: string, holdMs = 900, mode = false): void {
    // Never over the map; over a choice screen only a mode pill.
    if (!pillGate.mayShow(mode)) return;
    clearFlash(); // a second `b` replaces the first pill, mid-fade included
    const pill = doc.createElement("div");
    pill.id = "flash";
    pill.setAttribute("aria-hidden", "true"); // a machine echo, not a caption
    pill.textContent = message;
    Object.assign(pill.style, {
      position: "fixed",
      top: "8%",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 18px",
      borderRadius: "999px",
      // Glass over the story; index.html sets --k-pill-bg to a solid
      // chip over the Esc screen, where the pill may cross its title.
      background: "var(--k-pill-bg, rgba(10, 10, 12, 0.72))",
      border: "1px solid rgba(244, 239, 230, 0.22)",
      color: "#f4efe6",
      font: "500 clamp(13px, 1.6vh, 17px)/1.3 ui-sans-serif, system-ui, sans-serif",
      letterSpacing: "0.04em",
      pointerEvents: "none", // clicks pass through to what is under it
      userSelect: "none",
      zIndex: "10",
      opacity: "1",
      transition: "opacity 400ms ease",
    });
    root.appendChild(pill);
    flashElement = pill;
    flashTimers.push(
      globalThis.setTimeout(() => {
        pill.style.opacity = "0";
        flashTimers.push(globalThis.setTimeout(clearFlash, 450));
      }, holdMs),
    );
  }

  function flashSequence(
    messages: readonly string[],
    options: { mode?: boolean } = {},
  ): void {
    // A new announcement wins over the previous sequence's queued messages
    // (they would otherwise land on top of its fresher pill); the same
    // task's announcements play one after another (`createPillQueue`).
    pills.add(messages, options.mode === true);
  }

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(message: string, options: { holdMs?: number } = {}): void {
    pills.add([message], true, options.holdMs);
    // Emptied first and refilled a moment later, so the same notice twice
    // (a second Export) is read out twice.
    globalThis.clearTimeout(statusTimer);
    status.textContent = "";
    statusTimer = globalThis.setTimeout(() => {
      status.textContent = message;
    }, 100);
  }

  const unsubscribe = machine.subscribe(render);
  render(machine.getState());

  return {
    toggleText() {
      setTextVisible(!textVisible);
    },
    setTextVisible,
    isTextVisible() {
      return textVisible;
    },
    setStageVisible(visible: boolean) {
      stage.hidden = !visible; // `.stage[hidden]` in index.html paints black
    },
    setMediaPaused(paused: boolean) {
      visuals.setPaused(paused);
    },
    currentVisual() {
      return visuals.currentVisual();
    },
    flash,
    flashSequence,
    notify,
    setPillsCovered(covered: boolean) {
      if (pillGate.coverChanged(covered)) {
        pills.dropAll();
        clearFlash();
      }
    },
    showNotice,
    unmount() {
      dismissNotice();
      unsubscribe();
      machine.destroy();
      visuals.destroy();
      clearFlash();
      pills.dropAll();
      globalThis.clearTimeout(statusTimer);
      root.replaceChildren();
    },
  };
}

/** Renders a load failure in place of content. Never touches the console. */
export function mountError(root: HTMLElement, message: string): void {
  const notice = root.ownerDocument.createElement("div");
  notice.id = "error-state";
  notice.className = "notice";
  notice.textContent = message;
  root.replaceChildren(notice);
}
