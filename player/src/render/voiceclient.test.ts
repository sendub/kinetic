import { describe, expect, it, vi } from "vitest";
import {
  createVoiceClient,
  type VoiceStatus,
  type VoiceWindow,
} from "./voiceclient";

/** The last element of `list`. */
const last = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

// The page side of the voice bridge (docs/plan.md Phase 52, "The bridge"):
// messages out through the host's `send`, the host's events in through
// `window.__kineticVoice`, each request matched to its answer by id.

function setup() {
  const win: VoiceWindow = {};
  const sent: Record<string, unknown>[] = [];
  const client = createVoiceClient(win, (message) => {
    sent.push(message as Record<string, unknown>);
  });
  const event = (value: unknown): void => win.__kineticVoice?.(value);
  return { win, sent, client, event };
}

const READY: VoiceStatus = { state: "ready", downloadBytes: 3_200_000_000 };

/** Lets the promise callbacks queued so far run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createVoiceClient", () => {
  it("asks for the status as it starts, and knows none until told", () => {
    const { sent, client } = setup();
    expect(sent).toEqual([{ type: "voice", op: "status" }]);
    expect(client.status()).toBeNull();
  });

  it("keeps each status the host pushes and tells its subscribers", () => {
    const { client, event } = setup();
    const heard: VoiceStatus[] = [];
    const stop = client.subscribe((status) => heard.push(status));
    event({
      event: "status",
      state: "installing",
      downloadBytes: 3_200_000_000,
      done: 800,
      total: 3200,
    });
    expect(client.status()).toEqual({
      state: "installing",
      downloadBytes: 3_200_000_000,
      done: 800,
      total: 3200,
    });
    event({
      event: "status",
      state: "error",
      downloadBytes: 1,
      message: "No space",
    });
    expect(client.status()?.message).toBe("No space");
    stop();
    event({ event: "status", state: "absent", downloadBytes: 1 });
    expect(heard.map((s) => s.state)).toEqual(["installing", "error"]);
  });

  it("ignores a status it cannot read, and events that are not objects", () => {
    const { client, event } = setup();
    event({ event: "status", state: "sleeping", downloadBytes: 1 });
    event({ event: "status", state: "ready", downloadBytes: "big" });
    event(null);
    event("status");
    event({ event: "nonsense" });
    expect(client.status()).toBeNull();
  });

  it("sends install, cancel and remove as bare ops", () => {
    const { sent, client } = setup();
    client.install();
    client.cancel();
    client.remove();
    expect(sent.slice(1)).toEqual([
      { type: "voice", op: "install" },
      { type: "voice", op: "cancel" },
      { type: "voice", op: "remove" },
    ]);
  });

  it("registers a voice and resolves with the host's voice id", async () => {
    const { sent, client, event } = setup();
    event({ event: "status", ...READY });
    const voice = client.register("QUJD", "flac", "The tide is in.");
    const message = last(sent);
    expect(message).toMatchObject({
      type: "voice",
      op: "voice",
      data: "QUJD",
      format: "flac",
      text: "The tide is in.",
    });
    expect(typeof message?.id).toBe("string");
    event({ event: "voice", id: "someone-else", voiceId: "x" }); // ignored
    event({ event: "voice", id: message?.id, voiceId: "v-7" });
    await expect(voice).resolves.toBe("v-7");
  });

  it("leaves text out of a registration without it", () => {
    const { sent, client } = setup();
    void client.register("QUJD", "wav").catch(() => undefined);
    expect("text" in (last(sent) ?? {})).toBe(false);
  });

  it("asks for a line in the engine's language it is given", () => {
    const { sent, client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Guten Morgen.", 3, "de");
    void line.result.catch(() => undefined);
    expect(last(sent)).toMatchObject({
      op: "speak",
      id: line.id,
      text: "Guten Morgen.",
      lang: "de",
    });
  });

  it("speaks a line with its priority and resolves with the WAV and its length", async () => {
    const { sent, client, event } = setup();
    event({ event: "status", ...READY });
    const a = client.speak("v-7", "Hello there.", 3, "en");
    const b = client.speak("v-7", "Bye.", 2, "en");
    expect(a.id).not.toBe(b.id);
    expect(sent.slice(-2)).toEqual([
      {
        type: "voice",
        op: "speak",
        id: a.id,
        voiceId: "v-7",
        text: "Hello there.",
        priority: 3,
        lang: "en",
      },
      {
        type: "voice",
        op: "speak",
        id: b.id,
        voiceId: "v-7",
        text: "Bye.",
        priority: 2,
        lang: "en",
      },
    ]);
    event({ event: "speech", id: b.id, wav: "UklGRg==", seconds: 1.5 });
    await expect(b.result).resolves.toEqual({ wav: "UklGRg==", seconds: 1.5 });
    event({ event: "speech", id: a.id, wav: "UklGRg==", seconds: 2 });
    await expect(a.result).resolves.toEqual({ wav: "UklGRg==", seconds: 2 });
  });

  it("rejects a request the host answers with an error, and ignores an error with no id", async () => {
    const { client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Hello.", 3, "en");
    event({ event: "error", code: "engine", message: "The engine stopped." });
    event({
      event: "error",
      id: line.id,
      code: "engine",
      message: "Out of memory.",
    });
    await expect(line.result).rejects.toThrow("Out of memory.");
  });

  it("drops a line: tells the host, rejects at once, and ignores its late answer", async () => {
    const { sent, client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Hello.", 3, "en");
    const failed = vi.fn();
    line.result.catch(failed);
    client.drop(line.id);
    expect(last(sent)).toEqual({ type: "voice", op: "drop", id: line.id });
    await settle();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(() =>
      event({ event: "speech", id: line.id, wav: "UklGRg==", seconds: 1 }),
    ).not.toThrow();
    client.drop(line.id); // twice: nothing more is sent
    expect(sent.filter((m) => m.op === "drop")).toHaveLength(1);
  });

  it("rejects a line the host drops on its own", async () => {
    const { client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Hello.", 3, "en");
    event({ event: "dropped", id: line.id });
    await expect(line.result).rejects.toThrow();
  });

  it("rejects every request still waiting once the status leaves ready", async () => {
    const { client, event } = setup();
    event({ event: "status", ...READY });
    const voice = client.register("QUJD", "wav");
    const line = client.speak("v-7", "Hello.", 3, "en");
    event({ event: "status", state: "absent", downloadBytes: 1 });
    await expect(voice).rejects.toThrow();
    await expect(line.result).rejects.toThrow();
  });

  it("reads a speech event whose fields are wrong as a failure, not a line", async () => {
    const { client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Hello.", 3, "en");
    event({ event: "speech", id: line.id, wav: 7, seconds: 1 });
    await expect(line.result).rejects.toThrow();
  });

  it("takes its handler off the window when destroyed, and rejects what waits", async () => {
    const { win, client, event } = setup();
    event({ event: "status", ...READY });
    const line = client.speak("v-7", "Hello.", 3, "en");
    client.destroy();
    expect(win.__kineticVoice).toBeUndefined();
    await expect(line.result).rejects.toThrow();
  });

  it("keeps quiet when the host's send throws", () => {
    const win: VoiceWindow = {};
    const client = createVoiceClient(win, () => {
      throw new Error("refused");
    });
    expect(() => client.install()).not.toThrow();
  });
  describe("streamed lines", () => {
    it("asks for chunks with stream: true only when given a chunk listener", () => {
      const { sent, client, event } = setup();
      event({ event: "status", ...READY });
      const plain = client.speak("v-7", "Plain.", 3, "en");
      const streamed = client.speak(
        "v-7",
        "Streamed.",
        3,
        "en",
        () => undefined,
      );
      const [a, b] = sent.slice(-2);
      expect(a?.id).toBe(plain.id);
      expect("stream" in (a ?? {})).toBe(false);
      expect(b).toEqual({
        type: "voice",
        op: "speak",
        id: streamed.id,
        voiceId: "v-7",
        text: "Streamed.",
        priority: 3,
        lang: "en",
        stream: true,
      });
    });

    it("hands each chunk to its line's listener in order, then settles it with the whole line", async () => {
      const { client, event } = setup();
      event({ event: "status", ...READY });
      const heard: unknown[] = [];
      const line = client.speak("v-7", "Hello.", 3, "en", (c) => heard.push(c));
      event({
        event: "chunk",
        id: line.id,
        index: 0,
        wav: "AAA=",
        seconds: 0.8,
        final: false,
      });
      event({
        event: "chunk",
        id: line.id,
        index: 1,
        wav: "BBB=",
        seconds: 1.2,
        final: true,
      });
      expect(heard).toEqual([
        { index: 0, wav: "AAA=", seconds: 0.8, final: false },
        { index: 1, wav: "BBB=", seconds: 1.2, final: true },
      ]);
      event({ event: "speech", id: line.id, wav: "WHOLE", seconds: 2 });
      await expect(line.result).resolves.toEqual({ wav: "WHOLE", seconds: 2 });
    });

    it("ignores a chunk for an id it is not waiting on, one for a request with no listener, and one for a voice", () => {
      const { client, event } = setup();
      event({ event: "status", ...READY });
      const heard: unknown[] = [];
      const plain = client.speak("v-7", "Plain.", 3, "en");
      const voice = client.register("QUJD", "wav");
      void voice.catch(() => undefined);
      void plain.result.catch(() => undefined);
      const chunk = (id: unknown) => ({
        event: "chunk",
        id,
        index: 0,
        wav: "AAA=",
        seconds: 1,
        final: false,
      });
      event(chunk("nobody"));
      event(chunk(plain.id));
      event(chunk(undefined));
      event(chunk(7));
      expect(heard).toEqual([]);
      client.speak("v-7", "S.", 3, "en", (c) => heard.push(c));
      event(chunk("k1"));
      expect(heard).toEqual([]);
    });

    it("ignores chunks that come after the line was dropped, answered or failed", async () => {
      const { client, event } = setup();
      event({ event: "status", ...READY });
      const heard: unknown[] = [];
      const listener = (c: unknown) => heard.push(c);
      const dropped = client.speak("v-7", "A.", 3, "en", listener);
      void dropped.result.catch(() => undefined);
      client.drop(dropped.id);
      const answered = client.speak("v-7", "B.", 3, "en", listener);
      event({ event: "speech", id: answered.id, wav: "W", seconds: 1 });
      await answered.result;
      const failed = client.speak("v-7", "C.", 3, "en", listener);
      void failed.result.catch(() => undefined);
      event({ event: "error", id: failed.id, code: "x", message: "no" });
      for (const id of [dropped.id, answered.id, failed.id]) {
        event({
          event: "chunk",
          id,
          index: 0,
          wav: "AAA=",
          seconds: 1,
          final: false,
        });
      }
      expect(heard).toEqual([]);
    });

    it("ignores a chunk whose fields are wrong, and the line is still answered", async () => {
      const { client, event } = setup();
      event({ event: "status", ...READY });
      const heard: unknown[] = [];
      const line = client.speak("v-7", "Hello.", 3, "en", (c) => heard.push(c));
      const bad = [
        { index: "0", wav: "A", seconds: 1, final: false },
        { index: 0, wav: 5, seconds: 1, final: false },
        { index: 0, wav: "A", seconds: "1", final: false },
        { index: 0, wav: "A", seconds: 1, final: "no" },
        { index: -1, wav: "A", seconds: 1, final: false },
      ];
      for (const fields of bad)
        event({ event: "chunk", id: line.id, ...fields });
      expect(heard).toEqual([]);
      event({ event: "speech", id: line.id, wav: "W", seconds: 1 });
      await expect(line.result).resolves.toEqual({ wav: "W", seconds: 1 });
    });

    it("keeps a throwing listener from breaking the client", async () => {
      const { client, event } = setup();
      event({ event: "status", ...READY });
      const line = client.speak("v-7", "Hello.", 3, "en", () => {
        throw new Error("listener");
      });
      expect(() =>
        event({
          event: "chunk",
          id: line.id,
          index: 0,
          wav: "A",
          seconds: 1,
          final: false,
        }),
      ).not.toThrow();
      event({ event: "speech", id: line.id, wav: "W", seconds: 1 });
      await expect(line.result).resolves.toEqual({ wav: "W", seconds: 1 });
    });
  });
});
