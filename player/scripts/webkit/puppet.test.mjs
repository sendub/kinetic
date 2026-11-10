// The adapter refuses a driver it cannot trust (docs/verify-player.md,
// "WebKit"): a stand-in driver, a node one-liner speaking the driver's
// JSON-lines protocol, sends the ready or fatal line under test.
import { describe, expect, it } from "vitest";
import { launchWebKit, REQUIRED_HOOKS } from "./puppet.mjs";

/**
 * A stand-in driver whose first line is `first`; it answers every request,
 * then writes `after[cmd]` (event lines) if given.
 */
const standIn = (first, after = {}) => [
  process.execPath,
  "-e",
  `const after = ${JSON.stringify(after)};
   process.stdout.write(${JSON.stringify(`${JSON.stringify(first)}\n`)});
   require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
     const { id, cmd } = JSON.parse(line);
     process.stdout.write(JSON.stringify({ id, ok: true, value: true }) + "\\n");
     for (const event of after[cmd] ?? []) process.stdout.write(JSON.stringify(event) + "\\n");
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

  it("collects the recording host's messages and a page's own close", async () => {
    const browser = await launchWebKit({
      command: standIn(
        { event: "ready", hooks: hooks() },
        {
          host: [
            {
              event: "hostmessage",
              message: { type: "display", mode: "window" },
            },
            { event: "hostmessage", message: { type: "quit" } },
            { event: "windowclose" },
          ],
        },
      ),
    });
    const page = await browser.newPage();
    const closed = new Promise((resolve) => page.on("close", resolve));
    expect(page.isClosed()).toBe(false);
    await page.installHost("mac-app", "fullscreen");
    await closed;
    expect(page.hostMessages).toEqual([
      { type: "display", mode: "window" },
      { type: "quit" },
    ]);
    expect(page.isClosed()).toBe(true);
    await browser.close();
  });

  it("passes a held key's autoRepeat on and collects the keys that came back to the window", async () => {
    const browser = await launchWebKit({
      command: standIn(
        { event: "ready", hooks: hooks() },
        {
          key: [
            {
              event: "windowkey",
              fate: "dropped",
              code: "KeyZ",
              repeat: true,
            },
          ],
        },
      ),
    });
    const page = await browser.newPage();
    const sent = [];
    const send = page.rpc.send;
    page.rpc.send = (cmd, params) => {
      sent.push({ cmd, ...params });
      return send(cmd, params);
    };
    const cdp = await page.createCDPSession();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "z",
      code: "KeyZ",
      text: "z",
      autoRepeat: true,
    });
    page.rpc.send = send;
    await send("noop"); // the event line lands before this reply
    expect(sent[0]).toMatchObject({
      cmd: "key",
      code: "KeyZ",
      autoRepeat: true,
    });
    expect(page.windowKeys).toEqual([
      { fate: "dropped", code: "KeyZ", repeat: true },
    ]);
    await browser.close();
  });

  it("passes a key's modifiers on and collects its key equivalent answers", async () => {
    const browser = await launchWebKit({
      command: standIn(
        { event: "ready", hooks: hooks() },
        {
          key: [
            { event: "keyequivalent", code: "KeyH", claimed: true },
            { event: "keyequivalent", code: "KeyH", claimed: false },
          ],
        },
      ),
    });
    const page = await browser.newPage();
    const sent = [];
    const send = page.rpc.send;
    page.rpc.send = (cmd, params) => {
      sent.push({ cmd, ...params });
      return send(cmd, params);
    };
    const cdp = await page.createCDPSession();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "h",
      code: "KeyH",
      modifiers: 4,
    });
    page.rpc.send = send;
    await send("noop"); // the event lines land before this reply
    expect(sent[0]).toMatchObject({ cmd: "key", code: "KeyH", modifiers: 4 });
    expect(page.keyEquivalents).toEqual([
      { code: "KeyH", claimed: true },
      { code: "KeyH", claimed: false },
    ]);
    await browser.close();
  });

  it("hands the driver a profile folder to keep its storage in, and the gesture-for-audio switch", async () => {
    // The ready line echoes the arguments the stand-in was started with.
    const command = [
      process.execPath,
      "-e",
      `process.stdout.write(JSON.stringify({ event: "ready", hooks: ${JSON.stringify(hooks())}, argv: process.argv.slice(1) }) + "\\n");
       require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
         const { id, cmd } = JSON.parse(line);
         process.stdout.write(JSON.stringify({ id, ok: true, value: true }) + "\\n");
         if (cmd === "quit") process.exit(0);
       });`,
      "--",
    ];
    const kept = await launchWebKit({ command, profile: "/tmp/kept" });
    expect(kept.ready.argv).toEqual(["--profile=/tmp/kept"]);
    await kept.close();
    const fresh = await launchWebKit({ command });
    expect(fresh.ready.argv).toEqual([]);
    await fresh.close();
    // Test only: sound waits for a key or click, as in Safari.
    const gesture = await launchWebKit({
      command,
      requireGestureForAudio: true,
    });
    expect(gesture.ready.argv).toEqual(["--require-gesture-for-audio"]);
    await gesture.close();
  });

  it("gives the page puppeteer's mouse: moves, presses and releases at a point", async () => {
    const browser = await launchWebKit({
      command: standIn({ event: "ready", hooks: hooks() }),
    });
    const page = await browser.newPage();
    const sent = [];
    const send = page.rpc.send;
    page.rpc.send = (cmd, params) => {
      sent.push({ cmd, ...params });
      return send(cmd, params);
    };
    await page.mouse.click(30, 40);
    await page.mouse.wheel({ deltaY: 100 });
    page.rpc.send = send;
    expect(
      sent.map(({ cmd, type, x, y, deltaY }) => [cmd, type, x, y, deltaY]),
    ).toEqual([
      ["mouse", "mouseMoved", 30, 40, undefined],
      ["mouse", "mousePressed", 30, 40, undefined],
      ["mouse", "mouseReleased", 30, 40, undefined],
      ["mouse", "mouseWheel", 30, 40, 100],
    ]);
    await browser.close();
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
