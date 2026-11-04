// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Builds the omnesis.dev asset tree that wrangler deploys, from the checkout
 * this runs in (normally `main`) and the newest stable release tag:
 *
 *   dist/site/            everything under website/ as it is checked out
 *   dist/site/docs/       the docs as they were at the newest stable tag
 *   dist/site/docs-edge/  the docs as they are in this checkout
 *   dist/site/install.sh, install-prompt.md, hardened-gateway.sh
 *                         the installer files as they were at the tag
 *
 * The blog, landing page and policy pages publish from the checkout the moment
 * they merge. The docs and the installer describe and install the newest
 * release, so they are taken from its tag; a user who runs the served
 * installer gets that release, and reads docs that match it. The checkout's
 * own docs are published unlinked at /docs-edge/ for anyone who needs the
 * upcoming ones. Each docs tree carries a release.json naming what it
 * describes, which the docs chrome shows.
 *
 * The tree is then link-checked: in each docs tree every page-relative link
 * resolves inside that tree, every root-absolute link resolves on the site and
 * none enters the other tree; outside the docs trees, every link into a docs
 * tree and every docs URL in the sitemap resolves. A problem fails the build,
 * so a landing or blog change cannot link to a page the release does not have.
 *
 *   node scripts/site/build.mjs [--out dist/site] [--tag vX.Y.Z]
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNewestStableTag, STABLE_TAG } from "./stable-tag.mjs";

/**
 * Published from the release tag rather than the checkout. A name goes on this
 * list only once a stable tag carries it: the build fails when the newest tag
 * lacks a listed file, rather than publishing the checkout's copy as if it
 * were the release's.
 */
const RELEASE_BOUND = ["docs", "install.sh", "install-prompt.md", "hardened-gateway.sh"];
/** The docs trees the build publishes, by the path each is served under. */
const DOCS_TREES = ["docs", "docs-edge"];

function git(repo, args, options = {}) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", ...options });
}

/** Makes `tag` resolvable in `repo`, fetching just that tag when a shallow checkout lacks it. */
function ensureTag(repo, tag, env) {
  try {
    git(repo, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], { stdio: "pipe", env });
  } catch {
    git(
      repo,
      ["fetch", "--no-tags", "--depth", "1", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env,
      },
    );
  }
}

/** Writes the files under `website/<name>` as they are at `tag` to `dest`. */
function exportFromTag(repo, tag, name, dest, env) {
  const paths = git(
    repo,
    ["ls-tree", "-r", "-z", "--name-only", `refs/tags/${tag}`, "--", `website/${name}`],
    { env },
  )
    .split("\0")
    .filter(Boolean);
  if (paths.length === 0) throw new Error(`${tag} has no website/${name}`);
  for (const path of paths) {
    const target = join(dest, posix.relative(`website/${name}`, path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      git(repo, ["show", `refs/tags/${tag}:${path}`], { encoding: "buffer", env }),
    );
  }
}

/** Whether `child` is `parent` or lies under it. */
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Builds the site into `out` and returns what it was built from. The output
 * directory is emptied first, so it must lie outside the repository or under
 * its `dist/`. Throws when the tree holds a broken link.
 */
export function buildSite({ repo, out, tag = null, env = process.env, log = () => {} }) {
  const website = join(repo, "website");
  const outDir = resolve(repo, out);
  if (inside(outDir, repo) || (inside(repo, outDir) && !inside(join(repo, "dist"), outDir))) {
    throw new Error(`Refusing to build into ${outDir}: it holds the sources.`);
  }
  if (tag !== null && !STABLE_TAG.test(tag)) {
    throw new Error(`${tag} is not a stable release tag (expected vX.Y.Z).`);
  }
  const release = tag ?? resolveNewestStableTag(repo, env);
  ensureTag(repo, release, env);
  const releaseCommit = git(repo, ["rev-parse", "--short=7", `refs/tags/${release}^{commit}`], {
    env,
  }).trim();
  const edgeCommit = git(repo, ["rev-parse", "--short=7", "HEAD"], { env }).trim();
  const version = release.slice(1);

  rmSync(outDir, { recursive: true, force: true });
  cpSync(website, outDir, { recursive: true });
  log(`Copied website/ to ${out}`);

  cpSync(join(outDir, "docs"), join(outDir, "docs-edge"), { recursive: true });
  for (const name of RELEASE_BOUND) {
    const dest = join(outDir, name);
    rmSync(dest, { recursive: true, force: true });
    exportFromTag(repo, release, name, dest, env);
  }
  log(`Published ${RELEASE_BOUND.join(", ")} from ${release} (${releaseCommit})`);
  log(`Published docs-edge from the checkout (${edgeCommit})`);

  const stamp = (tree, fields) =>
    writeFileSync(join(outDir, tree, "release.json"), `${JSON.stringify(fields)}\n`);
  stamp("docs", { channel: "release", release: version, commit: releaseCommit });
  stamp("docs-edge", { channel: "edge", release: version, commit: edgeCommit });

  const problems = checkDocsLinks(outDir, DOCS_TREES);
  if (problems.length > 0) {
    throw new Error(`Broken links in the built site:\n  ${problems.join("\n  ")}`);
  }
  log(`Checked every link into ${DOCS_TREES.join(" and ")}`);
  return { release, version, releaseCommit, edgeCommit, out: outDir };
}

/**
 * Resolves a root-absolute site path the way Cloudflare serves the asset
 * tree: a file with an extension as itself, a trailing slash as the directory
 * index, and an extensionless path as its `.html` page.
 */
function resolveSitePath(siteDir, path) {
  const normalized = path.endsWith("/") ? `${path}index.html` : path;
  const full = join(siteDir, normalized);
  if (/\.[a-z0-9]+$/i.test(normalized) && isFile(full)) return full;
  if (isFile(`${full}.html`)) return `${full}.html`;
  if (isFile(join(full, "index.html"))) return join(full, "index.html");
  return null;
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

const hasAnchor = (file, anchor) =>
  new RegExp(`\\s(?:id|name)="${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(
    readFileSync(file, "utf8"),
  );

/** Every `.html` under `dir`, as paths relative to it, skipping `except` top-level names. */
function htmlPages(dir, except = []) {
  const pages = [];
  const walk = (sub) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (!sub && except.includes(entry.name)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".html")) pages.push(rel);
    }
  };
  walk("");
  return pages;
}

/**
 * Every link problem in the site under `siteDir` that concerns the docs trees,
 * each served at `/<tree>/`. Inside a tree, page-relative links must stay in
 * the tree, root-absolute links must resolve on the site and never enter
 * another tree, and an anchor must exist on its target page. Outside the
 * trees, a link into a tree and a docs URL in the sitemap must resolve the
 * same way.
 */
export function checkDocsLinks(siteDir, trees) {
  const problems = [];
  const treeOf = (path) => {
    const first = path.split("/")[1];
    return trees.includes(first) ? first : null;
  };
  const checkTarget = (report, link, target, anchor) => {
    if (!target) report(`"${link}" has no target`);
    else if (anchor && target.endsWith(".html") && !hasAnchor(target, anchor))
      report(`"${link}" names an anchor its target lacks`);
  };
  const linksOf = (html) =>
    [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)]
      .map((m) => m[1])
      .filter((link) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link))
      .map((link) => {
        const [path, anchor] = link.split("#");
        return { link, path: path.split("?")[0], anchor };
      });

  for (const tree of trees) {
    const treeDir = join(siteDir, tree);
    for (const page of htmlPages(treeDir)) {
      const report = (what) => problems.push(`${tree}/${page}: ${what}`);
      for (const { link, path, anchor } of linksOf(readFileSync(join(treeDir, page), "utf8"))) {
        let target;
        if (path === "") {
          target = join(treeDir, page);
        } else if (path.startsWith("/")) {
          const other = treeOf(path);
          if (other && other !== tree) {
            report(`"${link}" leaves this tree for /${other}/`);
            continue;
          }
          target = resolveSitePath(siteDir, path);
        } else if (path.includes("/") && path !== "./") {
          report(`"${link}" is not page-relative to this tree`);
          continue;
        } else {
          target = resolveSitePath(treeDir, path === "./" ? "/" : `/${path}`);
        }
        checkTarget(report, link, target, anchor);
      }
    }
  }

  for (const page of htmlPages(siteDir, trees)) {
    const report = (what) => problems.push(`${page}: ${what}`);
    for (const { link, path, anchor } of linksOf(readFileSync(join(siteDir, page), "utf8"))) {
      if (!treeOf(path)) continue;
      checkTarget(report, link, resolveSitePath(siteDir, path), anchor);
    }
  }

  const sitemap = join(siteDir, "sitemap.xml");
  if (isFile(sitemap)) {
    for (const m of readFileSync(sitemap, "utf8").matchAll(
      /<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g,
    )) {
      if (treeOf(m[1]) && !resolveSitePath(siteDir, m[1])) {
        problems.push(`sitemap.xml: ${m[1]} has no page`);
      }
    }
  }
  return problems;
}

function parseArgs(argv) {
  const options = { out: "dist/site", tag: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.out = argv[++i];
    else if (arg === "--tag") options.tag = argv[++i];
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!options.out) throw new Error("--out needs a directory");
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const options = parseArgs(process.argv.slice(2));
  const built = buildSite({ repo, ...options, log: (line) => console.log(line) });
  console.log(`Site built in ${options.out}: docs ${built.release}, docs-edge ${built.edgeCommit}`);
}
