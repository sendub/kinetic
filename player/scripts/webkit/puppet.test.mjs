// The adapter refuses a driver it cannot trust (docs/verify-player.md,
// "WebKit"): a stand-in driver, a node one-liner speaking the driver's
// JSON-lines protocol, sends the ready or fatal line under test.
import { describe, expect, it } from "vitest";
import { launchWebKit, REQUIRED_HOOKS } from "./puppet.mjs";

/** A stand-in driver whose first line is `first`; it answers every request. */
const standIn = (first) => [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(`${JSON.stringify(first)}\n`)});
   require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
     const { id, cmd } = JSON.parse(line);
     process.stdout.write(JSON.stringify({ id, ok: true, value: true }) + "\\n");
     if (cmd === "quit") process.exit(0);
   });`,
];
const hooks = (missing = []) =>
  Object.fromEntries(REQUIRED_HOOKS.map((h) => [h, !missing.includes(h)]));

describe("launchWebKit", () => {
  it("starts when the ready line reports every hook", async () => {
    const browser = await launchWebKit({
      command: standIn({ event: "ready", hooks: hooks() }),
    });
    expect(browser.ready.hooks).toEqual(hooks());
    await browser.close();
    expect(browser.process().exitCode).toBe(0);
  });

  it("refuses, naming each missing hook", async () => {
    const missing = ["_simulateMouseMove:", "_setOverrideDeviceScaleFactor:"];
    const command = standIn({ event: "ready", hooks: hooks(missing) });
    await expect(launchWebKit({ command })).rejects.toThrow(
      "lacks the private hooks _setOverrideDeviceScaleFactor:, _simulateMouseMove:",
    );
  });

  it("refuses a ready line with no hook report at all", async () => {
    await expect(
      launchWebKit({ command: standIn({ event: "ready" }) }),
    ).rejects.toThrow(REQUIRED_HOOKS.join(", "));
  });

  it("passes on the driver's fatal line (a window that would show)", async () => {
    const command = standIn({
      event: "fatal",
      error: "the driver window would show on screen; refusing to show it",
    });
    await expect(launchWebKit({ command })).rejects.toThrow(
      "WebKit driver: the driver window would show on screen",
    );
  });
});
