// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, parsePost, renderIndex, renderPost } from "./build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Resolve symlinks before reading so the preview never serves files outside the site.
async function sitePath(website, path) {
  const candidate = await realpath(join(website, path));
  const rel = relative(website, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    const error = new Error("File is outside the website directory");
    error.code = "ENOENT";
    throw error;
  }
  return candidate;
}

/** Render on request, in memory: previews cannot become deployable build output. */
export async function startPreview({ root = ROOT, port = 4173 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be an integer between 0 and 65535");
  const website = await realpath(join(root, "website"));
  const readPost = async (filename) =>
    parsePost(await readFile(await sitePath(website, `blog/posts/${filename}`), "utf8"), filename);

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      response.writeHead(status, { "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    try {
      // Reject foreign hosts, including DNS names resolving to loopback.
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(request.headers.host ?? "")) {
        send(403, "Local preview requires a localhost address.");
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        send(405, "Method not allowed");
        return;
      }
      let path;
      try {
        path = decodeURIComponent((request.url ?? "/").split("?")[0]);
      } catch {
        send(400, "Invalid URL");
        return;
      }
      if (
        !path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part) => part.startsWith("."))
      ) {
        send(404, "Not found");
        return;
      }
      if (path === "/" || path === "/blog") {
        response.setHeader("Location", "/blog/");
        send(302, "Open /blog/ for local previews.");
        return;
      }
      if (path === "/blog/" || path === "/blog/index.html") {
        const postsDir = await sitePath(website, "blog/posts");
        const filenames = (await readdir(postsDir)).filter((file) => file.endsWith(".md"));
        const posts = await Promise.all(filenames.map(readPost));
        posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
        send(200, renderIndex(posts, { preview: true }), TYPES[".html"]);
        return;
      }
      const post = path.match(/^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.html)?$/);
      if (post) {
        send(
          200,
          renderPost(await readPost(`${post[1]}.md`), undefined, { preview: true }),
          TYPES[".html"],
        );
        return;
      }
      // Serve styling and images, but never Markdown, config, or other source files.
      if (path.startsWith("/blog/posts/") || !TYPES[extname(path)]) {
        send(404, "Not found");
        return;
      }
      const file = await sitePath(website, path.slice(1));
      const resolvedParts = relative(website, file).split(sep);
      if (
        resolvedParts.some((part) => part.startsWith(".")) ||
        (resolvedParts[0] === "blog" && resolvedParts[1] === "posts") ||
        !(await stat(file)).isFile() ||
        !TYPES[extname(file)]
      ) {
        send(404, "Not found");
        return;
      }
      send(200, await readFile(file), TYPES[extname(file)]);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        send(404, "Not found");
      } else {
        send(
          500,
          `<!doctype html><meta charset="utf-8"><title>Preview error</title><h1>Cannot render preview</h1><pre>${escapeHtml(error.message)}</pre><p>Correct the Markdown or front matter, save, and refresh.</p>`,
          TYPES[".html"],
        );
      }
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid =
    args.length === 0 || (args.length === 2 && args[0] === "--port" && /^\d+$/.test(args[1]));
  (valid
    ? startPreview({ port: args.length ? Number(args[1]) : 4173 })
    : Promise.reject(new Error("Usage: node scripts/blog/preview.mjs [--port PORT]"))
  )
    .then(({ server, url }) => {
      process.stdout.write(
        `Blog preview: ${url}/blog/\nIncludes drafts and future posts. Save and refresh to update. Ctrl+C to stop.\n`,
      );
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
