// A game folder served over HTTP on this machine, for openGame's `http`
// option and check-game's --http: a folder is static files, so a web host
// serves it as it is (CREATE.md, "Serving from a web host"), and
// this stands in for one. Node's own http module, bound to 127.0.0.1 on a
// port the system picks (or one given); GET and HEAD only; each file with
// its MIME type; byte ranges for media, as a browser asks for a video's or
// a track's parts; 404 for what is not in the folder.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/** The Content-Type of each extension a game folder holds. */
export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jxl": "image/jxl",
  ".ico": "image/x-icon",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
};

/** The MIME type for `path`, by its extension (any case). */
export const mimeType = (path) =>
  MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * The byte span a Range header asks of a file of `size` bytes:
 * `{ start, end }` (inclusive) for one satisfiable range, null for no
 * header or one this server does not read (several ranges, another unit:
 * the whole file is sent, as the standard allows), "unsatisfiable" for a
 * range past the end (416).
 */
export function byteRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    // The last N bytes.
    const length = Number(last);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * The file a request path names in the folder `root` (a real path), or
 * null: outside the folder, through a link out of it, or no such file. A
 * folder's path gives its index.html.
 */
function fileFor(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  let path = resolve(join(root, decoded));
  if (!inside(root, path)) return null;
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    const real = realpathSync(path);
    if (!inside(root, real) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function handle(root, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = fileFor(root, pathname);
  if (file === null) {
    res
      .writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      .end(req.method === "HEAD" ? undefined : `not found: ${pathname}\n`);
    return;
  }
  const size = statSync(file).size;
  const headers = {
    "Content-Type": mimeType(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  const range = byteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res
      .writeHead(416, { ...headers, "Content-Range": `bytes */${size}` })
      .end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range === null ? 200 : 206, {
    ...headers,
    "Content-Length": length,
    ...(range === null
      ? {}
      : { "Content-Range": `bytes ${start}-${end}/${size}` }),
  });
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/**
 * Serves the folder `folder` over HTTP on 127.0.0.1, on `port` (default 0:
 * one the system picks). Resolves with `{ url, port, close }`: `url` the
 * folder's address with a closing slash (`http://127.0.0.1:<port>/`), and
 * close() stopping the server and dropping its open connections.
 */
export async function serveFolder(folder, { port = 0 } = {}) {
  const root = realpathSync(resolve(folder));
  if (!statSync(root).isDirectory()) {
    throw new Error(`serveFolder: ${root} is not a folder`);
  }
  const server = createServer((req, res) => {
    try {
      handle(root, req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const bound = server.address().port;
  let closed = false;
  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}
