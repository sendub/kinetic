// Every Chrome the tools start is silent (docs/plan.md Phase 47 items 12
// and 18): what core.mjs hands puppeteer, recorded by a stand-in for its
// launch, and the test sound flag on every page it opens. The WebKit driver
// mutes its own page; puppet.test.mjs pins that the adapter refuses a
// driver that could not, and gives its page the flag too.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const launched = vi.hoisted(() => []);
vi.mock("puppeteer-core", () => {
  // A browser context whose pages record the scripts added for new documents.
  const context = () => ({
    async newPage() {
      return {
        scripts: [],
        async evaluateOnNewDocument(script) {
          this.scripts.push(script);
        },
      };
    },
  });
  return {
    default: {
      launch: async (options) => {
        launched.push(options);
        const main = context();
        return {
          process: () => null,
          disconnect: async () => {},
          close: async () => {},
          defaultBrowserContext: () => main,
          // As puppeteer's: a page of the default context.
          newPage: () => main.newPage(),
          createBrowserContext: async () => context(),
        };
      },
    },
  };
});

const { chromePath, killBrowser, launchBrowser, launchChrome } = await import(
  "./core.mjs"
);
const { TEST_AUDIO_SCRIPT } = await import("./testaudio.mjs");

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

  it("gives every page it opens the test sound flag before its first document, so the player's master gain stays 0", async () => {
    const browser = await launchChrome();
    const page = await browser.newPage();
    const context = await browser.createBrowserContext();
    const other = await context.newPage();
    const tab = await browser.defaultBrowserContext().newPage();
    expect(TEST_AUDIO_SCRIPT).toContain("flag.mute = true");
    for (const opened of [page, other, tab]) {
      expect(opened.scripts).toEqual([TEST_AUDIO_SCRIPT]);
    }
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
