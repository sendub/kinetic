// Fallback adapter for hosts without IndexedDB (docs/plan.md Phase 8): the
// player still runs, it just remembers nothing across a reload. A page-
// lifetime in-memory store is exactly that behaviour, so this reuses the
// memory fake instead of a second adapter no one can tell from one at
// reload time.

import { createMemoryStorage } from "./memory";
import type { Storage } from "./types";

export function createNoopStorage(): Storage {
  return createMemoryStorage();
}
