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
// the bookmarks show as cards on the branch map (`m`, Phase 35), and the
// Esc screen holds every setting
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
// from there. Phase 43's window controls end the Esc screen: Fullscreen |
// Window and Exit, through a game app's host object when there is one
// (render/host.ts) and the Fullscreen API in a browser tab. Phase 46's
// `index.html#start=<id>` opens one load at an item (render/urlstart.ts).
// Phase 47's sound (render/audio.ts) follows the machine's arrivals; the
// menus below tell it which screens are up, and the settings reach it with
// the machine's.
// Composition only — rendering lives in src/render/, timing in
// src/machine/, storage adapters in src/storage/.

import { createMachine } from "./machine/machine";
import type { MachineSettings } from "./machine/types";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell, NOTICE_LONG_MS } from "./render/app";
import { mountAudio } from "./render/audio";
import { mountAutoForwardAnnouncements } from "./render/autoforward";
import {
  bookmarkRestoreTarget,
  cardPictures,
  mergeProgress,
} from "./render/bookmarks";
import { mountBranchMap } from "./render/branchmap";
import { captureVisualThumbnail } from "./render/capture";
import { inputOwnerFor, mountChoiceOverlay } from "./render/choice";
import {
  EXPORT_DONE_NOTICE,
  IMPORT_FAILED_NOTICE,
  IMPORT_UNREADABLE_NOTICE,
  isSettingsControl,
  mountConfigOverlay,
} from "./render/config";
import {
  importRequest,
  mountConfirmOverlay,
  resetProgress,
  resetRequest,
} from "./render/confirm";
import { downloadText } from "./render/download";
import { EARLIER_UNSEEN_NOTICE } from "./render/endcard";
import {
  enterFullscreen,
  exitFullscreen,
  installGestureFullscreen,
} from "./render/fullscreen";
import { gameTitleOf, mountHelpOverlay, pageTitleFor } from "./render/help";
import { connectHost, type DisplayMode, windowActions } from "./render/host";
import { installKeyMap, mapKeyAction, suspendTimeline } from "./render/keys";
import { loadManifest } from "./render/manifest";
import { layOutStrip, type MapStrip, runJump } from "./render/mapmodel";
import { mountRouteAnnouncements } from "./render/routes";
import { mountSkipAnnouncements } from "./render/skip";
import { takeUrlStart } from "./render/urlstart";
import { installWheelInput } from "./render/wheel";
import { CLOSE_TAB_NOTE, mountWindowControls } from "./render/windowcontrols";
import { createIdbStorage, storageKeys, storyIdOf } from "./storage/idb";
import { createContextCodec, resumeOptionsFor } from "./storage/ids";
import { createNoopStorage } from "./storage/noop";
import { createStateWriter } from "./storage/saves";
import {
  buildProgressFile,
  type ImportedProgress,
  importProgress,
  parseProgressFile,
  progressFileName,
  type StoryIdentity,
} from "./storage/transfer";
import type { Bookmark, PersistedState, SavedMapView } from "./storage/types";
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
  // A game app's host object (render/host.ts, docs/plan.md Phase 43): read
  // now and on every `kinetic-host` event, since it may arrive after load.
  // None in a browser tab.
  const hostLink = connectHost(window);
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
      // The branch map's last view (docs/plan.md Phases 33, 41): absent on
      // a first load and after a reset (the record is deleted), which opens
      // the map at Full size, centred on "you are here". The map updates it
      // as it moves; it rides in every state write, and the map's close
      // issues one.
      let mapView: SavedMapView | undefined = persisted?.mapView;
      // The machine starts MANUAL (README advance bullet, docs/plan.md
      // Phase 13b): only the reader's presses move it until `a` turns
      // auto-forward on. The machine's own default is manual — not
      // passing `autoAdvance` here is that default, stated. The manifest's
      // branch table rides straight in (docs/content-format.md,
      // "Branches"): the machine resolves it once and drops any decision
      // whose references do not resolve; absent branches stay a linear
      // novel, exactly as before.
      // A URL start (docs/plan.md Phase 46): `index.html#start=<id>` opens
      // this load at that item in place of the saved place, entering its
      // routes as `u` does; everything else restores as usual. The hash
      // goes as it is read (render/urlstart.ts), so a reload resumes the
      // saved place; an unknown id opens as usual, with a console warning.
      const urlStart = takeUrlStart(window, manifest.items);
      const startAt = urlStart?.index ?? -1;
      const machine = createMachine({
        items: manifest.items,
        branches: manifest.branches,
        audio: manifest.audio,
        settings: currentSettings,
        ...resumeOptionsFor(persisted, codec),
        ...(startAt >= 0 ? { startAt } : {}),
      });
      const shell = mountShell({ root, manifest, machine });
      // The sound (docs/plan.md Phase 47): null for a game without audio,
      // which then makes no audio element at all.
      const audio = mountAudio({
        root,
        manifest,
        machine,
        settings: currentSettings,
      });
      // A video's sound follows the stage's video (item 6).
      if (audio !== null) shell.watchVideo((video) => audio.setVideo(video));

      // Persistence: every machine move can change the resume point —
      // the ctx carries the open route and the last shown item, and the
      // items newly seen ride with it — and so does every settings change
      // on the Esc screen. A change ISSUES its write at once (docs/plan.md
      // Phase 14): the old 250 ms debounce left the newest position simply
      // unwritten when a reload came a moment after an advance, and the
      // flushes below could not rescue an unwritten one — IndexedDB
      // promises nothing about a transaction opened while the document is
      // going away. So timing coalesces nothing; only concurrency does: the
      // writer (storage/persist.ts) keeps one write in flight and at most
      // one pending snapshot, so a skip burst still costs one write per
      // burst-pause without a queue that grows with the reader.
      // A save carries the PLACE, not the seen set (docs/plan.md Phase 46):
      // the writer adds the ids seen since the last write
      // (storage/saves.ts) and the adapter appends them to the story's seen
      // records, so a save costs the same however much has been read.
      const stateRecord = (): PersistedState => ({
        ctx: codec.toSaved(machine.exportPlace()),
        settings: currentSettings,
        helpSeen,
        ...(mapView === undefined ? {} : { mapView }),
      });
      const writeState = createStateWriter({ storage, machine, codec });
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
      // A URL start moved the reader with no state change to save it:
      // saved now, so a reload straight after resumes on the start item.
      if (startAt >= 0) persistQuietly();
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
      // map's card renders from even without a thumb (render/bookmarks.ts
      // falls back to the manifest item's still). The ctx rides along so
      // the later restore can re-enter the route context the bookmark was
      // taken in (`bookmarkRestoreTarget`). It is the place without the
      // seen set (docs/plan.md Phase 46): a restore merges the bookmark's
      // seen set into the reader's (`mergeProgress`), which already holds
      // everything seen when it was taken, so its list (empty, kept for
      // older builds' readers) adds nothing.
      // Phase 14 adds the ORDER: the bookmark record and a state write are
      // both issued, and the flash waits for BOTH to commit. The state write
      // is the one the last advance already issued (usually long done), and
      // awaiting it again covers the case where it is still in flight when
      // `b` lands — so the pill means a reload this very second resumes on
      // this item AND finds its card on the map.
      const takeBookmark = async (): Promise<void> => {
        const blob = await captureVisualThumbnail(shell.currentVisual());
        const thumbDataUrl = blob === null ? null : await blobToDataUrl(blob);
        const ctx = codec.toSaved(machine.exportPlace());
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

      // Warm the list once the story is up: the first read after this
      // build meets old bookmarks reads each in full, once, and caches
      // their summaries (storage/idb.ts), so even the first map open with
      // bookmarks is quick.
      setTimeout(() => {
        storage.listBookmarks().catch(() => undefined);
      }, 1000);
      // The key help screen (docs/plan.md Phase 13b), mounted first: the
      // settings section below lives inside it (Phase 26).
      // The game's name heads it (docs/plan.md Phase 21).
      const help = mountHelpOverlay({
        root,
        gameTitle: manifest.title,
        // The `m` row is clickable: it does what `m` does over the screen.
        onEntry: (command) => {
          if (command === "toggleMap") runMapKey();
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
          audio?.setSettings(next);
          persistUrgently();
        },
        onReset: () => {
          // The box asks; nothing is touched until it confirms. It sits
          // over the Esc screen — same screen family, same suspension.
          confirm.open(resetRequest(runReset));
        },
        // Export (docs/plan.md Phase 21): the state as it stands this
        // moment — the record the next write would save, with the whole
        // seen set (the file's format is unchanged by Phase 46) — and the
        // stored bookmarks, downloaded as `<storyId>-progress.json`. The
        // pill names no file (Phase 43 item 12): the browser or the app may
        // save it under another name (the Windows app's `name (2).json`).
        onExport: () => {
          void storage
            .getBookmarks()
            .catch(() => [])
            .then((bookmarks) => {
              const name = progressFileName(story.storyId);
              const file = buildProgressFile({
                ...story,
                state: {
                  ...stateRecord(),
                  ctx: codec.toSaved(machine.exportContext()),
                },
                bookmarks,
                now: new Date(),
              });
              downloadText(document, name, JSON.stringify(file, null, 2));
              shell.notify(EXPORT_DONE_NOTICE);
            });
        },
        // Import: the file is checked before anything is touched; a
        // refusal is said in the pill, held long enough to read, and a good
        // file asks the box.
        onImport: (file) => {
          const refuse = (message: string): void =>
            shell.notify(message, { holdMs: NOTICE_LONG_MS });
          file.text().then(
            (text) => {
              const parsed = parseProgressFile(text, story);
              if (!parsed.ok) {
                refuse(parsed.message);
                return;
              }
              confirm.open(importRequest(gameTitle, () => runImport(parsed)));
            },
            () => refuse(IMPORT_UNREADABLE_NOTICE),
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
      // The window controls (docs/plan.md Phase 43 item 9), the last group
      // of the settings: Fullscreen | Window and Exit. A game app owns its
      // display mode and quits itself (render/host.ts); in a browser tab
      // the page keeps the Display setting with the others (persisted and
      // exported like Spoilers; the machine never reads it, so no
      // setSettings) and uses the Fullscreen API.
      const windowAct = windowActions({
        link: hostLink,
        setting: (): DisplayMode =>
          currentSettings.fullscreen ? "fullscreen" : "window",
        saveSetting: (mode) => {
          currentSettings = {
            ...currentSettings,
            fullscreen: mode === "fullscreen",
          };
          persistUrgently();
        },
        isFullscreen: () => document.fullscreenElement != null,
        enterFullscreen: () => enterFullscreen(document),
        exitFullscreen: () => exitFullscreen(document),
        tabClosable: () => window.history.length <= 1 || window.opener != null,
        closeTab: () => window.close(),
        later: (run, ms) => {
          setTimeout(run, ms);
        },
        tabStayed: () =>
          shell.notify(CLOSE_TAB_NOTE, { holdMs: NOTICE_LONG_MS }),
      });
      const windowControls = mountWindowControls({
        root: config.panel,
        display: () => windowAct.shown(),
        onDisplay: (mode) => {
          windowAct.choose(mode);
          windowControls.refresh();
        },
        onExit: () => {
          // Saved first (unless a reset or import is reloading): an app
          // that quits takes its page with it.
          void (resetting ? Promise.resolve() : persistNow())
            .catch(() => {})
            .then(() => windowAct.exit());
        },
      });
      // A host's change (the page's own request, or the reader's green
      // button, menu or shortcut) repaints the switch.
      hostLink.subscribe(() => windowControls.refresh());
      // In a browser tab with Display on Fullscreen, a key or click while
      // windowed asks for fullscreen (render/fullscreen.ts); one on a
      // settings control is left to the control (Import's file picker
      // needs the gesture, the Window half must not be undone).
      installGestureFullscreen(document, {
        wanted: () => hostLink.host() === null && currentSettings.fullscreen,
        ignore: (event) => isSettingsControl(event.target),
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
      // replace changed nothing: writes resume and the pill says so.
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
          shell.notify(IMPORT_FAILED_NOTICE, { holdMs: NOTICE_LONG_MS });
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
        config.open(); // the values in force, every "?" tip idle
        windowControls.refresh();
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
      // The mode pills: "Auto-forward on" / "Auto-forward off" (docs/plan.md
      // Phase 20) and "Skip on" / "Skip off" (Phase 43) on every real flip
      // of the mode — its key, the Space that stops it, a burst stopping —
      // through the same route pill, newest wins. The machine reports the
      // flips; a load is no flip, so no pill. `a` and Tab work on a choice
      // screen and a burst can stop at one, so these pills may show over a
      // choice (render/app.ts `PillGate`), and they lead a route pill
      // announced in the same moment (`createPillQueue`).
      const flashMode = (messages: readonly string[]): void =>
        shell.flashSequence(messages, { mode: true });
      mountAutoForwardAnnouncements({ machine, flash: flashMode });
      mountSkipAnnouncements({ machine, flash: flashMode });

      // The branch map (docs/plan.md Phase 31): `m` opens the decision
      // tree with the reader's marks. Its strip is laid out on the first
      // open and kept until the bookmarked screens change (render/
      // branchmap.ts cuts it into bands for each of its two views and the
      // view's width); the marks are read fresh from the machine on every
      // open. A click on a reached
      // decision or route closes the map and moves through the machine's
      // own operations (mapmodel.ts `runJump`): the choice screen as a
      // wheel step shows it — a walk, so no route pill — and a route
      // entered by a real pick from it, whose pill names the route.
      let mapStrip: MapStrip | null = null;
      const mapStripNow = (): MapStrip => {
        mapStrip ??= layOutStrip(manifest.items, manifest.branches);
        return mapStrip;
      };
      const itemIndexById = new Map(
        manifest.items.map((item, index) => [item.id, index]),
      );
      // A card's picture (bookmarks.ts `cardPictures`): its `b` capture,
      // else its manifest still SHRUNK (`shrinkStill`): a board of
      // full-size stills is what kept Safari from painting until every
      // visible one had decoded (the Phase 29 item).
      const cardPicture = cardPictures({
        doc: document,
        items: manifest.items,
        itemIndex: (row) => itemIndexById.get(row.itemId) ?? -1,
        readCapture: (row) =>
          storage
            .getBookmark(row.key)
            .then((record) => record?.thumbDataUrl ?? null),
      });
      let picking = false;
      const map = mountBranchMap({
        root,
        strip: (bookmarkItems) => {
          mapStrip = layOutStrip(
            manifest.items,
            manifest.branches,
            bookmarkItems,
          );
          return mapStrip;
        },
        // The bookmarks as cards on the map (docs/plan.md Phase 35, which
        // replaced the `t` screen). The list is read fresh on every open
        // (summaries only: bookmarks taken since show up); a bookmark whose
        // item is no longer in the manifest is not drawn.
        bookmarks: {
          list: () => storage.listBookmarks(),
          itemIndex: (row) => itemIndexById.get(row.itemId) ?? -1,
          picture: cardPicture,
          // A card click continues the novel from that moment: the
          // record's ctx, converted to this manifest's positions, restores
          // THROUGH importContext — it re-enters the item inside the route
          // context the bookmark captured, an UNSETTLED arrival that fires
          // no decision (same landing rule as a resume); the wheel then
          // walks the story around it (docs/plan.md Phase 27). The map
          // stays up through the record's read and closes in the same task
          // the restore lands in, so the screens switch in one step.
          open: (row) => {
            if (picking) return; // one restore at a time
            picking = true;
            const restore = (record: Bookmark | null): void => {
              picking = false;
              map.close();
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
          // A card's ×: the whole record is read first (the undo stores
          // it again), then deleted. A failed delete leaves the card.
          remove: async (row) => {
            try {
              const record = await storage.getBookmark(row.key);
              await storage.deleteBookmark(row.id);
              if (record === null) return null;
              return async () => {
                const list = await storage.addBookmark(record);
                return list.find((b) => b.id === record.id) ?? null;
              };
            } catch (error) {
              console.warn("[kinetic] bookmark not deleted", error);
              return null;
            }
          },
        },
        // No `#flash` pill over the map: one still holding (a route just
        // entered, a bookmark) goes when it opens, and none shows while it
        // is up. A jump closes the map first, so its route pill shows on
        // the story.
        // A close persists the view the map was left at (Phase 33).
        onOpenChange: (open) => {
          shell.setPillsCovered(open);
          if (!open) persistQuietly();
        },
        view: () => mapView,
        onViewChange: (view) => {
          mapView = view;
        },
        // Spoilers (Phase 31): a reader setting like the Esc screen's, so it
        // persists in the same record and travels with exported progress.
        spoilers: () => currentSettings.mapSpoilers,
        onSpoilersChange: (on) => {
          // The machine never reads it, so no setSettings (no re-arm).
          currentSettings = { ...currentSettings, mapSpoilers: on };
          persistUrgently();
        },
        reader: () => {
          const ctx = machine.exportContext();
          const state = machine.getState();
          return {
            visited: ctx.visited,
            playedRoutes: ctx.playedRoutes,
            completedRoutes: ctx.completedRoutes,
            lastPicks: ctx.lastPicks,
            cursor: state.cursor,
            choiceId: state.choice?.decisionId,
          };
        },
        onJump: (jump) => {
          map.close();
          runJump(jump, {
            openChoice: () => {
              const open = machine.getState().choice;
              if (open === undefined) return -1;
              return mapStripNow().decisionById.get(open.decisionId) ?? -1;
            },
            walkedChoice: () =>
              machine.getState().choice?.walkRoute !== undefined,
            showChoice: (decision) =>
              walk(() => machine.showChoice(decision))(),
            // A map click arrives as a jump, not a read (Machine.arrival).
            choose: (route) => machine.choose(route, "map"),
          });
          syncMenuPause();
        },
      });

      // Mutual exclusion, centralized (the rule is stated pure in
      // render/choice.ts as `inputOwnerFor`): the key HELP wins over
      // everything — Escape opens it even over a pending choice, and the
      // choice waits underneath, reappearing when help closes (help's
      // machine pause/resume is inert while a decision's item is settled).
      // A pending CHOICE owns everything else: `h`/`b` are inert, Space is
      // suspended, and only its own inputs answer it (1..9, 0 with the
      // offer, the arrows and Enter, row clicks) — except the timeline
      // moves, the wheel and `e` (see the gates below), and the two mode
      // keys, `a` and Tab (docs/plan.md Phase 43), which switch their mode
      // there for after the answer. Otherwise the story reads, and `m` and
      // Escape open the screens.
      const owner = () => inputOwnerFor(help.isOpen(), choice.isOpen());
      // The reset box owns the screen too, over the Esc screen: while it
      // is open only its own controls act (its keys ride the map below).
      const storyInput = () =>
        owner() === "story" && !confirm.isOpen() && !map.isOpen();
      const anyPanelOpen = () =>
        confirm.isOpen() || help.isOpen() || map.isOpen();
      const anyScreenOpen = () => anyPanelOpen() || choice.isOpen();
      // The timeline moves are never trapped by a choice (docs/plan.md
      // Phase 27): a wheel notch or `e` leaves a choice screen for the
      // neighbouring screen in story order / the furthest point read, and
      // nothing is answered. Tab works on a choice too (Phase 43): the
      // machine arms skip there for after the answer and moves nothing.
      // Only the panels (the Esc screen, the map, the reset box) still
      // suspend them.
      const timelineGate = (command: () => void) => () => {
        if (anyPanelOpen()) return;
        command();
      };

      // While a panel is open it takes precedence: the cursor-moving
      // commands (space/tab/e/wheel) are suspended until it closes.
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
        toggleSkip: timelineGate(() => machine.toggleSkip()),
        jumpToEnd: timelineGate(walk(() => machine.jumpToEnd())),
        wheelBack: timelineGate(walk(() => machine.wheelBack())),
        wheelForward: timelineGate(walk(() => machine.wheelForward())),
      };

      // `m` (and the Esc screen's `m` row; render/keys.ts `mapKeyAction`):
      // toggles the map, and over the Esc screen REPLACES that screen —
      // the map opens first, so the menu pause never lifts between the two
      // — so the next Escape returns to the game. It opens over a pending
      // decision too.
      function runMapKey(): void {
        const action = mapKeyAction({
          confirmOpen: confirm.isOpen(),
          helpOpen: help.isOpen(),
          mapOpen: map.isOpen(),
        });
        if (action === "close") map.close();
        else if (action === "open") map.open();
        else if (action === "replaceHelp") {
          map.open();
          closeHelp();
        }
        syncMenuPause();
      }

      installKeyMap(
        document,
        {
          // Space over the Esc screen closes it and is consumed — no
          // advance (it is still a gesture, so fullscreen gets its request
          // like any other press when wanted; render/fullscreen.ts). It closes even with a settings button
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
          toggleMap: runMapKey,
          // `a` (README auto-forward bullet): manual is the start, and `a`
          // toggles auto-advance. Turning it off cancels the pending hold;
          // a skip dwell keeps running — skipping is the reader's own run.
          // Space also turns it off (machine `advance()`, Phase 18). Every
          // flip shows its pill (render/autoforward.ts, Phase 20), from
          // the machine's own report, so nothing here syncs it. It works on
          // a choice screen (Phase 43): nothing moves until the answer,
          // whose route then runs in the mode set. The panels keep it.
          toggleAutoForward: () => {
            if (anyPanelOpen()) return;
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
          // the Esc screen, else closes the open map, else opens the
          // Esc screen — and "else" includes OVER a pending choice: the
          // screen wins over everything (the declared exception to choice
          // ownership), the decision waits underneath, its play-all
          // countdown frozen, and is still open when the screen closes. A
          // choice is never closed by Escape: only its own answer ends it.
          // The reset box (Phase 16) is
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
            if (map.isOpen()) {
              map.close();
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
        {
          taking: () => owner() === "choice" && !anyPanelOpen(),
          take: (key) => {
            if (key === "prev" || key === "next") choice.moveCursor(key);
            else if (key === "pick") choice.pickCursor();
            else if (key !== "return") machine.choose(key);
            else if (machine.getState().choice?.continueOption === true) {
              machine.chooseContinue();
            }
          },
        },
      );
      // Over a choice list too long for the window the wheel scrolls the
      // list, not the story; anywhere else it walks (render/choice.ts).
      // While the branch map is up the wheel is the map's (it scrolls Full
      // size), never a story step.
      installWheelInput(
        document,
        {
          wheelBack: timeline.wheelBack,
          wheelForward: timeline.wheelForward,
        },
        (event) => map.ownsWheel() || choice.ownsWheel(event.target),
      );

      // Menus pause the timeline (docs/plan.md Phase 18): while the Esc
      // screen, the branch map or the reset box is up, a running
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
        // The sound tells the Esc screen from the map (render/audio.ts):
        // music and ambience play on under the map, only the voice pauses.
        audio?.setScreens({
          esc: help.isOpen() || confirm.isOpen(),
          map: map.isOpen(),
        });
        const open = anyPanelOpen();
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
      // on item 0, where nothing is earlier. A URL start is the place the
      // reader asked for, not a resume: no notice there.
      else if (startAt < 0 && machine.hasEarlierUnseen()) {
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
