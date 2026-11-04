// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite, checkDocsLinks } from "./build.mjs";
import { newestStableTag, resolveNewestStableTag, STABLE_TAG } from "./stable-tag.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "site build test",
  GIT_AUTHOR_EMAIL: "maya@example.com",
  GIT_COMMITTER_NAME: "site build test",
  GIT_COMMITTER_EMAIL: "maya@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (repo, ...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", env: GIT_ENV, stdio: "pipe" });
const build = (options) => buildSite({ env: GIT_ENV, ...options });

const write = (repo, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
};

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="docs.css" /></head>` +
  `<body><nav><a href="/">Home</a><a href="./">Overview</a><a href="/blog/">Blog</a></nav>${body}` +
  `<script src="docs.js"></script></body></html>`;

const sitemap = (...paths) =>
  `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>https://example.com${p}</loc></url>`).join("")}</urlset>`;

/**
 * A repository shaped like the real one at the points that matter: a release
 * tag whose docs still carry root-absolute links, then a main branch whose
 * docs are page-relative and gained a page and a new installer line.
 */
function makeRepo(root) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, {
    "website/index.html":
      '<!doctype html><title>Landing</title><a href="/docs/install#first-run">Install</a>',
    "website/blog/index.html": "<!doctype html><title>Blog</title>",
    "website/sitemap.xml": sitemap("/", "/docs/", "/docs/install"),
    "website/footer-social.css": "",
    "website/docs/docs.css": "",
    "website/docs/docs.js": "",
    "website/docs/index.html":
      '<!doctype html><title>Docs</title><link rel="stylesheet" href="/docs/docs.css" />' +
      '<a href="/docs/install#first-run">Install</a><a href="/footer-social.css">x</a>',
    "website/docs/install.html":
      '<!doctype html><title>Install</title><h2 id="first-run">First run</h2><a href="/docs/">Docs</a>',
    "website/install.sh": "#!/bin/sh\necho release\n",
    "website/install-prompt.md": "release prompt\n",
    "website/hardened-gateway.sh": "#!/bin/sh\necho hardened release\n",
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Release docs");
  git(repo, "tag", "v0.1.0");
  git(repo, "tag", "v0.2.0-beta.1");
  write(repo, {
    "website/docs/index.html": page(
      "Docs",
      '<a href="install#first-run">Install</a><a href="uninstall">Uninstall</a><a href="/footer-social.css">x</a>',
    ),
    "website/docs/install.html": page("Install", '<h2 id="first-run">First run</h2>'),
    "website/docs/uninstall.html": page("Uninstall", '<a href="#top">Top</a><p id="top"></p>'),
    "website/blog/post.html": "<!doctype html><title>Post</title>",
    "website/install.sh": "#!/bin/sh\necho edge\n",
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Edge docs");
  git(repo, "remote", "add", "origin", repo);
  return repo;
}

describe("newestStableTag", () => {
  it("orders versions numerically and ignores prereleases and other tags", () => {
    expect(newestStableTag(["v0.6.0", "v0.10.0", "v0.7.0-beta.1", "v0.9.9", "release-1"])).toBe(
      "v0.10.0",
    );
    expect(newestStableTag(["v1.0.0", "v0.99.99"])).toBe("v1.0.0");
    expect(newestStableTag(["v0.7.0-rc.1", "latest"])).toBeNull();
    expect(newestStableTag([])).toBeNull();
  });

  it("applies the pattern the installer resolves the newest stable release with", () => {
    const installer = readFileSync(join(REPO_ROOT, "scripts", "install.sh"), "utf8");
    expect(installer).toContain(STABLE_TAG.source.slice(1, -1));
  });
});

describe("site build", () => {
  let root;
  let repo;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omnesis-site-build-"));
    repo = makeRepo(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves the newest stable tag from origin, and fails without one", () => {
    expect(resolveNewestStableTag(repo, GIT_ENV)).toBe("v0.1.0");
    git(repo, "tag", "-d", "v0.1.0");
    expect(() => resolveNewestStableTag(repo, GIT_ENV)).toThrow(/No stable release/);
  });

  it("publishes the release-bound files from the tag and the checkout's docs at docs-edge", () => {
    const out = join(root, "out");
    const built = build({ repo, out });
    expect(built.release).toBe("v0.1.0");
    expect(built.version).toBe("0.1.0");

    const read = (path) => readFileSync(join(out, path), "utf8");
    // The checkout's pages publish as they are.
    expect(read("index.html")).toContain("Landing");
    expect(existsSync(join(out, "blog/post.html"))).toBe(true);
    // The release-bound files are the tag's, whatever the checkout holds.
    expect(read("install.sh")).toContain("echo release");
    expect(read("install-prompt.md")).toBe("release prompt\n");
    expect(read("hardened-gateway.sh")).toContain("hardened release");
    expect(read("docs/index.html")).toContain('href="/docs/install#first-run"');
    expect(existsSync(join(out, "docs/uninstall.html"))).toBe(false);
    // The edge tree is the checkout's docs, pages added since the tag included.
    expect(read("docs-edge/index.html")).toContain('href="install#first-run"');
    expect(existsSync(join(out, "docs-edge/uninstall.html"))).toBe(true);

    const releaseCommit = git(repo, "rev-parse", "--short=7", "v0.1.0^{commit}").trim();
    const edgeCommit = git(repo, "rev-parse", "--short=7", "HEAD").trim();
    expect(JSON.parse(read("docs/release.json"))).toEqual({
      channel: "release",
      release: "0.1.0",
      commit: releaseCommit,
    });
    expect(JSON.parse(read("docs-edge/release.json"))).toEqual({
      channel: "edge",
      release: "0.1.0",
      commit: edgeCommit,
    });
  });

  it("fetches the tag into a shallow, tagless clone the way CI checks out", () => {
    const clone = join(root, "clone");
    git(root, "clone", "-q", "--depth", "1", "--no-tags", `file://${repo}`, clone);
    expect(git(clone, "tag")).toBe("");
    const out = join(root, "out");
    expect(build({ repo: clone, out }).release).toBe("v0.1.0");
    expect(git(clone, "tag").trim()).toBe("v0.1.0");
    expect(readFileSync(join(out, "install.sh"), "utf8")).toContain("echo release");
  });

  it("empties the output directory before building into it", () => {
    const out = join(root, "out");
    write(root, { "out/stale.html": "", "out/docs/stale.html": "" });
    build({ repo, out });
    expect(existsSync(join(out, "stale.html"))).toBe(false);
    expect(existsSync(join(out, "docs/stale.html"))).toBe(false);
  });

  it("takes an explicit stable tag only", () => {
    git(repo, "tag", "v0.0.9", "HEAD~1");
    expect(build({ repo, out: join(root, "pinned"), tag: "v0.0.9" }).release).toBe("v0.0.9");
    expect(() => build({ repo, out: join(root, "x"), tag: "0.0.9" })).toThrow(/not a stable/);
    expect(() => build({ repo, out: join(root, "x"), tag: "v0.2.0-beta.1" })).toThrow(
      /not a stable/,
    );
  });

  it("builds only outside the repository or under its dist/", () => {
    for (const out of [".", "website", "website/docs", "scripts", ".git", root]) {
      expect(() => build({ repo, out }), out).toThrow(/holds the sources/);
    }
    expect(build({ repo, out: "dist/site" }).out).toBe(join(repo, "dist", "site"));
    // A sibling whose name is a prefix of the repository's is a fine target.
    expect(existsSync(join(build({ repo, out: join(root, "rep") }).out, "docs"))).toBe(true);
  });

  it("fails when the tag lacks a release-bound file", () => {
    git(repo, "rm", "-q", "website/hardened-gateway.sh");
    git(repo, "commit", "-qm", "Drop the hardened installer");
    git(repo, "tag", "v0.1.1");
    expect(() => build({ repo, out: join(root, "out") })).toThrow(
      /v0\.1\.1 has no website\/hardened-gateway\.sh/,
    );
  });

  it("fails the build on a broken link in either tree or into the release docs", () => {
    write(repo, { "website/docs/index.html": page("Docs", '<a href="setup">Setup</a>') });
    git(repo, "commit", "-qam", "Dangling edge link");
    expect(() => build({ repo, out: join(root, "broken") })).toThrow(
      /docs-edge\/index\.html: "setup" has no target/,
    );

    write(repo, {
      "website/docs/index.html": page("Docs", '<a href="install#first-run">Install</a>'),
      "website/blog/post.html":
        '<!doctype html><title>Post</title><a href="/docs/uninstall">Not released yet</a>',
      "website/sitemap.xml": sitemap("/", "/docs/", "/docs/install", "/docs/uninstall"),
    });
    git(repo, "commit", "-qam", "Link an unreleased page");
    expect(() => build({ repo, out: join(root, "ahead") })).toThrow(
      /blog\/post\.html: "\/docs\/uninstall" has no target[\s\S]*sitemap\.xml: \/docs\/uninstall has no page/,
    );

    write(repo, { "website/docs/index.html": '<a href="/docs/missing">x</a>' });
    git(repo, "commit", "-qam", "Dangling release link");
    git(repo, "tag", "-f", "v0.1.0");
    expect(() => build({ repo, out: join(root, "release") })).toThrow(
      /docs\/index\.html: "\/docs\/missing" has no target/,
    );
  });
});

describe("checkDocsLinks", () => {
  let site;
  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "omnesis-site-links-"));
    write(site, {
      "index.html": "<!doctype html>",
      "privacy.html": '<p id="data"></p>',
      "blog/index.html": "<!doctype html>",
      "docs/docs.css": "",
      "docs/docs.js": "",
      "docs/index.html": page("Docs", '<h2 id="help">Help</h2>'),
      "docs/install.html": page("Install", '<h2 id="first-run">First run</h2>'),
      "docs-edge/docs.css": "",
      "docs-edge/docs.js": "",
      "docs-edge/index.html": page("Docs", '<h2 id="help">Help</h2>'),
      "docs-edge/install.html": page("Install", '<h2 id="first-run">First run</h2>'),
    });
  });
  afterEach(() => rmSync(site, { recursive: true, force: true }));

  const withPage = (dir, body) => {
    writeFileSync(join(site, dir, "page.html"), page("Page", body));
    return checkDocsLinks(site, ["docs", "docs-edge"]);
  };

  it("accepts page-relative, same-page, root-absolute and external links that resolve", () => {
    expect(
      withPage(
        "docs-edge",
        '<a href="install#first-run">a</a><a href="./#help">b</a><a href="./">c</a>' +
          '<a href="#here">d</a><p id="here"></p><a href="/privacy#data">e</a>' +
          '<a href="/blog/">f</a><a href="https://example.com/docs/x">g</a>' +
          '<a href="mailto:contact@example.com">h</a><a href="/docs-edge/install">i</a>' +
          '<a href="install?ref=page#first-run">j</a><a href="#">k</a>',
      ),
    ).toEqual([]);
  });

  it("still accepts a release tree whose links are root-absolute into itself", () => {
    expect(
      withPage("docs", '<a href="/docs/install#first-run">a</a><a href="/docs/docs.css">b</a>'),
    ).toEqual([]);
  });

  it("reports links that escape the tree, enter the other tree, or miss their target", () => {
    expect(
      withPage(
        "docs-edge",
        '<a href="../privacy">a</a><a href="/docs/install">b</a><a href="setup">c</a>' +
          '<a href="install#nowhere">d</a><a href="#missing">e</a><a href="/vision">f</a>' +
          '<a href="docs/install">g</a>',
      ),
    ).toEqual([
      'docs-edge/page.html: "../privacy" is not page-relative to this tree',
      'docs-edge/page.html: "/docs/install" leaves this tree for /docs/',
      'docs-edge/page.html: "setup" has no target',
      'docs-edge/page.html: "install#nowhere" names an anchor its target lacks',
      'docs-edge/page.html: "#missing" names an anchor its target lacks',
      'docs-edge/page.html: "/vision" has no target',
      'docs-edge/page.html: "docs/install" is not page-relative to this tree',
    ]);
  });

  it("checks only the links into the docs trees from the rest of the site", () => {
    expect(
      withPage(
        "blog",
        '<a href="/docs/install#first-run">a</a><a href="/docs-edge/#help">b</a>' +
          '<a href="/docs/missing">c</a><a href="/docs/install#nowhere">d</a>' +
          '<a href="/vision">e</a><a href="relative">f</a>',
      ),
    ).toEqual([
      'blog/page.html: "/docs/missing" has no target',
      'blog/page.html: "/docs/install#nowhere" names an anchor its target lacks',
    ]);
  });

  it("checks the docs URLs the sitemap lists", () => {
    write(site, { "sitemap.xml": sitemap("/", "/vision", "/docs/install", "/docs/missing") });
    expect(checkDocsLinks(site, ["docs", "docs-edge"])).toEqual([
      "sitemap.xml: /docs/missing has no page",
    ]);
  });
});
