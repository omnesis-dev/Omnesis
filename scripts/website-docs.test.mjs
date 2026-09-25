// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Structural guards for the public docs (website/docs/) and privacy pages:
// links resolve the way Cloudflare serves them, anchors exist, and shared
// navigation structures stay consistent. Documentation prose is deliberately
// outside this suite so copy edits do not require test changes.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";

const WEBSITE = join(dirname(fileURLToPath(import.meta.url)), "..", "website");
const REPO_ROOT = join(WEBSITE, "..");
const DOCS = join(WEBSITE, "docs");

// Reading order — drives the sidebar and the prev/next pager on every page.
const ORDER = [
  "index.html",
  "install.html",
  "setup.html",
  "search.html",
  "agent.html",
  "connect.html",
  "apps.html",
  "notifications.html",
  "operating.html",
  "security.html",
  "updating.html",
  "sources.html",
  "building-sources.html",
  "experimental.html",
];

const docPages = readdirSync(DOCS).filter((f) => f.endsWith(".html"));
const sharedChromePages = [
  ...docPages,
  "../mobile-privacy-policy.html",
  "../browser-extension-privacy-policy.html",
];
const contentPages = [...sharedChromePages, "../privacy.html"];
const html = Object.fromEntries(contentPages.map((f) => [f, readFileSync(join(DOCS, f), "utf8")]));
const landing = readFileSync(join(WEBSITE, "index.html"), "utf8");
const brain = readFileSync(join(WEBSITE, "brain.html"), "utf8");
const vision = readFileSync(join(WEBSITE, "vision.html"), "utf8");
const sharedChromeScript = readFileSync(join(DOCS, "docs.js"), "utf8");
const publicHtml = Object.fromEntries(
  readdirSync(WEBSITE)
    .filter((f) => f.endsWith(".html"))
    .map((f) => [f, readFileSync(join(WEBSITE, f), "utf8")]),
);
const redirects = readFileSync(join(WEBSITE, "_redirects"), "utf8");
const idsOf = (f) => new Set([...html[f].matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const slug = (f) => (f === "index.html" ? "/docs/" : "/docs/" + f.replace(".html", ""));
const REPO_URL = "https://github.com/omnesis-dev/Omnesis";
const NAV_LINKS = ["/", "/brain", "/vision", "/docs/"];

// Resolves URLs the way the Cloudflare static-asset host does
// (html_handling): /docs/install serves docs/install.html, a trailing
// slash serves the directory index.
function resolve(path) {
  let p = path;
  if (p.endsWith("/")) p += "index.html";
  const full = join(WEBSITE, p);
  if (existsSync(full) && /\.[a-z]+$/.test(p)) return full;
  if (existsSync(full + ".html")) return full + ".html";
  if (existsSync(join(full, "index.html"))) return join(full, "index.html");
  return null;
}

describe("website docs", () => {
  it("has exactly the expected page set", () => {
    expect(docPages.sort()).toEqual([...ORDER].sort());
  });

  it.each(contentPages)("%s: internal links and anchors resolve", (f) => {
    const problems = [];
    for (const m of html[f].matchAll(/href="([^"]+)"/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, anchor] = href.split("#");
      if (path === "") {
        if (anchor && !idsOf(f).has(anchor)) problems.push(`dead same-page anchor #${anchor}`);
        continue;
      }
      if (!path.startsWith("/")) {
        problems.push(`non-absolute internal href "${href}"`);
        continue;
      }
      const target = resolve(path);
      if (!target) {
        problems.push(`broken link ${href}`);
        continue;
      }
      if (anchor && !new RegExp(`\\sid="${anchor}"`).test(readFileSync(target, "utf8")))
        problems.push(`link ${href}: anchor missing on target`);
    }
    expect(problems).toEqual([]);
  });

  // Shipped binaries, installers and apps print these URLs, so a docs
  // restructure must keep every one of them landing on a real section.
  it("resolves every docs URL printed by the product", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.(ts|js|mjs|sh|swift|kt|md)$/.test(f) && !f.startsWith("website/docs/"));
    const problems = [];
    for (const file of tracked) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const m of text.matchAll(
        /https:\/\/omnesis\.dev(\/docs(?:\/[a-z-]*)?)(?:#([a-z0-9-]+))?/g,
      )) {
        const target = resolve(m[1]);
        if (!target) problems.push(`${file}: ${m[0]} has no page`);
        else if (m[2] && !new RegExp(`\\sid="${m[2]}"`).test(readFileSync(target, "utf8")))
          problems.push(`${file}: ${m[0]} has no such section`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the sidebar identical across pages (modulo active state)", () => {
    const skeleton = (f) => {
      const m = html[f].match(/<aside class="docs-sidebar">[\s\S]*?<\/aside>/);
      expect(m, `${f} has a sidebar`).toBeTruthy();
      return m[0]
        .replace(/\s*<ul class="side-sub">[\s\S]*?<\/ul>/g, "")
        .replace(/\s+aria-current="page"/g, "")
        .replace(/>\s+</g, "><")
        .replace(/\s+/g, " ");
    };
    const ref = skeleton(ORDER[0]);
    for (const f of ORDER) expect(skeleton(f), f).toBe(ref);
  });

  it.each(ORDER)("%s: presents one uninterrupted page list", (f) => {
    const sidebar = html[f].match(/<aside class="docs-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? "";
    expect(sidebar).toContain('<ul class="side-pages">');
    expect(sidebar).not.toContain('class="side-group"');
    expect(sidebar).not.toContain('class="side-label"');
  });

  it.each(ORDER)("%s: pager chain and active sidebar link are correct", (f) => {
    const i = ORDER.indexOf(f);
    const pager = html[f].match(/<nav class="docs-pager"[\s\S]*?<\/nav>/)?.[0] ?? "";
    const prev = pager.match(/<a href="([^"]+)"/)?.[1];
    const next = pager.match(/<a class="pager-next" href="([^"]+)"/)?.[1];
    expect(prev).toBe(i > 0 ? slug(ORDER[i - 1]) : undefined);
    expect(next).toBe(i < ORDER.length - 1 ? slug(ORDER[i + 1]) : undefined);
    expect(html[f]).toMatch(
      new RegExp(`<a href="${slug(f).replaceAll("/", "\\/")}" aria-current="page"`),
    );
  });

  it("keeps experimental features, experimental sources and external agents on their pages", () => {
    const experimental = html["experimental.html"];
    expect(idsOf("experimental.html").has("brain")).toBe(true);
    expect(idsOf("experimental.html").has("watch")).toBe(true);
    expect(idsOf("experimental.html").has("plaid")).toBe(false);
    expect(idsOf("sources.html").has("plaid")).toBe(true);
    expect(idsOf("sources.html").has("local-files")).toBe(true);
    expect(idsOf("experimental.html").has("openclaw-hermes")).toBe(false);
    expect(idsOf("connect.html").has("openclaw-hermes")).toBe(true);

    const sidebar = experimental.match(/<aside class="docs-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? "";
    const subnav = sidebar.match(/<ul class="side-sub">[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect([...subnav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["#brain", "#watch"]);
  });

  it.each(sharedChromePages)("%s: carries the shared chrome", (f) => {
    for (const needle of [
      'href="/docs/docs.css"',
      'src="/docs/docs.js"',
      "omnesis-theme",
      "<title>",
    ])
      expect(html[f], needle).toContain(needle);
  });

  it("places the AI disclosure component only on the documentation landing page", () => {
    const noticeCount = (page) => page.match(/class="docs-ai-notice"/g)?.length ?? 0;
    expect(noticeCount(html["index.html"])).toBe(1);
    for (const f of ORDER.slice(1)) expect(noticeCount(html[f]), f).toBe(0);

    const notice = html["index.html"].match(/<p class="docs-ai-notice">[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(notice).toMatch(/class="docs-ai-badge"/);
    expect(notice).toMatch(/href="mailto:contact@omnesis\.dev"/);
  });

  it("gives every public page the same nav and a footer with the docs and the repository", () => {
    const links = (fragment) => [...fragment.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    for (const [file, page] of Object.entries(publicHtml)) {
      const nav = page.match(/<nav id="nav">[\s\S]*?<\/nav>/)?.[0] ?? "";
      expect(nav, file).toBeTruthy();

      const menu = nav.match(/<ul class="nav-links"(?: id="[^"]+")?>[\s\S]*?<\/ul>/)?.[0] ?? "";
      expect(links(menu), file).toEqual(NAV_LINKS);
      expect(nav.match(/<a[^>]*class="nav-logo"[^>]*>/)?.[0], file).toContain('href="/"');

      const footer = page.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0] ?? "";
      expect(links(footer), file).toEqual(
        expect.arrayContaining(["/docs/", "/privacy", "mailto:contact@omnesis.dev", REPO_URL]),
      );
      expect(links(footer), file).toContain(`${REPO_URL}/blob/main/LICENSE`);
    }
  });

  it("links GitHub buttons to the repository, never to a placeholder", () => {
    const pages = {
      ...publicHtml,
      ...Object.fromEntries(docPages.map((f) => [`docs/${f}`, html[f]])),
      "docs/docs.js": sharedChromeScript,
    };
    for (const [file, page] of Object.entries(pages)) {
      expect(page, file).not.toMatch(/data-oss-open|oss-modal/);
      expect(page, file).not.toMatch(/<a[^>]*href="#"/);
    }
    expect(existsSync(join(WEBSITE, "oss-modal.js"))).toBe(false);
  });

  it("shows the X account and Discord invite in every page footer", () => {
    const pages = {
      ...publicHtml,
      ...Object.fromEntries(docPages.map((f) => [`docs/${f}`, html[f]])),
    };
    const socialLinks = ["https://x.com/Omnesisdev", "https://discord.gg/4Y8pQHrVv"];
    for (const [file, page] of Object.entries(pages)) {
      const footer = page.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
      expect(footer, file).toBeTruthy();
      expect(page, file).toContain('href="/footer-social.css"');
      for (const href of socialLinks) {
        expect(footer, file).toContain(`href="${href}"`);
      }
    }
    for (const file of ["footer-social.css", "media/x.svg", "media/discord.svg"]) {
      expect(existsSync(join(WEBSITE, file)), file).toBe(true);
    }
  });

  it("renders the same docs chrome at runtime on every page", () => {
    const renderChromeLinks = (pathname) => {
      const navLinks = { id: "primary-navigation", innerHTML: "" };
      const footerLinks = { innerHTML: "" };
      const nav = {
        classList: { toggle() {} },
        querySelector(selector) {
          return selector === ".nav-links" ? navLinks : null;
        },
        querySelectorAll() {
          return [];
        },
      };
      const document = {
        body: null,
        getElementById(id) {
          return id === "nav" ? nav : null;
        },
        querySelector(selector) {
          return selector === ".site-footer .footer-links" ? footerLinks : null;
        },
      };
      const window = {
        addEventListener() {},
        location: { pathname },
        scrollY: 0,
      };
      runInNewContext(sharedChromeScript, { document, window });
      return [...(navLinks.innerHTML + footerLinks.innerHTML).matchAll(/href="([^"]+)"/g)].map(
        (match) => match[1],
      );
    };
    for (const [file, page] of Object.entries(publicHtml)) {
      if (!page.includes('src="/docs/docs.js"')) continue;
      const pathname = file === "index.html" ? "/" : `/${file.replace(".html", "")}`;
      const renderedLinks = renderChromeLinks(pathname);
      expect(renderedLinks, file).toEqual(
        expect.arrayContaining([
          ...NAV_LINKS,
          REPO_URL,
          "https://x.com/Omnesisdev",
          "https://discord.gg/4Y8pQHrVv",
        ]),
      );
    }
    expect(renderChromeLinks("/docs/").filter((href) => href === "/docs/")).toHaveLength(2);
  });

  it("copies a terminal's commands, never its prompt glyph or its output", () => {
    const noop = () => {};
    const stub = () => ({
      innerHTML: "",
      style: {},
      classList: { add: noop, remove: noop, toggle: noop },
      querySelector: () => stub(),
      querySelectorAll: () => [],
      addEventListener: noop,
      appendChild: noop,
      setAttribute: noop,
      insertAdjacentHTML: noop,
      focus: noop,
    });
    // One stub line per shape a .term-body holds: a prompted command (long ones
    // are wrapped across source lines by the formatter), a "# …" comment that
    // marks the next command as an alternative, and a dimmed output line.
    const command = (text) => ({
      classList: { contains: () => false },
      textContent: "",
      querySelector: (selector) => (selector === ".t-cmd" ? { textContent: text } : null),
    });
    const dimmed = (text) => ({
      classList: { contains: (name) => name === "t-dim" },
      textContent: text,
      querySelector: () => null,
    });
    const card = (lines, pre, copyLabel = null) => {
      const bar = { ...stub(), querySelector: () => null, appendChild: (b) => (bar.button = b) };
      const body = {
        children: lines,
        querySelector: (selector) =>
          selector === "pre" && pre !== null ? { textContent: pre } : null,
      };
      return {
        bar,
        getAttribute: (name) => (name === "data-copy-label" ? copyLabel : null),
        querySelector: (selector) =>
          selector === ".term-bar" ? bar : selector === ".term-body" ? body : null,
      };
    };
    const commands = card(
      [
        dimmed("# or run it bare for an interactive picker"),
        command("curl -fsSL https://omnesis.dev/install.sh\n                | sh -s -- --docker"),
        command("omnesis status"),
      ],
      "PRINTED OUTPUT the command produced",
    );
    const payload = card(
      [dimmed("2 results in 41ms")],
      '\n{ "dataRetention": { "maxAge": "2y" } }\n',
    );
    const guidedMarkup = html["install.html"].match(
      /<div class="term guided-install-terminal" data-copy-label="Copy prompt">[\s\S]*?<pre class="wrap">([\s\S]*?)<\/pre\s*>/,
    );
    expect(guidedMarkup, "the authored prompt is a wrapping terminal input").toBeTruthy();
    const guidedPrompt = guidedMarkup[1].replace(/^\n/, "").replace(/\s+$/, "");
    const guided = card([], guidedMarkup[1], "Copy prompt");
    const prose = card([], null);
    const copied = [];
    const button = () => {
      const b = {
        ...stub(),
        attributes: {},
        setAttribute: (name, value) => (b.attributes[name] = value),
        addEventListener: (_, handler) => (b.click = handler),
      };
      return b;
    };

    runInNewContext(sharedChromeScript, {
      document: {
        body: stub(),
        getElementById: () => stub(),
        querySelector: () => stub(),
        querySelectorAll: (selector) =>
          selector === ".term" ? [commands, payload, guided, prose] : [],
        createElement: button,
        addEventListener: noop,
      },
      window: { addEventListener: noop, location: { pathname: "/docs/install" }, scrollY: 0 },
      navigator: {
        clipboard: {
          writeText: (text) => (copied.push(text), { then: () => ({ catch: noop }) }),
        },
      },
      setTimeout: noop,
      clearTimeout: noop,
    });

    expect(prose.bar.button, "a card with nothing to paste gets no button").toBeUndefined();
    commands.bar.button.click();
    payload.bar.button.click();
    guided.bar.button.click();
    expect(guided.bar.button.attributes["aria-label"]).toBe("Copy prompt");
    expect(copied).toEqual([
      // Commands win over the output beside them; the comment that marks the
      // second command as an alternative comes along; the wrap is collapsed.
      "# or run it bare for an interactive picker\ncurl -fsSL https://omnesis.dev/install.sh | sh -s -- --docker\nomnesis status",
      // A dimmed line that is not a comment is printed output, so this card
      // shows no command at all and falls back to its <pre>.
      '{ "dataRetention": { "maxAge": "2y" } }',
      guidedPrompt,
    ]);

    const fallbackCopies = [];
    const fallbackCard = card([], guidedMarkup[1], "Copy prompt");
    const input = { ...stub(), value: "", select: noop, remove: noop };
    runInNewContext(sharedChromeScript, {
      document: {
        body: stub(),
        getElementById: () => stub(),
        querySelector: () => stub(),
        querySelectorAll: (selector) => (selector === ".term" ? [fallbackCard] : []),
        createElement: (tag) => (tag === "textarea" ? input : button()),
        execCommand: (command) => (fallbackCopies.push([command, input.value]), true),
        addEventListener: noop,
      },
      window: { addEventListener: noop, location: { pathname: "/docs/install" }, scrollY: 0 },
      navigator: {},
      setTimeout: noop,
      clearTimeout: noop,
    });
    fallbackCard.bar.button.click();
    expect(fallbackCopies).toEqual([["copy", guidedPrompt]]);
  });

  it("styles every class the copy button renders, and still has a wrapped command to collapse", () => {
    const css = readFileSync(join(DOCS, "docs.css"), "utf8");
    for (const className of [...sharedChromeScript.matchAll(/class="(icon-copy|icon-check)"/g)]
      .map((match) => match[1])
      .concat("term-copy")) {
      expect(css, className).toContain(`.${className}`);
    }
    const wrapped = Object.values(html)
      .flatMap((page) => [...page.matchAll(/<span class="t-cmd"[^>]*>([\s\S]*?)<\/span/g)])
      .some((match) => match[1].includes("\n"));
    expect(wrapped, "a command wrapped across source lines still exists in the docs").toBe(true);
  });

  it("keeps pre-launch controls out of the rendered landing-page hero", () => {
    const renderedMarkup = landing.replace(/<!--[\s\S]*?-->/g, "");
    expect(renderedMarkup).not.toMatch(/class="term hero-install"/);
  });

  it("binds every authored mobile-menu button to its primary link list", () => {
    for (const page of [landing, brain, vision]) {
      expect(page).toContain('<ul class="nav-links" id="primary-navigation">');
      expect(page).toContain('aria-controls="primary-navigation"');
      expect(page).not.toContain('aria-controls="nav"');
    }

    expect(sharedChromeScript).toContain('navLinks.id = "primary-navigation"');
    expect(sharedChromeScript).toContain(
      'burger.setAttribute("aria-controls", "primary-navigation")',
    );
  });

  it("offers the docs' guided prompt and the one-command install in the landing hero", () => {
    const text = (markup) =>
      markup
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const pane = (name) =>
      landing.match(
        new RegExp(
          `id="install-pane-${name}"[\\s\\S]*?<code class="install-text"\\s*>([\\s\\S]*?)</code`,
        ),
      )?.[1] ?? "";
    const guided =
      html["install.html"].match(
        /class="term guided-install-terminal"[\s\S]*?<pre class="wrap">([\s\S]*?)<\/pre/,
      )?.[1] ?? "";
    expect(text(pane("agent"))).toBe(text(guided));
    expect(text(pane("manual"))).toBe("curl -fsSL https://omnesis.dev/install.sh | sh");
    expect(landing).not.toMatch(/<!--[^>]*pre-launch/);
  });

  it("links the general privacy policy, but not the mobile policy, from the landing footer", () => {
    const footer = landing.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0] ?? "";
    const hrefs = [...footer.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toContain("/privacy");
    expect(hrefs).not.toContain("/mobile-privacy-policy");
  });

  it("keeps the diagram's external-agent path above the built-in agent path", () => {
    const diagram = landing.match(/<div class="arch-diagram[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(diagram).toContain("arch-label arch-label--private");
    expect(diagram).not.toMatch(/sandbox-badge[^>]*>\s*<svg/);
    expect(diagram.indexOf("arch-privacy-gate")).toBeLessThan(
      diagram.indexOf("arch-built-in-agent"),
    );
    expect(landing).toMatch(/\.arch-privacy-gate \{[\s\S]*?grid-row: 1;/);
    expect(landing).toMatch(/\.arch-boundary-grid \{[\s\S]*?grid-template-rows: 92px 176px;/);
    expect(landing).toMatch(/\.arch-built-in-agent \{[\s\S]*?grid-row: 2;/);
    expect(diagram.match(/class="arch-route-block/g)).toHaveLength(2);
    expect(diagram).not.toContain("arch-route-junction");
    expect(landing).toMatch(
      /\.arch-route-block--gate,\s*\.arch-route-block--agent \{\s*fill: var\(--text-dim\);/,
    );
    expect(landing).toMatch(/\.external-agent-list \{[\s\S]*?margin-top: 0;/);
    expect(landing).toMatch(/\.arch-arrow--egress \{[\s\S]*?color: var\(--text-dim\);/);
    expect(landing).toMatch(/\.sandbox-badge \{[\s\S]*?color: var\(--text-secondary\);/);
    expect(landing).not.toMatch(/\.arch-built-in-agent \{[^}]*border-color:/);
    expect(landing).not.toMatch(/\.arch-privacy-gate \{[^}]*border-color:/);
  });
});

describe("website hosting", () => {
  it("keeps npm as the sole root package-manager lockfile", () => {
    expect(existsSync(join(REPO_ROOT, "package-lock.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "pnpm-lock.yaml"))).toBe(false);
  });

  it("serves the static assets directly, with no Worker in front of them", () => {
    const wrangler = readFileSync(join(REPO_ROOT, "wrangler.jsonc"), "utf8");
    expect(wrangler).not.toMatch(/"main"\s*:/);
    expect(wrangler).not.toMatch(/run_worker_first/);
    expect(existsSync(join(REPO_ROOT, "worker.js"))).toBe(false);
    expect(existsSync(join(WEBSITE, "404.html"))).toBe(true);
  });

  it("keeps the website's own README out of the published assets", () => {
    const ignored = readFileSync(join(WEBSITE, ".assetsignore"), "utf8").split("\n");
    expect(ignored).toContain("README.md");
  });

  it("lets crawlers index every page and lists every page in the sitemap", () => {
    const robots = readFileSync(join(WEBSITE, "robots.txt"), "utf8");
    expect(robots).not.toMatch(/Disallow:\s*\//);
    expect(robots).toContain("Sitemap: https://omnesis.dev/sitemap.xml");

    const sitemap = readFileSync(join(WEBSITE, "sitemap.xml"), "utf8");
    const listed = [...sitemap.matchAll(/<loc>https:\/\/omnesis\.dev([^<]*)<\/loc>/g)].map(
      (m) => m[1],
    );
    const pages = [
      ...Object.keys(publicHtml)
        .filter((f) => f !== "404.html")
        .map((f) => (f === "index.html" ? "/" : `/${f.replace(".html", "")}`)),
      ...docPages.map(slug),
    ];
    expect([...listed].sort()).toEqual([...pages].sort());
    const indexable = Object.entries(publicHtml).filter(([f]) => f !== "404.html");
    for (const page of [...indexable.map(([, p]) => p), ...docPages.map((f) => html[f])]) {
      expect(page).not.toMatch(/<meta[^>]*name="robots"[^>]*noindex/);
    }
  });

  it("keeps the legacy mobile privacy-policy redirect in the static site", () => {
    const rules = new Map(
      redirects
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 3)
        .map(([from, to, status]) => [from, { to, status }]),
    );
    expect(rules.get("/privacy-policy")).toEqual({ to: "/mobile-privacy-policy", status: "301" });
    expect(rules.get("/privacy-policy.html")).toEqual({
      to: "/mobile-privacy-policy",
      status: "301",
    });
  });
});
