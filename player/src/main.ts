// Kinetic player entry point (docs/plan.md Phases 5, 8, 9): load the
// manifest, build the timeline machine — resuming from the persisted
// frontier and starting on the persisted settings when either exists —
// mount the render shell, install the input map, and wire storage: the
// frontier is persisted as it moves, `b` appends a bookmark, `t` opens the
// bookmark list, and `c` opens the config screen, whose changes apply live
// (machine.setSettings) and persist with the frontier. Composition only —
// rendering lives in src/render/, timing in src/machine/, storage adapters
// in src/storage/.

import { createMachine } from "./machine/machine";
import type { MachineSettings } from "./machine/types";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell } from "./render/app";
import { mountBookmarkOverlay } from "./render/bookmarks";
import { captureVisualThumbnail } from "./render/capture";
import { mountConfigOverlay } from "./render/config";
import { installFirstGestureFullscreen } from "./render/fullscreen";
import { installKeyMap, suspendTimeline } from "./render/keys";
import { loadManifest } from "./render/manifest";
import { installWheelInput } from "./render/wheel";
import { contentSignature, createIdbStorage } from "./storage/idb";
import { createNoopStorage } from "./storage/noop";
import type { Bookmark } from "./storage/types";

/**
 * Frontier-write debounce. A skip burst moves the frontier ~8 times per
 * second; one IndexedDB write per burst-pause is plenty, and the
 * visibilitychange/pagehide flushes below guarantee even a reload right
 * after an advance resumes from the right spot.
 */
const PERSIST_DEBOUNCE_MS = 250;

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
      // Resume: the persisted frontier IS the resume point — the machine
      // derives cursor = frontier - 1 itself, the state the README says a
      // load starts at ("the state the game starts at when loaded"). No
      // record, or an unreadable one, is the first-ever load: item 0.
      const persisted = await storage.loadState().catch(() => null);
      // Settings persist through the `c` screen (docs/plan.md Phase 9):
      // merged over the defaults at machine construction, so a resumed
      // reader reads at the pace they left off at. The machine learns
      // settings only here and through setSettings — never from storage.
      let currentSettings = mergeSettings(persisted?.settings);
      const machine = createMachine({
        items: manifest.items,
        settings: currentSettings,
        resumeFrontier: persisted?.frontier,
      });
      const shell = mountShell({ root, manifest, machine });

      // Persistence: frontier moves need a write (cursor travel inside
      // seen content never changes the resume point), and so does every
      // settings change from the `c` screen — debounced so a skip burst
      // writes once at the pause, and flushed when the page goes away.
      let savedFrontier = machine.getState().frontier;
      let pendingFrontier: number | null = null;
      let settingsDirty = false;
      let persistTimer: ReturnType<typeof setTimeout> | null = null;
      const flushPersist = (): void => {
        if (persistTimer !== null) {
          globalThis.clearTimeout(persistTimer);
          persistTimer = null;
        }
        if (pendingFrontier === null && !settingsDirty) return;
        if (pendingFrontier !== null) {
          savedFrontier = pendingFrontier;
          pendingFrontier = null;
        }
        settingsDirty = false;
        // A storage outage must never break reading or log to the console.
        void storage
          .saveState({ frontier: savedFrontier, settings: currentSettings })
          .catch(() => {});
      };
      const schedulePersist = (): void => {
        if (persistTimer === null) {
          persistTimer = globalThis.setTimeout(
            flushPersist,
            PERSIST_DEBOUNCE_MS,
          );
        }
      };
      machine.subscribe((state) => {
        if (state.frontier === savedFrontier && pendingFrontier === null) {
          return; // nothing moved that a reload would care about
        }
        pendingFrontier = state.frontier;
        schedulePersist();
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushPersist();
      });
      document.addEventListener("pagehide", flushPersist);

      // `b` (README bookmark bullet): the thumbnail is opportunistic — a
      // frame is captured only when it is drawable and the canvas readable
      // (over `file://` Chrome taints it, and null is expected); the
      // durable bookmark is `{timestampMs, itemIndex}`, which the `t` list
      // renders from even without a thumb (render/bookmarks.ts falls back
      // to the manifest item's still).
      const takeBookmark = async (): Promise<void> => {
        const blob = await captureVisualThumbnail(shell.currentVisual());
        const thumbDataUrl = blob === null ? null : await blobToDataUrl(blob);
        const bookmark: Bookmark = {
          id: newBookmarkId(),
          timestampMs: Date.now(),
          itemIndex: machine.getState().cursor,
          thumbDataUrl,
        };
        await storage.addBookmark(bookmark).catch(() => []);
        // The confirmation arrives after the append is durable, and never
        // interferes with `h`: it is not the overlay.
        shell.flash("Bookmarked");
      };

      // `t` (README `t` bullet): the bookmark list panel. It reads the list
      // fresh on every open (bookmarks taken since the last look show up),
      // and an entry click continues the novel at that item — machine.goTo
      // moves the cursor inside seen content and re-arms its timing.
      const overlay = mountBookmarkOverlay({
        root,
        items: manifest.items,
        onPick: (itemIndex) => machine.goTo(itemIndex),
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
      // queues the persist write, debounced and flushed like the frontier.
      const config = mountConfigOverlay({
        root,
        settings: () => currentSettings,
        onChange: (next) => {
          currentSettings = next;
          machine.setSettings(next);
          settingsDirty = true;
          schedulePersist();
        },
      });
      // While the panel is open it takes precedence: the cursor-moving
      // commands (space/tab/e/wheel) are suspended until it closes. `b`
      // still bookmarks the current item, `h` still toggles text.
      const timeline = suspendTimeline(
        {
          advance: () => machine.advance(),
          toggleSkip: () => machine.toggleSkip(),
          jumpToUnseen: () => machine.jumpToUnseen(),
          wheelBack: () => machine.wheelBack(),
          wheelForward: () => machine.wheelForward(),
        },
        () => overlay.isOpen() || config.isOpen(),
      );

      // Only one full-screen screen is open at a time — opening one
      // closes the other — so Escape and the suspension gate stay
      // unambiguous about which panel they face.
      installKeyMap(document, {
        advance: timeline.advance,
        toggleText: () => shell.toggleText(),
        toggleSkip: timeline.toggleSkip,
        jumpToUnseen: timeline.jumpToUnseen,
        bookmark: () => {
          void takeBookmark();
        },
        toggleBookmarks: () => {
          if (overlay.isOpen()) overlay.close();
          else {
            config.close();
            showBookmarks();
          }
        },
        toggleConfig: () => {
          if (config.isOpen()) config.close();
          else {
            overlay.close();
            config.open();
          }
        },
        dismissOverlay: () => {
          config.close();
          overlay.close();
        },
      });
      installWheelInput(document, {
        wheelBack: timeline.wheelBack,
        wheelForward: timeline.wheelForward,
      });
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
