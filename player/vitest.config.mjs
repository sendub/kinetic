// Tests see the build's compile-time constants (scripts/version.mjs), so
// src/version.ts reads the repo's VERSION here as in the bundle.
import { defineConfig } from "vitest/config";
import { VERSION_DEFINE } from "./scripts/version.mjs";

export default defineConfig({ define: VERSION_DEFINE });
