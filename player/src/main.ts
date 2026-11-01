// Kinetic player entry point (docs/plan.md Phases 5, 8, 9, 13, 13b, 14): load
// the manifest, build the timeline machine — resuming from the persisted
// route-play context, falling back to the legacy frontier for pre-ctx
// records, and starting on the persisted settings when either exists —
// mount the render shell, install the input map, and wire storage: the
// machine context (with the derived legacy frontier) is written the moment
// the reader moves — Phase 14: no debounce, because a write issued on the
// change is the only one a reload a moment later can find —, `b` appends a
// bookmark that captures the current context and confirms only once both
// writes commit,
// `t` opens the bookmark list, and `c` opens the config screen, whose
// changes apply live (machine.setSettings) and persist with the context.
// Phase 13b adds the manual/auto clarity and the `#help` key help: the
// player STARTS manual (README advance bullet; `a` toggles auto-forward),
// and the help screen — the keymap's own table on a black screen — shows
// before any advance until storage says `helpSeen`; opening it pauses the
// machine and hides the stage, closing it resumes the same item. The
// Phase 13 renderer half: the manifest's branch table goes into the
// machine, the `#choice` overlay answers the machine's open decision
// (prompt, numbered routes, return-to-main offer; help can open over it,
// everything else yields to it), the story text hides while it waits, and
// a bookmark restore re-enters the recorded route context.
// Composition only — rendering lives in src/render/, timing in
// src/machine/, storage adapters in src/storage/.

import { createMachine } from "./machine/machine";
import type { MachineSettings } from "./machine/types";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell } from "./render/app";
import { mountBookmarkOverlay } from "./render/bookmarks";
import { captureVisualThumbnail } from "./render/capture";
import {
  enterActionFor,
  inputOwnerFor,
  mountChoiceOverlay,
} from "./render/choice";
import { mountConfigOverlay } from "./render/config";
import { installFirstGestureFullscreen } from "./render/fullscreen";
import { mountHelpOverlay } from "./render/help";
import { installKeyMap, suspendTimeline } from "./render/keys";
import { loadManifest } from "./render/manifest";
import { mountRouteAnnouncements } from "./render/routes";
import { installWheelInput } from "./render/wheel";
import { contentSignature, createIdbStorage } from "./storage/idb";
import { createNoopStorage } from "./storage/noop";
import { createImmediateWriter } from "./storage/persist";
import type { Bookmark, PersistedState } from "./storage/types";
import { helpSeenFrom, resumeOptionsFor } from "./storage/types";

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  return (await response.json()) as unknown;
}

/** JPEG blob -> small data URL, or null. Never throws, never logs. */
function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

/** Id for one bookmark entry; UUID where the host offers one. */
function newBookmarkId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Merge a persisted settings partial over the defaults, field by field:
 * only keys the machine knows, with the type the field has, survive. A
 * record from an older or foreign version therefore degrades to the
 * default of every field it got wrong, never to a NaN speed.
 */
function mergeSettings(
  persisted: Partial<MachineSettings> | undefined,
): MachineSettings {
  const merged = { ...DEFAULT_SETTINGS };
  if (persisted === undefined || persisted === null) return merged;
  for (const field of Object.keys(
    DEFAULT_SETTINGS,
  ) as (keyof MachineSettings)[]) {
    const value = persisted[field];
    if (typeof value !== typeof DEFAULT_SETTINGS[field]) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    // The typeof checks above guarantee value's type matches the field's;
    // the indexed write cannot see that, hence the cast.
    merged[field] = value as never;
  }
  return merged;
}

function start(): void {
  const root = document.getElementById("app");
  if (root === null) {
    return; // index.html without a mount point: nothing to draw into.
  }
  // Fullscreen needs a user gesture; the first key press or click supplies it.
  installFirstGestureFullscreen(document);
  // The manifest contract, with the sources injected so it is testable:
  //   window.KINETIC_MANIFEST ?? await fetch("manifest.json").then(r => r.json())
  void loadManifest({ embedded: window.KINETIC_MANIFEST, fetchJson }).then(
    async (manifest) => {
      // One storage namespace per novel folder (docs/plan.md Phase 8):
      // IndexedDB when the host has it, an in-memory adapter when not, so
      // the player always runs — it just remembers nothing across a reload.
      const storage =
        createIdbStorage(contentSignature(document.baseURI)) ??
        createNoopStorage();
      // Resume: a stored machine context is the reader's position — its
      // `lastShown` is where the load starts, the seen set and route
      // stack arrive with it. A record without ctx (written before
      // Phase 13) keeps the old frontier resume; `resumeOptionsFor`
      // applies that order once: ctx wins over frontier. No record, or
      // an unreadable one, is the first-ever load: item 0.
      const persisted = await storage.loadState().catch(() => null);
      // Settings persist through the `c` screen (docs/plan.md Phase 9):
      // merged over the defaults at machine construction, so a resumed
      // reader reads at the pace they left off at. The machine learns
      // settings only here and through setSettings — never from storage.
      let currentSettings = mergeSettings(persisted?.settings);
      // The key help flag (docs/plan.md Phase 13b): absent in a record —
      // including every record written before 13b — reads as "not seen",
      // so existing readers meet the help exactly once more, then never
      // again. It rides along in every save below, so a close is durable.
      let helpSeen = helpSeenFrom(persisted);
      // The machine starts MANUAL (README advance bullet, docs/plan.md
      // Phase 13b): only the reader's presses move it until `a` turns
      // auto-forward on. The machine's own default is manual — not
      // passing `autoAdvance` here is that default, stated. The manifest's
      // branch table rides straight in (docs/content-format.md,
      // "Branches"): the machine resolves it once and drops any decision
      // whose references do not resolve; absent branches stay a linear
      // novel, exactly as before.
      const machine = createMachine({
        items: manifest.items,
        branches: manifest.branches,
        settings: currentSettings,
        ...resumeOptionsFor(persisted),
      });
      const shell = mountShell({ root, manifest, machine });

      // Persistence: every machine move can change the resume point —
      // the ctx carries the seen set, the open route, and the last shown
      // item — and so does every settings change from the `c` screen. A
      // change ISSUES its write at once (docs/plan.md Phase 14): the old
      // 250 ms debounce left the newest position simply unwritten when a
      // reload came a moment after an advance, and the flushes below could
      // not rescue an unwritten one — IndexedDB promises nothing about a
      // transaction opened while the document is going away. So timing
      // coalesces nothing; only concurrency does: createImmediateWriter
      // keeps one write in flight and at most one pending snapshot, so a
      // skip burst still costs one write per burst-pause without a queue
      // that grows with the reader. The record keeps `frontier` (derived,
      // legacy readers) beside the ctx; exportContext is a sorted number
      // list, cheap to serialize per write.
      const stateRecord = (): PersistedState => ({
        frontier: machine.getState().frontier,
        ctx: machine.exportContext(),
        settings: currentSettings,
        helpSeen,
      });
      const writeState = createImmediateWriter((state: PersistedState) =>
        storage.saveState(state),
      );
      const persistNow = (): Promise<void> => writeState(stateRecord());
      // A state-write outage stays silent: reading must never break, and an
      // unhandled rejection would put a console error on a plain `file://`
      // open. Only the bookmark the reader asked for reports its failure.
      const persistQuietly = (): void => {
        persistNow().catch(() => {});
      };
      machine.subscribe(persistQuietly);
      // Belt and braces for the microseconds one transaction is in flight:
      // these re-issue the CURRENT snapshot (so a write that failed earlier
      // gets one more chance before the page goes), which is all a page in
      // the middle of being torn down can do — the durability itself comes
      // from the write having been issued on the change.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") persistQuietly();
      });
      document.addEventListener("pagehide", persistQuietly);

      // `b` (README bookmark bullet): the thumbnail is opportunistic — a
      // frame is captured only when it is drawable and the canvas readable
      // (over `file://` Chrome taints it, and null is expected); the
      // durable bookmark is `{timestampMs, itemIndex, ctx}`, which the `t`
      // list renders from even without a thumb (render/bookmarks.ts falls
      // back to the manifest item's still). The ctx rides along so the
      // later restore can re-enter the route context the bookmark was
      // taken in (`bookmarkRestoreTarget`); a restore without one — an
      // old bookmark — is the plain itemIndex navigation.
      // Phase 14 adds the ORDER: the bookmark record and a state write are
      // both issued, and the flash waits for BOTH to commit. The state write
      // is the one the last advance already issued (usually long done), and
      // awaiting it again covers the case where it is still in flight when
      // `b` lands — so the pill means a reload this very second resumes on
      // this item AND finds the entry in the `t` list.
      const takeBookmark = async (): Promise<void> => {
        const blob = await captureVisualThumbnail(shell.currentVisual());
        const thumbDataUrl = blob === null ? null : await blobToDataUrl(blob);
        const bookmark: Bookmark = {
          id: newBookmarkId(),
          timestampMs: Date.now(),
          itemIndex: machine.getState().cursor,
          ctx: machine.exportContext(),
          thumbDataUrl,
        };
        const settled = await Promise.allSettled([
          persistNow(),
          storage.addBookmark(bookmark),
        ]);
        const failed = settled.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed !== undefined) {
          // The one storage failure worth a console line: the reader asked
          // for a bookmark and it did not commit. No pill — "Bookmarked"
          // means saved, and it is not.
          console.warn("[kinetic] bookmark not saved", failed.reason);
          return;
        }
        // The confirmation arrives after both writes are durable, and never
        // interferes with `h`: it is not the overlay.
        shell.flash("Bookmarked");
      };

      // `t` (README `t` bullet): the bookmark list panel. It reads the list
      // fresh on every open (bookmarks taken since the last look show up),
      // and an entry click continues the novel from that moment: a record
      // with a ctx restores THROUGH it — importContext re-enters the item
      // inside the route context the bookmark captured, an UNSETTLED
      // arrival that fires no decision (same landing rule as a resume);
      // a pre-Phase-13 record without one keeps the legacy plain-itemIndex
      // navigation (machine.goTo).
      const overlay = mountBookmarkOverlay({
        root,
        items: manifest.items,
        onPick: (target) => {
          if (target.ctx !== undefined) machine.importContext(target.ctx);
          else machine.goTo(target.itemIndex);
        },
      });
      const showBookmarks = (): void => {
        // A storage outage reads as an empty list, not a dead key.
        storage.getBookmarks().then(
          (list) => overlay.render(list),
          () => overlay.render([]),
        );
      };
      // `c` (README `c` bullet): the config screen. A control click
      // applies the full next settings live — machine.setSettings re-arms
      // the pending auto-advance with them (docs/plan.md Phase 9) — and
      // writes them, like every other change in the record. setSettings
      // is not a state change, so this is the write's trigger.
      const config = mountConfigOverlay({
        root,
        settings: () => currentSettings,
        onChange: (next) => {
          currentSettings = next;
          machine.setSettings(next);
          persistQuietly();
        },
      });
      // The key help screen (docs/plan.md Phase 13b): the keymap's own
      // table on a black screen. Opening it pauses the machine and hides
      // the stage; closing it resumes the same item, its hold re-armed
      // from now — and the first close records `helpSeen` durably, so the
      // screen appears exactly once per novel (render/help.ts).
      const help = mountHelpOverlay({ root, onClose: () => closeHelp() });
      const openHelp = (): void => {
        if (help.isOpen()) return;
        help.open();
        shell.setStageVisible(false);
        machine.pause(); // the black screen: no timers behind the help
      };
      function closeHelp(): void {
        if (!help.isOpen()) return;
        help.close();
        shell.setStageVisible(true);
        machine.resume();
        if (!helpSeen) {
          helpSeen = true;
          persistQuietly(); // the close must outlive a reload
        }
      }

      // The decision overlay (docs/plan.md Phase 13, render/choice.ts):
      // it shows the machine's open `choice` and nothing else — every
      // state change syncs it, so it appears when a decision fires and
      // disappears the moment `choose()` / `chooseContinue()` answers it.
      // A resume landing never re-fires a decision, so the panel is never
      // open at load (the first-load help can never meet it).
      const choice = mountChoiceOverlay({
        root,
        onPick: (routeIdx) => machine.choose(routeIdx),
        onContinue: () => machine.chooseContinue(),
      });
      machine.subscribe((state) => {
        if (state.choice !== undefined) choice.render(state.choice);
        else choice.close();
      });

      // Route announcements (docs/plan.md Phase 16, Branches): the `#flash`
      // pill names the route the reader has just entered — a manual pick or
      // a play-all auto-pick alike — and leads with "Back to try another
      // route" when the journey jumped back in time to take it. A pure
      // render-side rule over state transitions (render/routes.ts reads the
      // machine's route context, mutates nothing): the branch journey the
      // user could not follow becomes three lines of pill on screen.
      mountRouteAnnouncements({
        machine,
        manifest,
        flash: (messages) => shell.flashSequence(messages),
      });

      // Mutual exclusion, centralized (the rule is stated pure in
      // render/choice.ts as `inputOwnerFor`): the key HELP wins over
      // everything — Escape opens it even over a pending choice, and the
      // choice waits underneath, reappearing when help closes (help's
      // machine pause/resume is inert while a decision's item is settled).
      // A pending CHOICE owns everything else: `t`/`c` cannot open over
      // it, `h`/`b`/`a` are inert, the timeline is suspended, and only
      // its own inputs act (1..9, Enter with the offer, row clicks) —
      // except an arrival-open view, through which navigation acts (see
      // the gate below). Otherwise the story reads, and `t`/`c` are the
      // open screens.
      const owner = () => inputOwnerFor(help.isOpen(), choice.isOpen());
      // A FIRED choice suspends the timeline (it owns the screen until
      // answered). An ARRIVAL-open choice (`choice.arrival`, docs/plan.md
      // Phase 16) does not: the wheel has to be able to step away — which
      // closes the view without consuming the decision — and space has to
      // land as the press that fires it. The machine keeps every command
      // inert on a fired choice by itself, so letting commands through an
      // arrival view can only ever reach arrival semantics.
      const firedChoiceHoldsTimeline = () =>
        machine.getState().choice?.arrival !== true;
      const anyScreenOpen = () =>
        overlay.isOpen() ||
        config.isOpen() ||
        help.isOpen() ||
        (choice.isOpen() && firedChoiceHoldsTimeline());

      // While a panel is open it takes precedence: the cursor-moving
      // commands (space/tab/e/wheel) are suspended until it closes. `b`
      // still bookmarks the current item and `h` still toggles text —
      // behind the bookmark/config panels, which do not hide the screen.
      // Behind help's black screen nothing but the closing actions acts.
      const timeline = suspendTimeline(
        {
          advance: () => machine.advance(),
          toggleSkip: () => machine.toggleSkip(),
          jumpToUnseen: () => machine.jumpToUnseen(),
          wheelBack: () => machine.wheelBack(),
          wheelForward: () => machine.wheelForward(),
        },
        anyScreenOpen,
      );

      installKeyMap(
        document,
        {
          // Space over help closes it and is consumed — no advance (and on
          // the first load it is also the first gesture, so fullscreen gets
          // its request like any other first press; render/fullscreen.ts).
          // Over a FIRED choice the gate below already swallows it: the
          // decision is answered by its own keys, never by space. Over an
          // ARRIVAL-open view space passes (Phase 16): it settles-and-moves,
          // which fires the decision without moving off the item.
          advance: () => {
            if (help.isOpen()) {
              closeHelp();
              return;
            }
            timeline.advance();
          },
          toggleText: () => {
            if (owner() !== "story") return;
            shell.toggleText();
          },
          toggleSkip: timeline.toggleSkip,
          jumpToUnseen: timeline.jumpToUnseen,
          bookmark: () => {
            if (owner() !== "story") return;
            void takeBookmark();
          },
          toggleBookmarks: () => {
            if (owner() !== "story") return;
            if (overlay.isOpen()) overlay.close();
            else {
              config.close();
              showBookmarks();
            }
          },
          toggleConfig: () => {
            if (owner() !== "story") return;
            if (config.isOpen()) config.close();
            else {
              overlay.close();
              config.open();
            }
          },
          // `a` (README auto-forward bullet): manual is the start, and `a`
          // toggles auto-advance. Turning it off cancels the pending hold;
          // a skip dwell keeps running — skipping is the reader's own run.
          toggleAutoForward: () => {
            if (owner() !== "story") return;
            machine.setAutoAdvance(!machine.isAutoAdvance());
          },
          // Enter is owned by the screen (render/choice.ts's rule): it
          // closes help, else takes the choice's "return to main route"
          // when that offer is up, else it is inert.
          closeHelp: () => {
            const action = enterActionFor(
              owner(),
              machine.getState().choice?.continueOption === true,
            );
            if (action === "close-help") closeHelp();
            else if (action === "continue") machine.chooseContinue();
          },
          // Escape (docs/plan.md Phase 13b, extended by 13): closes help,
          // else closes the open `t`/`c` panel, else opens help — and
          // "else" includes OVER a pending choice: help wins over
          // everything (the declared exception to choice ownership), the
          // decision waits underneath and is still open when help closes.
          // A choice is never closed by Escape: only its own answer ends
          // it. `t`/`c` can never be open while one is, so they need no
          // case here.
          dismissOverlay: () => {
            if (help.isOpen()) {
              closeHelp();
              return;
            }
            if (config.isOpen() || overlay.isOpen()) {
              config.close();
              overlay.close();
              return;
            }
            openHelp(); // Escape with nothing up opens help
          },
        },
        // 1..9 answer a pending decision (render/keys.ts's route digits).
        // The owner check lives here: with no choice open a digit is
        // inert, and with help up help owns the screen.
        (routeIdx) => {
          if (owner() !== "choice") return;
          machine.choose(routeIdx);
        },
      );
      installWheelInput(document, {
        wheelBack: timeline.wheelBack,
        wheelForward: timeline.wheelForward,
      });

      // The first-load help screen (docs/plan.md Phase 13b): before any
      // advance, over a black screen, machine paused, no timers. Closing
      // it records `helpSeen` and resumes the start the machine already
      // took — item 0 on a first load, the restored position otherwise.
      if (!helpSeen) openHelp();
    },
    (error: unknown) => {
      // An unreadable manifest is shown, never thrown: an uncaught rejection
      // would put a console error on a plain `file://` open.
      const detail = error instanceof Error ? error.message : String(error);
      mountError(root, `Could not load the content: ${detail}`);
    },
  );
}

start();
