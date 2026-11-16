// The sound controls' pure parts (render/volumes.ts, docs/plan.md Phase 47
// item 7): the volume steps and readout, which rows the Volumes sheet has,
// and the `v` pill. The sheet itself (focus, keys, Esc) is walked in a real
// browser by screens.scenario.mjs.

import { describe, expect, it } from "vitest";
import type { MachineSettings } from "../machine/types";
import { DEFAULT_SETTINGS } from "../machine/types";
import {
  byAction,
  byClass,
  FakeDocument,
  type FakeElement,
  find,
  walk,
} from "./fakedom.testkit";
import type { SoundContent } from "./soundrows";
import type { VoiceStatus } from "./voiceclient";
import {
  mountVolumesOverlay,
  soundMessage,
  stepVolume,
  VOLUME_STEP,
  volumeLabel,
  volumeRows,
} from "./volumes";

describe("stepVolume (0 to 1 in steps of 0.1)", () => {
  it("walks the 0.1 grid both ways, landing on exact tenths", () => {
    expect(VOLUME_STEP).toBe(0.1);
    expect(stepVolume(1, -1)).toBe(0.9);
    expect(stepVolume(0.7, 1)).toBe(0.8);
    expect(stepVolume(0.1, 2)).toBe(0.3);
    // Seven presses down from full: 0.3, not 0.30000000000000004.
    let v = 1;
    for (let i = 0; i < 7; i += 1) v = stepVolume(v, -1);
    expect(v).toBe(0.3);
  });

  it("snaps a value off the grid (a drag, an imported file) and clamps to 0-1", () => {
    expect(stepVolume(0.33, 0)).toBe(0.3);
    expect(stepVolume(0.66, 0)).toBe(0.7);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(1, 1)).toBe(1);
    expect(stepVolume(-3, 0)).toBe(0);
    expect(stepVolume(7, 0)).toBe(1);
  });
});

describe("volumeLabel (the readout)", () => {
  it("reads as a percentage", () => {
    expect(volumeLabel(1)).toBe("100%");
    expect(volumeLabel(0.9)).toBe("90%");
    expect(volumeLabel(0.3)).toBe("30%");
    expect(volumeLabel(0)).toBe("0%");
  });
});

/** The content mixes the rows follow (render/soundrows.ts). */
const content = (over: Partial<SoundContent> = {}): SoundContent => {
  const base = {
    music: false,
    effects: false,
    recordedVoice: false,
    needsModel: false,
    ...over,
  };
  const voice = base.recordedVoice || base.needsModel;
  return { ...base, voice, any: base.music || base.effects || voice };
};
const labels = (c: SoundContent): string[] =>
  volumeRows(c).map((row) => row.label);

describe("volumeRows (the Volumes sheet follows what the game has)", () => {
  it("has a row only for each kind of sound the game has", () => {
    expect(labels(content())).toEqual([]);
    expect(labels(content({ music: true }))).toEqual(["Music"]);
    expect(labels(content({ effects: true }))).toEqual(["Effects"]);
    expect(labels(content({ needsModel: true }))).toEqual(["Voice"]);
    expect(labels(content({ recordedVoice: true }))).toEqual(["Voice"]);
    expect(
      labels(content({ music: true, effects: true, recordedVoice: true })),
    ).toEqual(["Music", "Effects", "Voice"]);
    expect(
      volumeRows(content({ music: true, effects: true, needsModel: true })).map(
        (row) => row.setting,
      ),
    ).toEqual(["musicVolume", "effectsVolume", "voiceVolume"]);
  });

  it("samples Effects and Voice at their new level; Music plays under the sheet already", () => {
    expect(
      volumeRows(
        content({ music: true, effects: true, recordedVoice: true }),
      ).map((row) => row.sample),
    ).toEqual([null, "effects", "voice"]);
  });
});

// --- the sheet itself, on the fake DOM -------------------------------------

const ABSENT: VoiceStatus = { state: "absent", downloadBytes: 3_300_000_000 };

/** A voice model host: a status to set, and what was asked. */
function modelHost(initial: VoiceStatus | null) {
  let status = initial;
  const listeners = new Set<() => void>();
  const asked: string[] = [];
  return {
    asked,
    listeners,
    set(next: VoiceStatus | null): void {
      status = next;
      for (const listener of [...listeners]) listener();
    },
    options: {
      status: () => status,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onInstall: () => asked.push("install"),
      onCancel: () => asked.push("cancel"),
      onRemove: () => asked.push("remove"),
    },
  };
}

function mountSheet(
  c: SoundContent,
  host: ReturnType<typeof modelHost> | null = null,
  settings: MachineSettings = DEFAULT_SETTINGS,
) {
  const doc = new FakeDocument();
  const root = doc.createElement("div");
  const changes: MachineSettings[] = [];
  const samples: string[] = [];
  const opens: boolean[] = [];
  let current = settings;
  const overlay = mountVolumesOverlay({
    root: root as unknown as HTMLElement,
    content: c,
    ...(host === null ? {} : { voiceModel: host.options }),
    settings: () => current,
    onChange: (next) => {
      current = next;
      changes.push(next);
    },
    onSample: (group) => samples.push(group),
    onOpenChange: (open) => opens.push(open),
  });
  return { doc, root, overlay, changes, samples, opens };
}

const voiceRow = (root: FakeElement): FakeElement =>
  find(
    root,
    "the Voice row",
    (el) => el.getAttribute("data-volume") === "voiceVolume",
  );
/** A control of the Voice row by action; hidden or not. */
const control = (root: FakeElement, action: string): FakeElement =>
  byAction(voiceRow(root), action);
/** The actions of the controls in the Voice row that are on show. */
const shownActions = (root: FakeElement): string[] => {
  const row = voiceRow(root);
  const visible = (el: FakeElement): boolean => {
    for (
      let e: FakeElement | null = el;
      e !== null && e !== row.parent;
      e = e.parent
    ) {
      if (e.hidden) return false;
    }
    return true;
  };
  return walk(row)
    .filter(
      (el) => el.getAttribute("data-config-action") !== null && visible(el),
    )
    .map((el) => el.getAttribute("data-config-action") ?? "");
};

describe("the Voice row with no model: recorded lines only", () => {
  it("is the plain slider row, with no download, help or remove", () => {
    const { root } = mountSheet(content({ recordedVoice: true }));
    expect(shownActions(root)).toEqual([
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
    ]);
    expect(walk(root).some((el) => el.className.includes("volume-model"))).toBe(
      false,
    );
  });

  it("has no rows, and so draws no controls, for no sound", () => {
    const { root } = mountSheet(content());
    expect(
      walk(root).some((el) => el.getAttribute("data-volume") !== null),
    ).toBe(false);
  });
});

describe("the Voice row when the model is needed (docs/plan.md Phase 52 item 10)", () => {
  const modelOnly = content({ needsModel: true });

  it("absent: a Download voice model button with its size in place of the slider, then a ? help", () => {
    const { root } = mountSheet(modelOnly, modelHost(ABSENT));
    expect(voiceRow(root).getAttribute("data-state")).toBe("absent");
    expect(shownActions(root)).toEqual([
      "volume-model-download",
      "tip-voice-model",
    ]);
    const download = control(root, "volume-model-download");
    expect(download.textContent).toBe("Download voice model (3.3 GB)");
    expect(download.getAttribute("disabled")).toBeNull();
    // The slider, its steps and the readout are not on show.
    for (const action of [
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
    ]) {
      expect(control(root, action).hidden).toBe(true);
    }
    expect(byClass(voiceRow(root), "config-value").hidden).toBe(true);
    // No remove button before the install.
    expect(control(root, "volume-voice-remove").hidden).toBe(true);
  });

  it("explains the download in a ? help the screen reader reads", () => {
    const { root } = mountSheet(modelOnly, modelHost(ABSENT));
    const tip = byClass(voiceRow(root), "config-tip-text");
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toMatch(/made on this computer/);
    expect(tip.textContent).toMatch(/characters' voices/);
    expect(tip.textContent).toMatch(/downloaded once/);
    expect(tip.textContent).toMatch(/every Kinetic game on this computer/);
    expect(tip.textContent).toMatch(/3\.3 GB/);
    const mark = control(root, "tip-voice-model");
    expect(mark.getAttribute("aria-label")).toBe("About the voice model");
    expect(mark.getAttribute("aria-describedby")).toBe(tip.id);
    expect(
      control(root, "volume-model-download").getAttribute("aria-describedby"),
    ).toBe(tip.id);
  });

  it("downloads on a click of the button", () => {
    const host = modelHost(ABSENT);
    const { root } = mountSheet(modelOnly, host);
    control(root, "volume-model-download").fire("click");
    expect(host.asked).toEqual(["install"]);
  });

  it("installing: a progress bar with its percent and Cancel", () => {
    const host = modelHost(ABSENT);
    const { root } = mountSheet(modelOnly, host);
    host.set({
      ...ABSENT,
      state: "installing",
      done: 1_386_000_000,
      total: 3_300_000_000,
    });
    expect(voiceRow(root).getAttribute("data-state")).toBe("installing");
    expect(shownActions(root)).toEqual(["volume-model-cancel"]);
    const bar = byClass(voiceRow(root), "volume-progress");
    expect(bar.hidden).toBe(false);
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(byClass(voiceRow(root), "volume-progress-fill").style.width).toBe(
      "42%",
    );
    expect(byClass(voiceRow(root), "volume-progress-value").textContent).toBe(
      "42%",
    );
    control(root, "volume-model-cancel").fire("click");
    expect(host.asked).toEqual(["cancel"]);
  });

  it("error: the message and Retry, which downloads again", () => {
    const host = modelHost({
      ...ABSENT,
      state: "error",
      message: "The download failed.",
    });
    const { root } = mountSheet(modelOnly, host);
    expect(shownActions(root)).toEqual(["volume-model-retry"]);
    expect(byClass(voiceRow(root), "volume-model-message").textContent).toBe(
      "The download failed.",
    );
    control(root, "volume-model-retry").fire("click");
    expect(host.asked).toEqual(["install"]);
  });

  it("unsupported: the button greyed out, and the ? says why", () => {
    const why = "Spoken lines need a Mac with Apple silicon.";
    const { root } = mountSheet(
      modelOnly,
      modelHost({ ...ABSENT, state: "unsupported", message: why }),
    );
    const download = control(root, "volume-model-download");
    expect(download.hidden).toBe(false);
    expect(download.getAttribute("disabled")).toBe("");
    expect(download.getAttribute("aria-disabled")).toBe("true");
    expect(byClass(voiceRow(root), "config-tip-text").textContent).toBe(why);
    expect(shownActions(root)).toContain("tip-voice-model");
    // A click on the greyed button asks for nothing.
    const host = modelHost({ ...ABSENT, state: "unsupported", message: why });
    const again = mountSheet(modelOnly, host);
    control(again.root, "volume-model-download").fire("click");
    expect(host.asked).toEqual([]);
  });

  it("says it is checking until the host gives a status", () => {
    const host = modelHost(null);
    const { root } = mountSheet(modelOnly, host);
    expect(shownActions(root)).toEqual([]);
    expect(byClass(voiceRow(root), "volume-model-message").textContent).toBe(
      "Checking…",
    );
    host.set(ABSENT);
    expect(shownActions(root)).toEqual([
      "volume-model-download",
      "tip-voice-model",
    ]);
  });

  it("ready: the volume slider, and a small remove voice model button beside the label", () => {
    const host = modelHost({ ...ABSENT, state: "ready" });
    const { root, changes } = mountSheet(modelOnly, host);
    expect(shownActions(root)).toEqual([
      "volume-voice-remove",
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
    ]);
    const remove = control(root, "volume-voice-remove");
    expect(remove.textContent).toBe("Remove voice model");
    expect(remove.getAttribute("aria-label")).toBe(
      "Remove the voice model from this computer to free its space",
    );
    // It sits right after the label, before the readout.
    const row = voiceRow(root);
    expect(row.children[0]?.className).toBe("config-label");
    expect(row.children[1]).toBe(remove);
    remove.fire("click");
    expect(host.asked).toEqual(["remove"]);
    // The slider is the Voice volume; no Spoken lines switch anywhere.
    control(root, "volume-voice-down").fire("click");
    expect(changes[changes.length - 1]?.voiceVolume).toBe(0.9);
    expect(
      walk(root).some(
        (el) => el.getAttribute("data-config-action") === "spoken",
      ),
    ).toBe(false);
  });

  it("recorded lines as well: the slider stays, and the download takes a second line", () => {
    const both = content({ recordedVoice: true, needsModel: true });
    const host = modelHost(ABSENT);
    const { root } = mountSheet(both, host);
    expect(shownActions(root)).toEqual([
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
      "volume-model-download",
      "tip-voice-model",
    ]);
    // The download is the row's last child: its second line.
    const row = voiceRow(root);
    expect(row.children[row.children.length - 1]?.className).toContain(
      "volume-model",
    );
    host.set({ ...ABSENT, state: "installing", done: 1, total: 4 });
    expect(shownActions(root)).toEqual([
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
      "volume-model-cancel",
    ]);
    host.set({ ...ABSENT, state: "ready" });
    expect(shownActions(root)).toEqual([
      "volume-voice-remove",
      "volume-voice-down",
      "volume-voice-slider",
      "volume-voice-up",
    ]);
  });

  it("repaints live while the sheet is open, and frees its listener", () => {
    const host = modelHost(ABSENT);
    const { root } = mountSheet(modelOnly, host);
    expect(host.listeners.size).toBe(1);
    host.set({ ...ABSENT, state: "installing", done: 0, total: 1 });
    expect(voiceRow(root).getAttribute("data-state")).toBe("installing");
  });
});

describe("the sheet as a modal", () => {
  const all = content({ music: true, effects: true, needsModel: true });
  const tab = (doc: FakeDocument, shift = false): void =>
    doc.dispatch("keydown", {
      key: "Tab",
      shiftKey: shift,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => undefined,
    });

  const actionOf = (doc: FakeDocument): string =>
    doc.activeElement?.getAttribute("data-config-action") ??
    doc.activeElement?.className ??
    "none";

  it("moves focus through every control on show, the download and its ? included, and wraps", () => {
    const host = modelHost(ABSENT);
    const { doc, overlay } = mountSheet(all, host);
    const opener = doc.createElement("button");
    overlay.open(opener as unknown as HTMLElement);
    const seen: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      seen.push(actionOf(doc));
      tab(doc);
    }
    expect(seen).toEqual([
      "volume-music-slider", // focus starts on the first slider
      "volume-music-up",
      "volume-effects-down",
      "volume-effects-slider",
      "volume-effects-up",
      "volume-model-download", // the Voice slider is not on show
      "tip-voice-model",
      "volumes-done",
      "volume-music-down", // wrapped
      "volume-music-slider",
      "volume-music-up",
    ]);
    tab(doc, true);
    tab(doc, true);
    tab(doc, true);
    expect(actionOf(doc)).toBe("volume-music-down");
    tab(doc, true); // backwards from the first wraps to the last
    expect(actionOf(doc)).toBe("volumes-done");
  });

  it("skips the greyed download of a machine that cannot run the voices, keeping the ?", () => {
    const host = modelHost({
      ...ABSENT,
      state: "unsupported",
      message: "No.",
    });
    const { doc, overlay } = mountSheet(content({ needsModel: true }), host);
    overlay.open(null);
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(actionOf(doc));
      tab(doc);
    }
    expect(seen).toEqual([
      "tip-voice-model",
      "volumes-done",
      "tip-voice-model",
    ]);
  });

  it("returns focus to the opener when it closes", () => {
    const { doc, overlay, opens } = mountSheet(all, modelHost(ABSENT));
    const opener = doc.createElement("button");
    overlay.open(opener as unknown as HTMLElement);
    expect(overlay.isOpen()).toBe(true);
    overlay.close();
    expect(doc.activeElement).toBe(opener);
    expect(opens).toEqual([true, false]);
  });

  it("moves focus to the new slider when the download finishes under it", () => {
    const host = modelHost({
      ...ABSENT,
      state: "installing",
      done: 1,
      total: 2,
    });
    const { doc, root, overlay } = mountSheet(
      content({ needsModel: true }),
      host,
    );
    overlay.open(null);
    control(root, "volume-model-cancel").focus();
    host.set({ ...ABSENT, state: "ready" });
    expect(doc.activeElement).toBe(control(root, "volume-voice-slider"));
    // And from the download button itself.
    const again = modelHost(ABSENT);
    const second = mountSheet(content({ needsModel: true }), again);
    second.overlay.open(null);
    control(second.root, "volume-model-download").focus();
    again.set({ ...ABSENT, state: "ready" });
    expect(second.doc.activeElement).toBe(
      control(second.root, "volume-voice-slider"),
    );
  });

  it("keeps focus in the sheet when a state hides the focused control", () => {
    const host = modelHost(ABSENT);
    const { doc, root, overlay } = mountSheet(
      content({ needsModel: true }),
      host,
    );
    overlay.open(null);
    control(root, "volume-model-download").focus();
    host.set({ ...ABSENT, state: "installing", done: 1, total: 2 });
    expect(doc.activeElement).toBe(control(root, "volume-model-cancel"));
    // The model removed while the slider had focus: back to the download.
    host.set({ ...ABSENT, state: "ready" });
    control(root, "volume-voice-remove").focus();
    host.set(ABSENT);
    expect(doc.activeElement).toBe(control(root, "volume-model-download"));
  });

  it("does not take Tab while the confirmation box is over it", () => {
    let held = false;
    const doc = new FakeDocument();
    const root = doc.createElement("div");
    const overlay = mountVolumesOverlay({
      root: root as unknown as HTMLElement,
      content: all,
      settings: () => DEFAULT_SETTINGS,
      onChange: () => undefined,
      onSample: () => undefined,
      onOpenChange: () => undefined,
      suspended: () => held,
    });
    overlay.open(null);
    const before = doc.activeElement;
    held = true;
    let prevented = false;
    doc.dispatch("keydown", {
      key: "Tab",
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
    expect(doc.activeElement).toBe(before);
  });
});

describe("soundMessage (the v pill)", () => {
  it("names the state sound is now in", () => {
    expect(soundMessage(true)).toBe("Sound on");
    expect(soundMessage(false)).toBe("Sound off");
  });
});
