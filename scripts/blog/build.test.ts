// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build, parsePost, renderMarkdown, renderPost } from "./build.mjs";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const settings = {
  repo: "example/project",
  repoId: "R_example",
  category: "Blog comments",
  categoryId: "DIC_example",
};
const metadata = {
  title: "A bounded queue",
  description: "Keeping tasks small.",
  date: "2026-01-10",
  author: "Example author",
  tags: ["Engineering"],
};
function source(
  overrides = {},
  body = "## The problem\n\nSome tasks took too long.\n\n```js\nconst size = 10;\n```\n",
) {
  return `---\n${JSON.stringify({ ...metadata, ...overrides })}\n---\n${body}`;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-blog-"));
  directories.push(root);
  await mkdir(join(root, "website/blog/posts"), { recursive: true });
  await writeFile(join(root, "website/blog/giscus.json"), JSON.stringify(settings));
  await writeFile(
    join(root, "website/sitemap.xml"),
    '<?xml version="1.0"?><urlset><url><loc>https://omnesis.dev/</loc></url>\n</urlset>\n',
  );
  return root;
}
async function post(root: string, slug: string, overrides = {}) {
  await writeFile(join(root, "website/blog/posts", `${slug}.md`), source(overrides));
}

describe("blog publishing", () => {
  it("publishes newest posts first, excludes drafts/future posts, and updates sitemap", async () => {
    const root = await fixture();
    await post(root, "older", { date: "2026-01-01" });
    await post(root, "newer");
    await post(root, "draft", { draft: true });
    await post(root, "future", { date: "2026-02-01" });
    expect((await build({ root, today: "2026-01-20" })).published).toEqual(["newer", "older"]);
    const index = await readFile(join(root, "website/blog/index.html"), "utf8");
    expect(index.indexOf("/blog/newer")).toBeLessThan(index.indexOf("/blog/older"));
    expect(index).not.toContain("/blog/draft");
    expect(index).not.toContain("/blog/future");
    const sitemap = await readFile(join(root, "website/sitemap.xml"), "utf8");
    expect(sitemap).toContain("https://omnesis.dev/blog/newer");
    expect(sitemap).not.toContain("/blog/draft");
    await expect(build({ root, today: "2026-01-20", check: true })).resolves.toMatchObject({
      changed: [],
    });
  });
  it("detects stale output and removes old published pages when a post becomes a draft", async () => {
    const root = await fixture();
    await post(root, "bounded-queue");
    await build({ root });
    await post(root, "bounded-queue", { draft: true });
    await expect(build({ root, check: true })).rejects.toThrow("stale");
    await build({ root });
    await expect(readFile(join(root, "website/blog/bounded-queue.html"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, "website/blog/index.html"), "utf8")).toContain(
      "Posts coming soon",
    );
    expect(await readFile(join(root, "website/sitemap.xml"), "utf8")).not.toContain(
      "/blog/bounded-queue",
    );
  });
  it("refuses to overwrite or remove hand-authored pages", async () => {
    const root = await fixture();
    await writeFile(join(root, "website/blog/index.html"), "Hand-authored");
    await expect(build({ root })).rejects.toThrow("Refusing to overwrite");
    await writeFile(join(root, "website/blog/manual.html"), "Hand-authored");
    await expect(build({ root })).rejects.toThrow("Refusing to remove");
  });
  it("renders Markdown and safe metadata with a stable Giscus identity", () => {
    const parsed = parsePost(source({ title: 'A <queue> & "limits"' }), "bounded-queue.md");
    const html = renderPost(parsed, settings);
    expect(html).toContain("<h2>The problem</h2>");
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain("A &lt;queue&gt; &amp; &quot;limits&quot;");
    expect(html).toContain('data-giscus-term="blog/bounded-queue"');
    expect(html).toContain('data-giscus-category-id="DIC_example"');
    expect(html).not.toContain('src="https://giscus.app/client.js"');
    expect(html).toContain("https://omnesis.dev/blog/bounded-queue");
    expect(html).not.toContain("application/rss+xml");
    expect(renderPost({ ...parsed, title: "Renamed" }, settings)).toContain(
      'data-giscus-term="blog/bounded-queue"',
    );
  });
  it("escapes raw HTML and rejects executable or ambiguous links", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script>");
    for (const link of ["javascript:alert(1)", "//example.com", "data:text/html,test"]) {
      expect(() => renderMarkdown(`[link](${link})`)).toThrow(/Unsupported/);
    }
    expect(renderMarkdown("[Docs](/docs/)")).toContain('href="/docs/"');
    expect(renderMarkdown("![Example](https://example.com/image.png)")).toContain('loading="lazy"');
  });
  it.each([
    [{ date: "2026-02-30" }, "queue.md"],
    [{ draft: "true" }, "queue.md"],
    [{ tags: "tag" }, "queue.md"],
    [{ author: "" }, "queue.md"],
    [{ unsupported: true }, "queue.md"],
    [{}, "../queue.md"],
    [{}, "index.md"],
  ])("rejects invalid metadata or filenames (%j)", (overrides, filename) => {
    expect(() => parsePost(source(overrides), filename)).toThrow();
  });
  it("requires front matter, content, and a single page title", () => {
    expect(() => parsePost("## No metadata", "queue.md")).toThrow("front matter");
    expect(() => parsePost(source({}, ""), "queue.md")).toThrow("empty");
    expect(() => parsePost(source({}, "# Another title"), "queue.md")).toThrow("h1");
  });
});
