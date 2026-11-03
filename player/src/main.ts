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
// `t` opens the bookmark list, and the Esc screen holds every setting
// (Phase 26: `c` is gone), whose changes apply live (machine.setSettings)
// and persist with the context.
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
// "Reset progress" adds the settings row and its confirmation box: on confirm
// the content's state and bookmark rows are deleted (each committed) and
// the page RELOADS — a true fresh boot, help screen included. Phase 21's
// "Export progress" / "Import progress" rows move that progress between
// browsers: export downloads it as a file (storage/transfer.ts); import
// checks a picked file, confirms in the same box, replaces this story's
// state and bookmarks (committed), and reloads — saving is automatic again
// from there.
// Composition only — rendering lives in src/render/, timing in
// src/machine/, storage adapters in src/storage/.

import { createMachine } from "./machine/machine";
import type { MachineSettings } from "./machine/types";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell } from "./render/app";
import { mountAutoForwardAnnouncements } from "./render/autoforward";
import {
  bookmarkRestoreTarget,
  mergeProgress,
  mountBookmarkOverlay,
} from "./render/bookmarks";
import { captureVisualThumbnail } from "./render/capture";
import { inputOwnerFor, mountChoiceOverlay } from "./render/choice";
import { mountConfigOverlay } from "./render/config";
import {
  importRequest,
  mountConfirmOverlay,
  resetProgress,
  resetRequest,
} from "./render/confirm";
import { downloadText } from "./render/download";
import { EARLIER_UNSEEN_NOTICE } from "./render/endcard";
import { installFirstGestureFullscreen } from "./render/fullscreen";
import { gameTitleOf, mountHelpOverlay, pageTitleFor } from "./render/help";
import {
  bookmarksKeyAction,
  installKeyMap,
  suspendTimeline,
} from "./render/keys";
import { loadManifest } from "./render/manifest";
import { mountRouteAnnouncements } from "./render/routes";
import { installWheelInput } from "./render/wheel";
import { createIdbStorage, storageKeys, storyIdOf } from "./storage/idb";
import { createContextCodec, resumeOptionsFor } from "./storage/ids";
import { createNoopStorage } from "./storage/noop";
import { createImmediateWriter } from "./storage/persist";
import {
  buildProgressFile,
  type ImportedProgress,
  importProgress,
  parseProgressFile,
  progressFileName,
  type StoryIdentity,
} from "./storage/transfer";
import type {
  Bookmark,
  BookmarkSummary,
  PersistedState,
} from "./storage/types";
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
  // `media/ab/x.jpg` included) and the identity of this novel's storage.
  const contentRoot = document.baseURI;
  void loadManifest(
    { embedded: window.KINETIC_MANIFEST, fetchJson },
    contentRoot,
  ).then(
    async (manifest) => {
      // The game's name names the page (docs/plan.md Phase 21), else the
      // player's own title stays.
      document.title = pageTitleFor(manifest.title);
      // One storage namespace per novel (docs/plan.md Phases 8, 21): its
      // manifest `storyId` when it has one, so moving or renaming the
      // folder keeps progress (and progress saved under the folder URL is
      // carried over once), else the folder URL. IndexedDB when the host
      // has it, an in-memory adapter when not, so the player always runs —
      // it just remembers nothing across a reload.
      const keys = storageKeys(manifest.storyId, contentRoot);
      // The story as export and import name it (Phase 21).
      const gameTitle = gameTitleOf(manifest.title) ?? undefined;
      const story: StoryIdentity = {
        storyId: storyIdOf(manifest.storyId),
        ...(gameTitle === undefined ? {} : { title: gameTitle }),
      };
      const storage =
        createIdbStorage(keys.key, keys.legacyKey) ?? createNoopStorage();
      // Resume: a stored context is the reader's position — its
      // `lastShown` (under its open choice, if any) is where the load
      // starts, the seen set, route stack and last picks arrive with it. Storage holds it keyed
      // by item / decision / route id (docs/plan.md Phase 18), so a
      // content update keeps it valid; the codec converts it to this
      // manifest's positions and drops ids that no longer exist. No
      // record, an unreadable one, or an old index-based one is the
      // first-ever load: item 0.
      const codec = createContextCodec(manifest.items, manifest.branches);
      const persisted = await storage.loadState().catch(() => null);
      // Settings persist through the Esc screen (docs/plan.md Phases 9, 26):
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
      // item — and so does every settings change on the Esc screen. A
      // change ISSUES its write at once (docs/plan.md Phase 14): the old
      // 250 ms debounce left the newest position simply unwritten when a
      // reload came a moment after an advance, and the flushes below could
      // not rescue an unwritten one — IndexedDB promises nothing about a
      // transaction opened while the document is going away. So timing
      // coalesces nothing; only concurrency does: createImmediateWriter
      // keeps one write in flight and at most one pending snapshot, so a
      // skip burst still costs one write per burst-pause without a queue
      // that grows with the reader.
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
        const ctx = codec.toSaved(machine.exportContext());
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
      // decision (same landing rule as a resume); the wheel then walks the
      // story around it (docs/plan.md Phase 27). Only bookmarks whose item is
      // still in the manifest are listed (render/bookmarks.ts).
      // The panel opens at once and its cards come from the bookmark
      // summaries; each captured thumbnail is read lazily (`loadThumb`),
      // and a click reads its whole bookmark only then (the bookmark-screen
      // speed item). The panel stays up through that read and closes in
      // the same task the restore lands in, so the screens switch in one
      // step and a paused burst or hold stays paused through the jump, as
      // when the record was already in hand.
      let picking = false;
      const overlay = mountBookmarkOverlay({
        root,
        items: manifest.items,
        stage: { width: manifest.width, height: manifest.height },
        loadThumb: (row) =>
          storage
            .getBookmark(row.key)
            .then((record) => record?.thumbDataUrl ?? null),
        onPick: (row) => {
          if (picking) return; // one restore at a time
          picking = true;
          const restore = (record: Bookmark | null): void => {
            picking = false;
            overlay.close();
            if (record !== null) {
              const target = bookmarkRestoreTarget(record);
              const ctx = codec.fromSaved(target.ctx);
              if (ctx !== undefined) {
                machine.importContext(
                  mergeProgress(ctx, machine.exportContext()),
                );
              }
            }
            syncMenuPause();
          };
          storage.getBookmark(row.key).then(restore, (error: unknown) => {
            console.warn("[kinetic] bookmark not read", error);
            restore(null);
          });
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
              if (overlay.isOpen()) fillBookmarks();
            },
          );
        },
      });
      // `t` shows the panel this frame; the list read fills it when it
      // lands (milliseconds: summaries only), unless the panel was closed
      // or reopened meanwhile.
      let bookmarkReads = 0;
      const fillBookmarks = (): void => {
        bookmarkReads += 1;
        const read = bookmarkReads;
        const shown = (list: readonly BookmarkSummary[]): void => {
          if (read === bookmarkReads && overlay.isOpen()) overlay.render(list);
        };
        // A storage outage reads as an empty list, not a dead key.
        storage.listBookmarks().then(shown, () => shown([]));
      };
      const showBookmarks = (): void => {
        overlay.open();
        syncMenuPause();
        fillBookmarks();
      };
      // Warm the list once the story is up: the first read after this
      // build meets old bookmarks reads each in full, once, and caches
      // their summaries (storage/idb.ts), so even the first `t` is quick.
      setTimeout(() => {
        storage.listBookmarks().catch(() => undefined);
      }, 1000);
      // The key help screen (docs/plan.md Phase 13b), mounted first: the
      // settings section below lives inside it (Phase 26).
      // The game's name heads it (docs/plan.md Phase 21).
      const help = mountHelpOverlay({
        root,
        gameTitle: manifest.title,
        // The `t` row is clickable: it does what `t` does over the screen.
        onEntry: (command) => {
          if (command === "toggleBookmarks") runBookmarksKey();
        },
      });
      // The settings (Phase 26: on the Esc screen, under the keys; `c` is
      // gone). A control click applies the full next settings live — machine.setSettings re-arms
      // the pending auto-advance with them (docs/plan.md Phase 9) — and
      // writes them, like every other change in the record. setSettings
      // is not a state change, so this is the write's trigger.
      const config = mountConfigOverlay({
        root: help.panel,
        settings: () => currentSettings,
        onChange: (next) => {
          currentSettings = next;
          machine.setSettings(next);
          persistUrgently();
        },
        onReset: () => {
          // The box asks; nothing is touched until it confirms. It sits
          // over the Esc screen — same screen family, same suspension.
          confirm.open(resetRequest(runReset));
        },
        // Export (docs/plan.md Phase 21): the state as it stands this
        // moment — the same record the next write would save — and the
        // stored bookmarks, downloaded as `<storyId>-progress.json`.
        onExport: () => {
          void storage
            .getBookmarks()
            .catch(() => [])
            .then((bookmarks) => {
              const name = progressFileName(story.storyId);
              const file = buildProgressFile({
                ...story,
                state: stateRecord(),
                bookmarks,
                now: new Date(),
              });
              downloadText(document, name, JSON.stringify(file, null, 2));
              config.showMessage(`Exported ${name}.`);
            });
        },
        // Import: the file is checked before anything is touched; a
        // refusal is said in the panel, a good file asks the box.
        onImport: (file) => {
          file.text().then(
            (text) => {
              const parsed = parseProgressFile(text, story);
              if (!parsed.ok) {
                config.showMessage(parsed.message);
                return;
              }
              config.showMessage("");
              confirm.open(importRequest(gameTitle, () => runImport(parsed)));
            },
            () => config.showMessage("That file could not be read."),
          );
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
        // Cancel: close, and nothing else was ever touched.
        onCancel: () => {},
      });
      function runReset(): void {
        resetting = true;
        void resetProgress({
          flush: persistNow,
          storage,
          reload: () => globalThis.location.reload(),
        });
      }
      // A confirmed import (docs/plan.md Phase 21): writes stop as for a
      // reset (the reload's pagehide flush must not overwrite the import),
      // the replace commits, then the page reloads onto it. A failed
      // replace changed nothing: writes resume and the panel says so.
      function runImport(progress: ImportedProgress): void {
        resetting = true;
        void importProgress({
          flush: persistNow,
          storage,
          reload: () => globalThis.location.reload(),
          progress,
        }).then((ok) => {
          if (ok) return;
          resetting = false;
          config.showMessage(
            "The import failed: this browser's storage refused it. Nothing was changed.",
          );
        });
      }
      // The Esc screen (docs/plan.md Phase 13b; Phase 26): the keymap's
      // own table and the settings on a black screen. Opening it pauses
      // the machine (a play-all countdown included) and any video, and
      // hides the stage; closing it resumes the same item, its hold
      // re-armed from now — and the first close records `helpSeen`
      // durably, so the first-load screen appears exactly once per novel
      // (render/help.ts).
      const openHelp = (): void => {
        if (help.isOpen()) return;
        help.open();
        config.open(); // the values in force, no stale message
        shell.setStageVisible(false);
        syncMenuPause(); // the black screen: no timers behind it
      };
      function closeHelp(): void {
        if (!help.isOpen()) return;
        help.close();
        config.close();
        shell.setStageVisible(true);
        syncMenuPause();
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
      // The wheel and `e` walk the story (docs/plan.md Phase 27), opening
      // each screen's route frames; walking into a route is not a pick, so
      // its state changes announce no route pill (render/routes.ts).
      let walking = false;
      const walk = (move: () => void) => () => {
        walking = true;
        try {
          move();
        } finally {
          walking = false;
        }
      };
      mountRouteAnnouncements({
        machine,
        manifest,
        flash: (messages) => shell.flashSequence(messages),
        quiet: () => walking,
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
      // own inputs act (1..9, 0 with the offer, the arrows and Enter, row
      // clicks) — except the
      // timeline moves, the wheel and `e` (see the gates below). Otherwise
      // the story reads, and `t` and Escape open the screens.
      const owner = () => inputOwnerFor(help.isOpen(), choice.isOpen());
      // The reset box owns the screen too, over the Esc screen: while it
      // is open only its own controls act (its keys ride the map below).
      const storyInput = () => owner() === "story" && !confirm.isOpen();
      const anyPanelOpen = () =>
        overlay.isOpen() || confirm.isOpen() || help.isOpen();
      const anyScreenOpen = () => anyPanelOpen() || choice.isOpen();
      // The timeline moves are never trapped by a choice (docs/plan.md
      // Phase 27): a wheel notch or `e` leaves a choice screen for the
      // neighbouring screen in story order / the furthest point read, and
      // nothing is answered. Only the panels (the Esc
      // screen, `t`, the reset box) still suspend them.
      const timelineGate = (command: () => void) => () => {
        if (anyPanelOpen()) return;
        command();
      };

      // While a panel is open it takes precedence: the cursor-moving
      // commands (space/tab/e/wheel) are suspended until it closes. `b`
      // still bookmarks the current item and `h` still toggles text —
      // behind the bookmark panel, which does not hide the screen.
      // Behind the Esc screen nothing but the closing actions acts.
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
        jumpToEnd: timelineGate(walk(() => machine.jumpToEnd())),
        wheelBack: timelineGate(walk(() => machine.wheelBack())),
        wheelForward: timelineGate(walk(() => machine.wheelForward())),
      };

      // `t` (and the Esc screen's `t` row): toggles the list, and over
      // the Esc screen REPLACES it with the list — the list opens first,
      // so the menu pause never lifts between the two and the game never
      // shows through, then the screen closes as Escape would close it
      // (helpSeen recorded). The next Escape closes the list and the game
      // resumes as from the Esc screen; it does not reopen that screen.
      function runBookmarksKey(): void {
        const action = bookmarksKeyAction({
          confirmOpen: confirm.isOpen(),
          helpOpen: help.isOpen(),
          choiceOpen: choice.isOpen(),
          listOpen: overlay.isOpen(),
        });
        if (action === "close") overlay.close();
        else if (action === "open") showBookmarks();
        else if (action === "replaceHelp") {
          showBookmarks();
          closeHelp();
        }
      }

      installKeyMap(
        document,
        {
          // Space over the Esc screen closes it and is consumed — no
          // advance (and on the first load it is also the first gesture,
          // so fullscreen gets its request like any other first press;
          // render/fullscreen.ts). It closes even with a settings button
          // focused: the keymap's preventDefault stops the browser's own
          // Space activation of that button (Phase 26), so Space always
          // means one thing; Enter, unmapped, still activates a focused
          // control. Under the reset box it does nothing.
          // Over a choice the gate below already swallows it: the
          // decision is answered by its own keys, never by space — except
          // that Space takes a play-all auto-pick at once (Phase 18).
          advance: () => {
            if (confirm.isOpen()) return;
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
          nextUnseen: timelineGate(() => machine.jumpToUnseen()),
          bookmark: () => {
            if (!storyInput()) return;
            void takeBookmark();
          },
          toggleBookmarks: runBookmarksKey,
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
            if (confirm.isOpen()) confirm.accept(); // reset or import
          },
          confirmCancel: () => {
            if (confirm.isOpen()) confirm.close();
          },
          // Escape (docs/plan.md Phase 13b, extended by 13 and 26): closes
          // the Esc screen, else closes the open `t` list, else opens the
          // Esc screen — and "else" includes OVER a pending choice: the
          // screen wins over everything (the declared exception to choice
          // ownership), the decision waits underneath, its play-all
          // countdown frozen, and is still open when the screen closes. A
          // choice is never closed by Escape: only its own answer ends it
          // (`t` cannot open over one). The reset box (Phase 16) is
          // checked FIRST: it sits over the Esc screen, and Escape cancels
          // the box without disturbing the screen under it.
          dismissOverlay: () => {
            if (confirm.isOpen()) {
              confirm.close();
              return;
            }
            if (help.isOpen()) {
              closeHelp();
              return;
            }
            if (overlay.isOpen()) {
              overlay.close();
              return;
            }
            openHelp(); // Escape with nothing up opens the Esc screen
          },
        },
        // 1..9 answer a pending decision (render/keys.ts's route digits)
        // and 0 takes its "Return to main route" row when that row is
        // drawn (docs/plan.md Phase 18); the arrows move the row cursor
        // and Enter picks its row, reaching rows past nine
        // (render/choice.ts, long lists). The owner check lives here: with
        // no choice open a decision key is inert — and left to the page,
        // so Enter still activates a focused control on the Esc screen —
        // and with help up help owns the screen.
        (key) => {
          if (owner() !== "choice" || anyPanelOpen()) return false;
          if (key === "prev" || key === "next") choice.moveCursor(key);
          else if (key === "pick") choice.pickCursor();
          else if (key !== "return") machine.choose(key);
          else if (machine.getState().choice?.continueOption === true) {
            machine.chooseContinue();
          }
          return true;
        },
      );
      // Over a choice list too long for the window the wheel scrolls the
      // list, not the story; anywhere else it walks (render/choice.ts).
      installWheelInput(
        document,
        {
          wheelBack: timeline.wheelBack,
          wheelForward: timeline.wheelForward,
        },
        (event) => choice.ownsWheel(event.target),
      );

      // Menus pause the timeline (docs/plan.md Phase 18): while the Esc
      // screen, the `t` list or the reset box is up, a running
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
        const open = overlay.isOpen() || confirm.isOpen() || help.isOpen();
        if (open === menuPaused) return;
        menuPaused = open;
        shell.setMediaPaused(open);
        if (open) machine.pause();
        else machine.resume();
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
