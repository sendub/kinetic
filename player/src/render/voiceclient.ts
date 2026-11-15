// The page side of the voice bridge (docs/plan.md Phase 52, "The bridge").
// A game app that offers spoken lines gives the page `window.kineticHost`
// with `voice: true` (render/host.ts). The page sends it
// `{ type: "voice", op, ... }` through `send`:
// - `status`: the current status (the host also pushes it on every change);
// - `install`, `cancel` (the install under way), `remove` (the model, to
//   free its space);
// - `voice` `{ id, data, format, text? }`: registers a voice from its
//   reference clip's bytes (base64) and file extension;
// - `speak` `{ id, voiceId, text, priority }`: asks for a line, higher
//   priority first;
// - `drop` `{ id }`: a line the page no longer needs.
// The host answers by calling `window.__kineticVoice(event)`:
// `{ event: "status", state, downloadBytes, done?, total?, message? }`,
// `{ event: "voice", id, voiceId }`, `{ event: "speech", id, wav, seconds }`
// (the WAV in base64), `{ event: "error", id?, code, message }` and
// `{ event: "dropped", id }`. An event the page cannot read, or for an id it
// is not waiting on, is ignored.
//
// Each request gets an id of its own and a promise its answer settles. A
// request still waiting when the status leaves `ready` (a removal, an error,
// the engine restarting) is rejected, as the host forgets its voices then.

import type { VoiceMessage } from "./host";

declare global {
  // The host calls it with each voice event (set by `createVoiceClient`).
  var __kineticVoice: ((event: unknown) => void) | undefined;
}

/** Where the voice engine stands (the host's `status` event). */
export type VoiceState =
  | "absent"
  | "installing"
  | "ready"
  | "error"
  | "unsupported";

export interface VoiceStatus {
  readonly state: VoiceState;
  /** What the download weighs, in bytes (offered while `absent`). */
  readonly downloadBytes: number;
  /** While installing: how far it has got, out of `total`. */
  readonly done?: number;
  readonly total?: number;
  /** An error's or an unsupported machine's words. */
  readonly message?: string;
}

/** A generated line: a WAV (base64) and its length in seconds. */
export interface Speech {
  readonly wav: string;
  readonly seconds: number;
}

export interface VoiceClient {
  /** The latest status the host gave; null before the first. */
  status(): VoiceStatus | null;
  /** Calls `listener` with each status the host gives; returns the unsubscribe. */
  subscribe(listener: (status: VoiceStatus) => void): () => void;
  install(): void;
  cancel(): void;
  remove(): void;
  /** Registers a voice; resolves with the host's id for it. */
  register(data: string, format: string, text?: string): Promise<string>;
  /** Asks for a line; `id` is what `drop` takes. */
  speak(
    voiceId: string,
    text: string,
    priority: number,
  ): { readonly id: string; readonly result: Promise<Speech> };
  /** Drops a line: the host is told, and its promise rejects at once. */
  drop(id: string): void;
  /** Takes the handler off the window; every waiting request rejects. */
  destroy(): void;
}

/** The slice of `window` the client sets its handler on. */
export interface VoiceWindow {
  __kineticVoice?: ((event: unknown) => void) | undefined;
}

const STATES = new Set<string>([
  "absent",
  "installing",
  "ready",
  "error",
  "unsupported",
]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A status event as a status, or null when it is not one. */
function readStatus(event: Record<string, unknown>): VoiceStatus | null {
  const { state, downloadBytes, done, total, message } = event;
  if (typeof state !== "string" || !STATES.has(state)) return null;
  if (!finite(downloadBytes)) return null;
  return {
    state: state as VoiceState,
    downloadBytes,
    ...(finite(done) ? { done } : {}),
    ...(finite(total) ? { total } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

interface Waiting {
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** What its answer must carry to settle it. */
  readonly kind: "voice" | "speech";
}

export function createVoiceClient(
  win: VoiceWindow,
  send: (message: VoiceMessage) => void,
): VoiceClient {
  let status: VoiceStatus | null = null;
  const listeners = new Set<(status: VoiceStatus) => void>();
  const waiting = new Map<string, Waiting>();
  let serial = 0;

  const post = (message: VoiceMessage): void => {
    try {
      send(message);
    } catch {
      // A host that refuses the message leaves things as they are.
    }
  };

  const settle = (id: unknown, run: (w: Waiting) => void): void => {
    if (typeof id !== "string") return;
    const w = waiting.get(id);
    if (w === undefined) return;
    waiting.delete(id);
    run(w);
  };

  const rejectAll = (why: string): void => {
    const all = [...waiting.values()];
    waiting.clear();
    for (const w of all) w.reject(new Error(why));
  };

  const receive = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const event = raw as Record<string, unknown>;
    switch (event.event) {
      case "status": {
        const next = readStatus(event);
        if (next === null) return;
        status = next;
        if (next.state !== "ready") rejectAll(`voice engine ${next.state}`);
        for (const listener of [...listeners]) listener(next);
        return;
      }
      case "voice":
        settle(event.id, (w) => {
          if (w.kind === "voice" && typeof event.voiceId === "string") {
            w.resolve(event.voiceId);
          } else w.reject(new Error("the host's voice answer is unreadable"));
        });
        return;
      case "speech":
        settle(event.id, (w) => {
          if (
            w.kind === "speech" &&
            typeof event.wav === "string" &&
            finite(event.seconds)
          ) {
            w.resolve({ wav: event.wav, seconds: event.seconds });
          } else w.reject(new Error("the host's speech answer is unreadable"));
        });
        return;
      case "error":
        settle(event.id, (w) =>
          w.reject(
            new Error(
              typeof event.message === "string"
                ? event.message
                : "the voice engine failed",
            ),
          ),
        );
        return;
      case "dropped":
        settle(event.id, (w) => w.reject(new Error("dropped by the host")));
        return;
    }
  };
  win.__kineticVoice = receive;

  /** A request: its id, and a promise its answer settles. */
  function request<T>(kind: Waiting["kind"]): {
    id: string;
    result: Promise<T>;
  } {
    serial += 1;
    const id = `k${String(serial)}`;
    const result = new Promise<T>((resolve, reject) => {
      waiting.set(id, {
        kind,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    return { id, result };
  }

  post({ type: "voice", op: "status" });

  return {
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    install: () => post({ type: "voice", op: "install" }),
    cancel: () => post({ type: "voice", op: "cancel" }),
    remove: () => post({ type: "voice", op: "remove" }),
    register(data, format, text) {
      const { id, result } = request<string>("voice");
      post({
        type: "voice",
        op: "voice",
        id,
        data,
        format,
        ...(text === undefined ? {} : { text }),
      });
      return result;
    },
    speak(voiceId, text, priority) {
      const { id, result } = request<Speech>("speech");
      post({ type: "voice", op: "speak", id, voiceId, text, priority });
      return { id, result };
    },
    drop(id) {
      if (!waiting.has(id)) return;
      settle(id, (w) => w.reject(new Error("dropped")));
      post({ type: "voice", op: "drop", id });
    },
    destroy() {
      if (win.__kineticVoice === receive) win.__kineticVoice = undefined;
      listeners.clear();
      rejectAll("voice client closed");
    },
  };
}
