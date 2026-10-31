// Kinetic player entry point (docs/plan.md Phase 5): load the manifest, build
// the timeline machine, mount the render shell, and install the input map.
// Composition only — rendering lives in src/render/, timing in src/machine/.

import { createMachine } from "./machine/machine";
import { DEFAULT_SETTINGS } from "./machine/types";
import { mountError, mountShell } from "./render/app";
import { installFirstGestureFullscreen } from "./render/fullscreen";
import { installKeyMap } from "./render/keys";
import { loadManifest } from "./render/manifest";

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  return (await response.json()) as unknown;
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
    (manifest) => {
      const machine = createMachine({
        items: manifest.items,
        settings: DEFAULT_SETTINGS,
      });
      const shell = mountShell({ root, manifest, machine });
      installKeyMap(document, {
        advance: () => machine.advance(),
        toggleText: () => shell.toggleText(),
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
