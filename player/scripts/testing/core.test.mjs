// Every Chrome the tools start is silent (docs/plan.md Phase 47 item 12):
// what core.mjs hands puppeteer, recorded by a stand-in for its launch.
// The WebKit driver mutes its own page; puppet.test.mjs pins that the
// adapter refuses a driver that could not.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => []);
vi.mock("puppeteer-core", () => ({
  default: {
    launch: async (options) => {
      launched.push(options);
      return {
        process: () => null,
        disconnect: async () => {},
        close: async () => {},
      };
    },
  },
}));

const { chromePath, killBrowser, launchBrowser, launchChrome } = await import(
  "./core.mjs"
);

// Never created: launchBrowser empties a fresh profile, a no-op here.
const nowhere = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "no-such-profile",
);

describe("launchChrome", () => {
  it("adds --disable-audio-output to the caller's switches, so Chrome opens no audio output", async () => {
    launched.length = 0;
    await launchChrome({
      userDataDir: nowhere,
      protocolTimeout: 30000,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    expect(launched).toEqual([
      {
        executablePath: chromePath,
        headless: true,
        userDataDir: nowhere,
        protocolTimeout: 30000,
        args: ["--no-sandbox", "--disable-gpu", "--disable-audio-output"],
      },
    ]);
  });

  it("is silent with no options at all", async () => {
    launched.length = 0;
    await launchChrome();
    expect(launched[0].args).toEqual(["--disable-audio-output"]);
  });
});

describe("launchBrowser", () => {
  it("starts the scenarios' and openGame's Chrome silent", async () => {
    launched.length = 0;
    const browser = await launchBrowser("chrome", {
      profile: nowhere,
      fresh: true,
      crashDumpsDir: nowhere,
    });
    killBrowser(browser);
    expect(launched).toHaveLength(1);
    expect(launched[0].args).toContain("--disable-audio-output");
    expect(launched[0].userDataDir).toBe(nowhere);
  });
});
