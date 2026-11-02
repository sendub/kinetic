// Kinetic player entry point (docs/plan.md Phases 5, 8, 9, 13, 13b, 14): load
// the manifest, build the timeline machine — resuming from the persisted
// route-play context and starting on the persisted settings when either
// exists —
// mount the render shell, install the input map, and wire storage: the
// machine context, keyed by id (storage/ids.ts), is written the moment
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
// a bookmark restore re-enters the recorded route context. Phase 16's
// "Reset progress" adds the `c` row and its confirmation box: on confirm
// the content's state and bookmark rows are deleted (each committed) and
// the page RELOADS — a true fresh boot, help screen included.
// Composition only — rendering lives in src/render/, timing in
// src/machine/, storage adapters in src/storage/.

import { createMachine } from "./machine/machine";
import type { MachineSettings } from "./machine/types";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell } from "./render/app";
import { mountAutoForwardAnnouncements } from "./render/autoforward";
import {
  bookmarkContext,
  mergeProgress,
  mountBookmarkOverlay,
} from "./render/bookmarks";
import { captureVisualThumbnail } from "./render/capture";
import { inputOwnerFor, mountChoiceOverlay } from "./render/choice";
import { mountConfigOverlay } from "./render/config";
import { mountConfirmOverlay, resetProgress } from "./render/confirm";
import { EARLIER_UNSEEN_NOTICE } from "./render/endcard";
import { installFirstGestureFullscreen } from "./render/fullscreen";
import { mountHelpOverlay } from "./render/help";
import { installKeyMap, suspendTimeline } from "./render/keys";
import { loadManifest } from "./render/manifest";
import { mountRouteAnnouncements } from "./render/routes";
import { installWheelInput } from "./render/wheel";
import { contentSignature, createIdbStorage } from "./storage/idb";
import { createContextCodec, resumeOptionsFor } from "./storage/ids";
import { createNoopStorage } from "./storage/noop";
import { createImmediateWriter } from "./storage/persist";
import type { Bookmark, PersistedState } from "./storage/types";
import { helpSeenFrom } from "./storage/types";

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
    // The skip dwell is not a reader setting (there is no control for it):
    // a stored value is a stale default from an older build, so the
    // current default always wins (docs/plan.md Phase 18, faster skip).
    if (field === "skipDwellMs") continue;
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
  // `document.baseURI` is the content folder's own `index.html`, so it is both
  // the root every declared media path resolves against (a bucket subpath like
  // `assets/ab/x.jpg` included) and the identity of this novel's storage.
  const contentRoot = document.baseURI;
  void loadManifest(
    { embedded: window.KINETIC_MANIFEST, fetchJson },
    contentRoot,
  ).then(
    async (manifest) => {
      // One storage namespace per novel folder (docs/plan.md Phase 8):
      // IndexedDB when the host has it, an in-memory adapter when not, so
      // the player always runs — it just remembers nothing across a reload.
      const storage =
        createIdbStorage(contentSignature(contentRoot)) ?? createNoopStorage();
      // Resume: a stored context is the reader's position — its history
      // entry on screen (or `lastShown`) is where the load starts, the
      // seen set and route stack arrive with it. Storage holds it keyed
      // by item / decision / route id (docs/plan.md Phase 18), so a
      // content update keeps it valid; the codec converts it to this
      // manifest's positions and drops ids that no longer exist. No
      // record, an unreadable one, or an old index-based one is the
      // first-ever load: item 0.
      const codec = createContextCodec(manifest.items, manifest.branches);
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
        ...resumeOptionsFor(persisted, codec),
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
      // that grows with the reader. The codec caches the converted history
      // as the machine caches its export, so a write stays cheap.
      const stateRecord = (): PersistedState => ({
        ctx: codec.toSaved(machine.exportContext()),
        settings: currentSettings,
        helpSeen,
      });
      const writeState = createImmediateWriter((state: PersistedState) =>
        storage.saveState(state),
      );
      const persistNow = (): Promise<void> => writeState(stateRecord());
      // A confirmed "Reset progress" (Phase 16) sets this: from that
      // moment every state write stops, or the `pagehide` flush of the
      // reload below would simply re-save the row the reset deleted.
      let resetting = false;
      // A state-write outage stays silent: reading must never break, and an
      // unhandled rejection would put a console error on a plain `file://`
      // open. Only the bookmark the reader asked for reports its failure.
      const persistQuietly = (): void => {
        if (resetting) return;
        persistNow().catch(() => {});
      };
      // The same write, issued at once even while another is in flight
      // (storage/persist.ts, `urgent`): for the changes a reader makes
      // and may reload straight after — a settings click, the help close
      // — and for the page-teardown flushes below, where a value parked
      // behind the running write would never be issued at all (docs/
      // plan.md Phase 18, "Settings survive an immediate reload").
      const persistUrgently = (): void => {
        if (resetting) return;
        writeState(stateRecord(), true).catch(() => {});
      };
      machine.subscribe(persistQuietly);
      // Belt and braces for the microseconds one transaction is in flight:
      // these re-issue the CURRENT snapshot (so a write that failed earlier
      // gets one more chance before the page goes), which is all a page in
      // the middle of being torn down can do — the durability itself comes
      // from the write having been issued on the change.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") persistUrgently();
      });
      document.addEventListener("pagehide", persistUrgently);

      // `b` (README bookmark bullet): the thumbnail is opportunistic — a
      // frame is captured only when it is drawable and the canvas readable
      // (over `file://` Chrome taints it, and null is expected); the
      // durable bookmark is `{timestampMs, itemId, ctx}` — keyed by id, so
      // a content update keeps it pointing at the same item — which the
      // `t` list renders from even without a thumb (render/bookmarks.ts
      // falls back to the manifest item's still). The ctx rides along so
      // the later restore can re-enter the route context the bookmark was
      // taken in (`bookmarkRestoreTarget`).
      // Phase 14 adds the ORDER: the bookmark record and a state write are
      // both issued, and the flash waits for BOTH to commit. The state write
      // is the one the last advance already issued (usually long done), and
      // awaiting it again covers the case where it is still in flight when
      // `b` lands — so the pill means a reload this very second resumes on
      // this item AND finds the entry in the `t` list.
      const takeBookmark = async (): Promise<void> => {
        const blob = await captureVisualThumbnail(shell.currentVisual());
        const thumbDataUrl = blob === null ? null : await blobToDataUrl(blob);
        const ctx = codec.toSaved(bookmarkContext(machine.exportContext()));
        const bookmark: Bookmark = {
          id: newBookmarkId(),
          timestampMs: Date.now(),
          itemId: ctx.lastShown,
          ctx,
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
      // and an entry click continues the novel from that moment: the
      // record's ctx, converted to this manifest's positions, restores
      // THROUGH importContext — it re-enters the item inside the route
      // context the bookmark captured, an UNSETTLED arrival that fires no
      // decision (same landing rule as a resume), and a jump: the landing
      // is appended to the reading history. Only bookmarks whose item is
      // still in the manifest are listed (render/bookmarks.ts).
      const overlay = mountBookmarkOverlay({
        root,
        items: manifest.items,
        onPick: (target) => {
          const ctx = codec.fromSaved(target.ctx);
          if (ctx !== undefined) {
            machine.importContext(mergeProgress(ctx, machine.exportContext()));
          }
        },
        // The thumbnail's "x" (docs/plan.md Phase 18): delete, then draw
        // what storage now holds. A failed delete re-reads the list, so
        // the panel never shows a row as gone that is still stored.
        onDelete: (bookmark) => {
          storage.deleteBookmark(bookmark.id).then(
            (list) => {
              if (overlay.isOpen()) overlay.render(list);
            },
            (error: unknown) => {
              console.warn("[kinetic] bookmark not deleted", error);
              if (overlay.isOpen()) showBookmarks();
            },
          );
        },
      });
      // The list read is async: `t` counts as an open screen from the
      // press (`syncMenuPause`), so nothing advances while it loads.
      let bookmarksOpening = false;
      const showBookmarks = (): void => {
        bookmarksOpening = true;
        const shown = (list: readonly Bookmark[]): void => {
          bookmarksOpening = false;
          overlay.render(list);
          syncMenuPause();
        };
        // A storage outage reads as an empty list, not a dead key.
        storage.getBookmarks().then(shown, () => shown([]));
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
          persistUrgently();
        },
        onReset: () => {
          // The box asks; nothing is touched until it confirms. It sits
          // over the config panel — same screen family, same suspension.
          confirm.open();
        },
      });
      // The reset confirmation box (docs/plan.md Phase 16). Confirming
      // deletes this content's state row AND its bookmarks rows, then
      // RELOADS: a fresh boot is the honest "first ever play" (help
      // overlay shown, item 1 current, default settings) — re-creating
      // that in place would replay main.ts's startup by hand and prove
      // less. The order inside resetProgress is the storage contract:
      // pending write flushed, both deletes committed, THEN reload
      // (render/confirm.ts; the verify-step-40 file:// IDB lesson). The
      // `resetting` flag above keeps the reload's own pagehide flush
      // from re-saving the deleted row.
      const confirm = mountConfirmOverlay({
        root,
        onConfirm: () => runReset(),
        // Cancel: close, and nothing else was ever touched.
        onCancel: () => {},
      });
      function runReset(): void {
        confirm.close();
        resetting = true;
        void resetProgress({
          flush: persistNow,
          storage,
          reload: () => globalThis.location.reload(),
        });
      }
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
          persistUrgently(); // the close must outlive a reload
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
      // The wheel and `e` replay the reading history, restoring each
      // entry's route frames; a replayed route entry is not a pick, so its
      // state changes announce no route pill (render/routes.ts).
      let replaying = false;
      const replay = (move: () => void) => () => {
        replaying = true;
        try {
          move();
        } finally {
          replaying = false;
        }
      };
      mountRouteAnnouncements({
        machine,
        manifest,
        flash: (messages) => shell.flashSequence(messages),
        quiet: () => replaying,
      });
      // The auto-forward pill (docs/plan.md Phase 20): "Auto-forward on" /
      // "Auto-forward off" on every real flip of the mode — `a`, or the
      // Space that stops it — through the same route pill, newest wins.
      // The machine reports the flips; a load is no flip, so no pill.
      mountAutoForwardAnnouncements({
        machine,
        flash: (messages) => shell.flashSequence(messages),
      });

      // Mutual exclusion, centralized (the rule is stated pure in
      // render/choice.ts as `inputOwnerFor`): the key HELP wins over
      // everything — Escape opens it even over a pending choice, and the
      // choice waits underneath, reappearing when help closes (help's
      // machine pause/resume is inert while a decision's item is settled).
      // A pending CHOICE owns everything else: `t` cannot open over it,
      // `h`/`b`/`a` are inert, the timeline is suspended, and only its
      // own inputs act (1..9, 0 with the offer, row clicks) — except the
      // history moves, the wheel and `e` (see the gates below), and `c`,
      // whose panel covers the choice and makes its digits inert until
      // it closes. Otherwise the story reads, and `t`/`c` are the open
      // screens.
      const owner = () => inputOwnerFor(help.isOpen(), choice.isOpen());
      // The reset box owns the screen too, the way its parent `c` panel
      // does: while it is open only its own controls act (its keys ride
      // the map below), like the suspension behind `h`/`t`/`c`.
      const storyInput = () => owner() === "story" && !confirm.isOpen();
      const anyPanelOpen = () =>
        overlay.isOpen() ||
        config.isOpen() ||
        confirm.isOpen() ||
        help.isOpen();
      const anyScreenOpen = () => anyPanelOpen() || choice.isOpen();
      // The history moves are never trapped by a choice (docs/plan.md,
      // "History rollback spec"): a wheel notch or `e` leaves a choice
      // screen for the neighbouring / last history entry — the screen stays
      // in the history and nothing is answered. Only the panels (help,
      // `t`, `c`, the reset box) still suspend them.
      const historyGate = (command: () => void) => () => {
        if (anyPanelOpen()) return;
        command();
      };

      // While a panel is open it takes precedence: the cursor-moving
      // commands (space/tab/e/wheel) are suspended until it closes. `b`
      // still bookmarks the current item and `h` still toggles text —
      // behind the bookmark/config panels, which do not hide the screen.
      // Behind help's black screen nothing but the closing actions acts.
      const timeline = {
        ...suspendTimeline(
          {
            advance: () => machine.advance(),
            toggleSkip: () => machine.toggleSkip(),
            jumpToEnd: () => machine.jumpToEnd(),
            wheelBack: () => machine.wheelBack(),
            wheelForward: () => machine.wheelForward(),
          },
          anyScreenOpen,
        ),
        jumpToEnd: historyGate(replay(() => machine.jumpToEnd())),
        wheelBack: historyGate(replay(() => machine.wheelBack())),
        wheelForward: historyGate(replay(() => machine.wheelForward())),
      };

      installKeyMap(
        document,
        {
          // Space over help closes it and is consumed — no advance (and on
          // the first load it is also the first gesture, so fullscreen gets
          // its request like any other first press; render/fullscreen.ts).
          // Over a choice the gate below already swallows it: the
          // decision is answered by its own keys, never by space — except
          // that Space takes a play-all auto-pick at once (Phase 18).
          advance: () => {
            if (help.isOpen()) {
              closeHelp();
              return;
            }
            if (machine.getState().choice?.autoPick !== undefined) {
              if (!anyPanelOpen()) machine.advance();
              return;
            }
            timeline.advance();
          },
          toggleText: () => {
            if (!storyInput()) return;
            shell.toggleText();
          },
          toggleSkip: timeline.toggleSkip,
          jumpToEnd: timeline.jumpToEnd,
          // `u` (docs/plan.md Phase 18): a jump, like `e` never trapped by
          // a choice and suspended behind the panels; entering a route this
          // way is a pick, so its route pill shows.
          nextUnseen: historyGate(() => machine.jumpToUnseen()),
          bookmark: () => {
            if (!storyInput()) return;
            void takeBookmark();
          },
          toggleBookmarks: () => {
            if (!storyInput()) return;
            if (overlay.isOpen()) overlay.close();
            else {
              config.close();
              showBookmarks();
            }
          },
          // `c` works everywhere but under the reset box (docs/plan.md
          // Phase 19): over a choice the panel covers it and the choice
          // waits underneath (a play-all countdown pauses with the
          // menu); over help it replaces the help screen.
          toggleConfig: () => {
            if (confirm.isOpen()) return;
            closeHelp();
            if (config.isOpen()) config.close();
            else {
              overlay.close();
              config.open();
            }
          },
          // `a` (README auto-forward bullet): manual is the start, and `a`
          // toggles auto-advance. Turning it off cancels the pending hold;
          // a skip dwell keeps running — skipping is the reader's own run.
          // Space also turns it off (machine `advance()`, Phase 18). Every
          // flip shows its pill (render/autoforward.ts, Phase 20), from
          // the machine's own report, so nothing here syncs it.
          toggleAutoForward: () => {
            if (!storyInput()) return;
            machine.setAutoAdvance(!machine.isAutoAdvance());
          },
          // `y`/`n` act only while the reset box is open (keys.ts maps
          // them always; the box is the context, like Escape is its). With no box up they are inert, as the digits
          // are with no decision.
          confirmReset: () => {
            if (confirm.isOpen()) runReset();
          },
          confirmCancel: () => {
            if (confirm.isOpen()) confirm.close();
          },
          // Escape (docs/plan.md Phase 13b, extended by 13): closes help,
          // else closes the open `t`/`c` panel, else opens help — and
          // "else" includes OVER a pending choice: help wins over
          // everything (the declared exception to choice ownership), the
          // decision waits underneath and is still open when help closes.
          // A choice is never closed by Escape: only its own answer ends
          // it; a `c` panel over one closes first (`t` cannot open over
          // one). The reset box (Phase 16) is checked FIRST: it sits over
          // the `c` panel, and Escape cancels the box without disturbing
          // the panel under it.
          dismissOverlay: () => {
            if (confirm.isOpen()) {
              confirm.close();
              return;
            }
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
        // 1..9 answer a pending decision (render/keys.ts's route digits)
        // and 0 takes its "Return to main route" row when that row is
        // drawn (docs/plan.md Phase 18). The owner check lives here: with
        // no choice open a digit is inert, and with help up help owns the
        // screen.
        (key) => {
          if (owner() !== "choice" || anyPanelOpen()) return;
          if (key !== "return") machine.choose(key);
          else if (machine.getState().choice?.continueOption === true) {
            machine.chooseContinue();
          }
        },
      );
      installWheelInput(document, {
        wheelBack: timeline.wheelBack,
        wheelForward: timeline.wheelForward,
      });

      // Menus pause the timeline (docs/plan.md Phase 18): while the `c` or
      // `t` screen (or the reset box over `c`) is up, a running
      // auto-forward hold or skip burst is frozen — machine.pause(), as
      // under help, keeps `skipping` and arms nothing — and a playing
      // video holds in place. Closing the screen resumes exactly what was
      // running: machine.resume() re-arms a fresh hold or skip dwell. A
      // bookmark click that jumps away restores through importContext
      // while still paused, which ends any skip burst (a jump is manual
      // navigation), so the resume re-arms only the landing's own hold in
      // whatever auto mode was on. Every way a screen opens or closes is a
      // key press (handled above) or a click on its panel, so these
      // listeners — registered after the keymap and bubbling after the
      // panels' own — re-sync after each.
      let menuPaused = false;
      function syncMenuPause(): void {
        const open =
          bookmarksOpening ||
          overlay.isOpen() ||
          config.isOpen() ||
          confirm.isOpen();
        if (open === menuPaused) return;
        menuPaused = open;
        shell.setMediaPaused(open);
        if (open) machine.pause();
        else if (!help.isOpen()) machine.resume();
      }
      document.addEventListener("keydown", syncMenuPause);
      document.addEventListener("click", syncMenuPause);

      // The first-load help screen (docs/plan.md Phase 13b): before any
      // advance, over a black screen, machine paused, no timers. Closing
      // it records `helpSeen` and resumes the start the machine already
      // took — item 0 on a first load, the restored position otherwise.
      if (!helpSeen) openHelp();
      // The resume notice (docs/plan.md Phase 18): a restored position with
      // passed-over unseen content before it (a prequel a content update
      // added, say) gets one quiet line pointing at `u`. A first load sits
      // on item 0, where nothing is earlier.
      else if (machine.hasEarlierUnseen()) {
        shell.showNotice(EARLIER_UNSEEN_NOTICE);
      }
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
