// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "./build.mjs";
import { startPreview } from "./preview.mjs";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function source(overrides = {}, body = "## The problem\n\nA small queue helps.") {
  return `---\n${JSON.stringify({
    title: "A bounded queue",
    description: "Keeping tasks small.",
    date: "2026-01-10",
    author: "Example author",
    draft: true,
    ...overrides,
  })}\n---\n${body}\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-blog-preview-test-"));
  directories.push(root);
  await mkdir(join(root, "website/blog/posts"), { recursive: true });
  await mkdir(join(root, "website/blog/images"));
  await writeFile(join(root, "website/blog/posts/queue.md"), source());
  await writeFile(
    join(root, "website/blog/giscus.json"),
    JSON.stringify({
      repo: "example/project",
      repoId: "R_example",
      category: "Blog comments",
      categoryId: "DIC_example",
    }),
  );
  await writeFile(join(root, "website/sitemap.xml"), "<urlset></urlset>\n");
  await writeFile(join(root, "website/robots.txt"), "User-agent: *\n");
  await writeFile(join(root, "website/blog/README.md"), "Authoring instructions");
  await writeFile(join(root, "website/blog/blog.css"), ".post-body { color: red; }\n");
  await writeFile(
    join(root, "website/blog/images/queue.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  );
  await build({ root });
  const preview = await startPreview({ root, port: 0 });
  servers.push(preview.server);
  return { root, ...preview };
}

// Keep the path verbatim; fetch normalizes dot segments before sending a request.
function get(url: string, path: string, options: { method?: string; host?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = request(
        new URL(url),
        { path, method: options.method, headers: options.host ? { Host: options.host } : {} },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, value] of Object.entries(await snapshot(path))) {
        files[`${entry.name}/${child}`] = value;
      }
    } else if (entry.isFile()) {
      files[entry.name] = (await readFile(path)).toString("base64");
    }
  }
  return files;
}

describe("local blog preview", () => {
  it("binds to loopback and lists drafts and future posts without publishing them", async () => {
    const { root, url, server } = await fixture();
    expect(server.address()).toMatchObject({ address: "127.0.0.1" });
    await writeFile(
      join(root, "website/blog/posts/future.md"),
      source({ title: "A future queue", date: "2999-01-01", draft: false }),
    );
    const redirect = await get(url, "/");
    expect([301, 302, 307, 308]).toContain(redirect.status);
    expect(redirect.headers.location).toBe("/blog/");
    const index = await get(url, "/blog/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("/blog/queue");
    expect(index.body).toContain("/blog/future");
    expect((await get(url, "/blog/future")).body).toContain("A future queue");
    const published = await build({ root });
    expect(published.published).toEqual([]);
    expect(await readFile(join(root, "website/blog/index.html"), "utf8")).not.toContain(
      "/blog/queue",
    );
    expect(await readFile(join(root, "website/sitemap.xml"), "utf8")).not.toContain("/blog/future");
  });

  it("renders saved edits on the next request with actual blog styling and no comments", async () => {
    const { root, url } = await fixture();
    const first = await get(url, "/blog/queue");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-robots-tag"]).toContain("noindex");
    expect(first.body).toMatch(/<meta name="robots" content="noindex, nofollow"\s*\/>/);
    expect(first.body).toContain("<h2>The problem</h2>");
    expect(first.body).toContain('href="/blog/blog.css"');
    for (const widget of ["data-giscus-", 'id="load-comments"', 'id="giscus-container"']) {
      expect(first.body).not.toContain(widget);
    }
    await writeFile(
      join(root, "website/blog/posts/queue.md"),
      source({ title: "An updated queue" }, "## Fresh revision\n\nThe limit is now smaller."),
    );
    const revised = await get(url, "/blog/queue.html");
    expect(revised.status).toBe(200);
    expect(revised.body).toContain("An updated queue");
    expect(revised.body).toContain("<h2>Fresh revision</h2>");
    expect(revised.body).not.toContain("A small queue helps.");
    expect((await get(url, "/blog/")).body).toContain("An updated queue");
  });

  it("leaves all website files unchanged while previewing", async () => {
    const { root, url } = await fixture();
    const before = await snapshot(join(root, "website"));
    await get(url, "/blog/");
    await get(url, "/blog/queue");
    await get(url, "/blog/queue.html");
    expect(await snapshot(join(root, "website"))).toEqual(before);
  });

  it("serves CSS and images with their content types", async () => {
    const { url } = await fixture();
    const css = await get(url, "/blog/blog.css");
    expect(css.status).toBe(200);
    expect(css.body).toContain(".post-body");
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    const image = await get(url, "/blog/images/queue.svg");
    expect(image.status).toBe(200);
    expect(image.body).toContain("<svg");
    expect(image.headers["content-type"]).toMatch(/^image\/svg\+xml/);
  });

  it("denies source files, metadata, dotfiles, traversal and files outside the website", async () => {
    const { root, url } = await fixture();
    await writeFile(join(root, "website/.secret"), "PRIVATE_SENTINEL");
    await mkdir(join(root, "website/.private"));
    await writeFile(join(root, "website/.private/secret.css"), "PRIVATE_SENTINEL");
    await symlink(
      join(root, "website/.private/secret.css"),
      join(root, "website/blog/images/hidden.css"),
    );
    await writeFile(join(root, "website/blog/posts/private.html"), "PRIVATE_SENTINEL");
    await symlink(
      join(root, "website/blog/posts/private.html"),
      join(root, "website/blog/images/source.html"),
    );
    await writeFile(join(root, "private.txt"), "PRIVATE_SENTINEL");
    await symlink(join(root, "private.txt"), join(root, "website/blog/images/outside.txt"));
    await symlink(join(root, "private.txt"), join(root, "website/blog/images/outside.css"));
    await symlink(join(root, "website/blog/posts/queue.md"), join(root, "website/leaked.txt"));
    await symlink(join(root, "website/blog/posts/queue.md"), join(root, "website/leaked.css"));
    for (const path of [
      "/blog/posts/queue.md",
      "/blog/giscus.json",
      "/blog/README.md",
      "/sitemap.xml",
      "/robots.txt",
      "/.secret",
      "/../private.txt",
      "/%2e%2e/private.txt",
      "/blog/%2e%2e/%2e%2e/private.txt",
      "/blog/images/outside.txt",
      "/blog/images/outside.css",
      "/blog/images/hidden.css",
      "/blog/images/source.html",
      "/leaked.txt",
      "/leaked.css",
    ]) {
      const result = await get(url, path);
      expect(result.status, path).toBeGreaterThanOrEqual(400);
      expect(result.body, path).not.toContain("PRIVATE_SENTINEL");
      expect(result.body, path).not.toContain("A small queue helps.");
    }
    expect((await get(url, "/blog/missing")).status).toBe(404);
  });

  it("rejects foreign hosts, writes, malformed URLs and invalid ports", async () => {
    const { root, url } = await fixture();
    const foreign = await get(url, "/blog/queue", { host: "example.com" });
    expect(foreign.status).toBe(403);
    expect(foreign.body).not.toContain("A small queue helps.");
    const write = await get(url, "/blog/queue", { method: "POST" });
    expect(write.status).toBe(405);
    expect(write.headers.allow).toContain("GET");
    const head = await get(url, "/blog/queue", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toMatch(/^text\/html/);
    expect((await get(url, "/blog/%zz")).status).toBe(400);
    for (const port of [-1, 65536, 1.5, NaN]) {
      await expect(startPreview({ root, port })).rejects.toThrow(/port/i);
    }
  });

  it("shows escaped rendering errors and recovers after the draft is repaired", async () => {
    const { root, url } = await fixture();
    await writeFile(
      join(root, "website/blog/posts/queue.md"),
      source({}, '[broken](javascript:alert("<script>"))'),
    );
    const broken = await get(url, "/blog/queue");
    expect(broken.status).toBe(500);
    expect(broken.headers["content-type"]).toMatch(/^text\/html/);
    expect(broken.body).not.toContain("<script>");
    expect(broken.body).toMatch(/preview|render|Markdown/i);
    await writeFile(join(root, "website/blog/posts/queue.md"), source());
    expect((await get(url, "/blog/queue")).status).toBe(200);
  });
});
