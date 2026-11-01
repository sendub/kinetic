// The `c` config screen (docs/plan.md Phase 9, README `c` bullet): a
// minimal panel holding the player's settings — the configurable reading
// speed (its stepper maps to `readingSpeed`, 0.25-3.0 in 0.25 steps, and
// the readout shows the multiplier and the per-character allowance it
// gives), the `tab` bullet's "skip all" config option (the `skipAll`
// boolean), and Phase 13's `playAllRoutes` zero-interactivity route
// playback. No other UI.
//
// Every control click produces the full next settings through `onChange`,
// so the shell applies it live (machine.setSettings) and persists it from
// one place; the panel never reads storage. Like the bookmark panel, the
// pure rules are exported and tested below, and the DOM half only applies
// them. While the panel is open the timeline is suspended (keys.ts
// suspendTimeline); `c` or Escape closes it, as does a click outside the
// two controls (backdrop).

import type { MachineSettings } from "../machine/types";

/** The reading-speed range the stepper walks, and its step. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 3.0;
export const SPEED_STEP = 0.25;

/**
 * One stepper press: `delta` steps of SPEED_STEP, snapped back onto the
 * 0.25 grid (a persisted or hand-built value cannot walk off it) and
 * clamped to [SPEED_MIN, SPEED_MAX].
 */
export function stepSpeed(current: number, delta: number): number {
  const moved =
    Math.round((current + delta * SPEED_STEP) / SPEED_STEP) * SPEED_STEP;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, moved));
}

/**
 * The readout beside the stepper: the multiplier and the approximate
 * milliseconds per code point it gives (base `msPerChar` / speed) — the
 * hold rule of docs/content-format.md, "Timing", in one line.
 */
export function speedLabel(readingSpeed: number, msPerChar: number): string {
  const perChar = Math.round(msPerChar / readingSpeed);
  return `${readingSpeed.toFixed(2)}x — ~${String(perChar)} ms/char`;
}

/** The skip-all switch's text state, mirroring its aria-pressed value. */
export function skipAllLabel(skipAll: boolean): string {
  return skipAll ? "On" : "Off";
}

/** The play-all-routes switch's text state, same two states (Phase 13). */
export function playAllLabel(playAllRoutes: boolean): string {
  return playAllRoutes ? "On" : "Off";
}

export interface ConfigOverlay {
  isOpen(): boolean;
  /** Shows the panel, filled with the current settings. */
  open(): void;
  close(): void;
}

export interface ConfigOverlayOptions {
  /** The `#app` element; the panel is its sibling, as the bookmark panel's. */
  root: HTMLElement;
  /** The settings in force, read fresh whenever the panel opens. */
  settings(): MachineSettings;
  /** A control moved: the full next settings, for live apply and persist. */
  onChange(next: MachineSettings): void;
}

export function mountConfigOverlay({
  root,
  settings,
  onChange,
}: ConfigOverlayOptions): ConfigOverlay {
  const doc = root.ownerDocument;

  const panel = doc.createElement("div");
  panel.id = "config";
  panel.className = "config";
  panel.hidden = true; // `c` opens; `c`, Escape or a backdrop click closes

  const title = doc.createElement("h2");
  title.className = "config-title";
  title.textContent = "Config";

  const hint = doc.createElement("p");
  hint.className = "config-hint";
  hint.textContent = "click a control to change it · c or Esc closes";

  const speedRow = doc.createElement("div");
  speedRow.className = "config-row";
  const speedLabelEl = doc.createElement("span");
  speedLabelEl.className = "config-label";
  speedLabelEl.textContent = "Reading speed";
  const speedDown = doc.createElement("button");
  speedDown.className = "config-step";
  speedDown.type = "button";
  speedDown.textContent = "−";
  speedDown.setAttribute("aria-label", "Decrease reading speed");
  speedDown.setAttribute("data-config-action", "speed-down");
  const speedValue = doc.createElement("span");
  speedValue.className = "config-value config-speed-value";
  const speedUp = doc.createElement("button");
  speedUp.className = "config-step";
  speedUp.type = "button";
  speedUp.textContent = "+";
  speedUp.setAttribute("aria-label", "Increase reading speed");
  speedUp.setAttribute("data-config-action", "speed-up");
  speedRow.append(speedLabelEl, speedDown, speedValue, speedUp);

  const skipRow = doc.createElement("div");
  skipRow.className = "config-row";
  const skipLabelEl = doc.createElement("span");
  skipLabelEl.className = "config-label";
  skipLabelEl.textContent = "Skip all";
  const skipToggle = doc.createElement("button");
  skipToggle.className = "config-toggle config-skip-all";
  skipToggle.type = "button";
  skipToggle.setAttribute("role", "switch");
  skipToggle.setAttribute("data-config-action", "skip-all");
  skipRow.append(skipLabelEl, skipToggle);

  // `Play all routes` (docs/plan.md Phase 13): zero-interactivity route
  // playback, its own persisted setting like skip-all.
  const playRow = doc.createElement("div");
  playRow.className = "config-row";
  const playLabelEl = doc.createElement("span");
  playLabelEl.className = "config-label";
  playLabelEl.textContent = "Play all routes";
  const playToggle = doc.createElement("button");
  playToggle.className = "config-toggle config-play-all";
  playToggle.type = "button";
  playToggle.setAttribute("role", "switch");
  playToggle.setAttribute("data-config-action", "play-all");
  playRow.append(playLabelEl, playToggle);

  panel.append(title, hint, speedRow, skipRow, playRow);
  root.appendChild(panel);

  // The values on show, kept so the next control click edits the whole
  // settings object; refreshed from the shell on every open.
  let current: MachineSettings = settings();

  function paint(next: MachineSettings): void {
    current = next;
    speedValue.textContent = speedLabel(next.readingSpeed, next.msPerChar);
    skipToggle.textContent = skipAllLabel(next.skipAll);
    skipToggle.setAttribute("aria-pressed", String(next.skipAll));
    playToggle.textContent = playAllLabel(next.playAllRoutes);
    playToggle.setAttribute("aria-pressed", String(next.playAllRoutes));
  }

  function move(next: MachineSettings): void {
    paint(next);
    onChange(next);
  }

  // One listener for the whole panel, as in bookmarks.ts: a control acts,
  // any other click is backdrop and closes.
  panel.addEventListener("click", (event) => {
    const target = event.target;
    const control =
      target instanceof Element ? target.closest("[data-config-action]") : null;
    if (control === null) {
      close();
      return;
    }
    const action = control.getAttribute("data-config-action");
    if (action === "speed-down") {
      move({ ...current, readingSpeed: stepSpeed(current.readingSpeed, -1) });
    } else if (action === "speed-up") {
      move({ ...current, readingSpeed: stepSpeed(current.readingSpeed, 1) });
    } else if (action === "skip-all") {
      move({ ...current, skipAll: !current.skipAll });
    } else if (action === "play-all") {
      move({ ...current, playAllRoutes: !current.playAllRoutes });
    }
  });

  function close(): void {
    panel.hidden = true;
  }

  paint(current);

  return {
    isOpen() {
      return !panel.hidden;
    },
    open() {
      paint(settings()); // always the values now in force, never a stale copy
      panel.hidden = false;
    },
    close,
  };
}
