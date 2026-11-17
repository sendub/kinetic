import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { byteRange, mimeType, serveFolder } from "./serve.mjs";

describe("byteRange", () => {
  it("reads one range: from-to, from to the end, the last N bytes", () => {
    expect(byteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
  });

  it("sends the whole file for no header or one it does not read", () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
    expect(byteRange("bytes=-", 100)).toBeNull();
  });

  it("refuses a range past the end", () => {
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=9-3", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});

describe("mimeType", () => {
  it("names each kind of file a game folder holds", () => {
    expect(mimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(mimeType("app.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("music.m4a.js")).toBe("text/javascript; charset=utf-8");
    expect(mimeType("manifest.json")).toBe("application/json; charset=utf-8");
    expect(mimeType("v/clip.webm")).toBe("video/webm");
    expect(mimeType("v/clip.MP4")).toBe("video/mp4");
    expect(mimeType("a/track.m4a")).toBe("audio/mp4");
    expect(mimeType("img/a.jxl")).toBe("image/jxl");
    expect(mimeType("img/a.webp")).toBe("image/webp");
    expect(mimeType("img/a.jpg")).toBe("image/jpeg");
    expect(mimeType(".nojekyll")).toBe("application/octet-stream");
  });
});

describe("serveFolder", () => {
  let root;
  let server;
  const body = Buffer.from("0123456789abcdefghij");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "kinetic-serve-"));
    const game = join(root, "game");
    mkdirSync(join(game, "media dir"), { recursive: true });
    writeFileSync(join(game, "index.html"), "<!doctype html>");
    writeFileSync(join(game, "media dir", "clip.webm"), body);
    writeFileSync(join(root, "secret.txt"), "outside");
    symlinkSync(join(root, "secret.txt"), join(game, "link.txt"));
    server = await serveFolder(game);
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves on 127.0.0.1 at a port the system picked", () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect(server.port).toBeGreaterThan(0);
  });

  it("serves a file with its type and length, and the folder's index.html at /", async () => {
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toBe("<!doctype html>");
    const clip = await fetch(`${server.url}media%20dir/clip.webm`);
    expect(clip.status).toBe(200);
    expect(clip.headers.get("content-type")).toBe("video/webm");
    expect(clip.headers.get("accept-ranges")).toBe("bytes");
    expect(clip.headers.get("content-length")).toBe(String(body.length));
    expect(Buffer.from(await clip.arrayBuffer())).toEqual(body);
  });

  it("answers a byte range with 206 and its part, and one past the end with 416", async () => {
    const url = `${server.url}media%20dir/clip.webm`;
    const part = await fetch(url, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${body.length}`);
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    const tail = await fetch(url, { headers: { Range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(await tail.text()).toBe("hij");
    const past = await fetch(url, { headers: { Range: "bytes=99-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${body.length}`);
  });

  it("answers HEAD with the headers and no body", async () => {
    const head = await fetch(`${server.url}media%20dir/clip.webm`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(body.length));
    expect(await head.text()).toBe("");
  });

  it("gives 404 for a missing file, a path out of the folder and a link out of it", async () => {
    for (const path of ["missing.jpg", "..%2Fsecret.txt", "link.txt"]) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses other methods with 405", async () => {
    const res = await fetch(server.url, { method: "POST", body: "x" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("stops serving once closed", async () => {
    const other = await serveFolder(join(root, "game"));
    await other.close();
    await expect(fetch(other.url)).rejects.toThrow();
  });
});
