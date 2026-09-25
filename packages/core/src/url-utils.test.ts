// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  buildCanonicalizerRegistry,
  canonicalDomain,
  extractUrls,
  hostIsOwned,
  normalizeUrl,
  urlToExternalId,
} from "./url-utils.js";

describe("extractUrls", () => {
  test("extracts markdown links", () => {
    const content = "Check out [Example](https://example.com) for more info.";
    const urls = extractUrls(content);
    expect(urls).toEqual(["https://example.com"]);
  });

  test("extracts bare URLs", () => {
    const content = "Visit https://example.com/page for details.";
    const urls = extractUrls(content);
    expect(urls).toEqual(["https://example.com/page"]);
  });

  test("handles both markdown links and bare URLs in same content", () => {
    const content = "See [docs](https://docs.example.com) and also https://example.com/page";
    const urls = extractUrls(content);
    expect(urls).toContain("https://docs.example.com");
    expect(urls).toContain("https://example.com/page");
    expect(urls).toHaveLength(2);
  });

  test("does not extract mailto:, javascript:, data: URIs", () => {
    const content = [
      "[email](mailto:user@example.com)",
      "[click](javascript:alert(1))",
      "[img](data:image/png;base64,abc)",
    ].join("\n");
    const urls = extractUrls(content);
    expect(urls).toEqual([]);
  });

  test("deduplicates same URL appearing multiple times", () => {
    const content = [
      "Link: https://example.com/page",
      "Again: [click](https://example.com/page)",
      "And: https://example.com/page",
    ].join("\n");
    const urls = extractUrls(content);
    expect(urls).toEqual(["https://example.com/page"]);
  });

  test("extracts deep URI schemes (obsidian://, things:///)", () => {
    const content = [
      "Open in Obsidian: obsidian://open?vault=notes&file=test",
      "Things link: things:///show?id=abc123",
    ].join("\n");
    const urls = extractUrls(content);
    expect(urls).toContain("obsidian://open?vault=notes&file=test");
    expect(urls).toContain("things:///show?id=abc123");
  });

  test("extracts file:// URLs", () => {
    const content = "File at file:///Users/test/doc.txt";
    const urls = extractUrls(content);
    expect(urls).toEqual(["file:///Users/test/doc.txt"]);
  });

  test("extracts mixed http and deep URIs", () => {
    const content = ["Web: https://example.com", "App: obsidian://open?file=note"].join("\n");
    const urls = extractUrls(content);
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("obsidian://open?file=note");
  });

  test("returns empty array for empty content", () => {
    expect(extractUrls("")).toEqual([]);
    expect(extractUrls("no urls here")).toEqual([]);
  });
});

describe("normalizeUrl", () => {
  test("lowercases hostname for http URLs", () => {
    expect(normalizeUrl("https://EXAMPLE.COM/Path")).toBe("https://example.com/Path");
  });

  test("strips credential-bearing params so a secret never becomes part of a page's identity", () => {
    const reset = normalizeUrl("https://app.example.com/reset?Token=abc123&keep=yes");
    expect(reset).toBe("https://app.example.com/reset?keep=yes");
    const signed = normalizeUrl(
      "https://files.example.com/report.pdf?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA&X-Amz-Expires=300&v=2",
    );
    expect(signed).toBe("https://files.example.com/report.pdf?v=2");
    expect(normalizeUrl("https://api.example.com/x?api_key=k&sig=s&password=p&session_id=q")).toBe(
      "https://api.example.com/x",
    );
    // An equal page reached through a different secret keys the same.
    expect(normalizeUrl("https://app.example.com/reset?token=one")).toBe(
      normalizeUrl("https://app.example.com/reset?token=two"),
    );
  });

  test("drops code and state only together, the shape of an OAuth callback", () => {
    expect(normalizeUrl("https://app.example.com/callback?code=abc&state=xyz")).toBe(
      "https://app.example.com/callback",
    );
    expect(normalizeUrl("https://shop.example.com/stores?state=WA")).toBe(
      "https://shop.example.com/stores?state=WA",
    );
    expect(normalizeUrl("https://docs.example.com/errors?code=E42")).toBe(
      "https://docs.example.com/errors?code=E42",
    );
  });

  test("strips UTM params, fbclid, gclid", () => {
    const url =
      "https://example.com/page?utm_source=twitter&utm_medium=social&fbclid=abc&gclid=xyz&keep=yes";
    const normalized = normalizeUrl(url);
    expect(normalized).not.toContain("utm_source");
    expect(normalized).not.toContain("utm_medium");
    expect(normalized).not.toContain("fbclid");
    expect(normalized).not.toContain("gclid");
    expect(normalized).toContain("keep=yes");
  });

  test("strips the bare ref param", () => {
    expect(normalizeUrl("https://example.com/post?ref=hn&id=9")).toBe(
      "https://example.com/post?id=9",
    );
  });

  test("strips the union click-id params (igshid, msclkid, yclid, _ga, …)", () => {
    const url =
      "https://example.com/x?igshid=a&msclkid=b&yclid=c&_ga=d&dclid=e&gbraid=f&wbraid=g&keep=yes";
    const normalized = normalizeUrl(url);
    for (const noise of ["igshid", "msclkid", "yclid", "_ga", "dclid", "gbraid", "wbraid"]) {
      expect(normalized).not.toContain(noise);
    }
    expect(normalized).toContain("keep=yes");
  });

  test("strips ESP / newsletter per-recipient and click-id params", () => {
    const url =
      "https://example.com/x?mkt_tok=aaa&_hsenc=bbb&_hsmi=1&vero_id=ccc&oly_enc_id=ddd&elqTrackId=eee&spMailingID=fff&mc_tc=ggg&WT.mc_id=hhh&ml_subscriber=iii&keep=yes";
    const normalized = normalizeUrl(url);
    for (const noise of [
      "mkt_tok",
      "_hsenc",
      "_hsmi",
      "vero_id",
      "oly_enc_id",
      "elqTrackId",
      "spMailingID",
      "mc_tc",
      "WT.mc_id",
      "ml_subscriber",
    ]) {
      expect(normalized.toLowerCase()).not.toContain(noise.toLowerCase());
    }
    expect(normalized).toContain("keep=yes");
  });

  test("strips anchor-like fragments (no slash)", () => {
    expect(normalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
    expect(normalizeUrl("https://example.com/page#top")).toBe("https://example.com/page");
  });

  test("preserves path-like fragments (contain a slash) on generic hosts", () => {
    // Path-like fragments are kept on hosts without a host-specific
    // canonicalizer — they're identifiers, not anchors.
    expect(normalizeUrl("https://example.com/#section/sub")).toBe(
      "https://example.com/#section/sub",
    );
  });

  test("no source-specific knowledge in core: Gmail-shaped URLs stay verbatim by default", () => {
    // Without a canonicalizer registry, two Gmail flavors of the same
    // message are different strings to core. The canonicalization to
    // collapse them lives in the Gmail source package, not here.
    expect(normalizeUrl("https://mail.google.com/mail/u/0/#inbox/abc123")).toBe(
      "https://mail.google.com/mail/u/0/#inbox/abc123",
    );
    expect(normalizeUrl("https://mail.google.com/mail/u/0/#inbox/abc123")).not.toBe(
      normalizeUrl("https://mail.google.com/mail/u/0/#all/abc123"),
    );
  });
});

describe("normalizeUrl with canonicalizer registry", () => {
  test("first matching rule rewrites the URL", () => {
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["example.com"],
        rules: [
          {
            match: "^https://example\\.com/page/(\\d+).*$",
            replacement: "https://example.com/p/$1",
          },
        ],
      },
    ]);
    expect(normalizeUrl("https://example.com/page/42?utm_source=x#top", registry)).toBe(
      "https://example.com/p/42",
    );
  });

  test("only specs whose host matches are consulted", () => {
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["foo.example"],
        rules: [{ match: "^.*$", replacement: "https://rewritten" }],
      },
    ]);
    // bar.example isn't claimed — URL passes through generic rules only.
    expect(normalizeUrl("https://bar.example/page#section", registry)).toBe(
      "https://bar.example/page",
    );
  });

  test("invalid regex in a rule is skipped, doesn't crash", () => {
    const registry = buildCanonicalizerRegistry([
      {
        hosts: ["example.com"],
        rules: [
          { match: "(unbalanced", replacement: "broken" },
          {
            match: "^https://example\\.com/(\\w+).*$",
            replacement: "https://example.com/$1",
          },
        ],
      },
    ]);
    // The bad rule is silently dropped; the next rule still applies.
    expect(normalizeUrl("https://example.com/foo?utm_source=x", registry)).toBe(
      "https://example.com/foo",
    );
  });

  test("registry lookup is case-insensitive on host", () => {
    const registry = buildCanonicalizerRegistry([
      { hosts: ["example.com"], rules: [{ match: "^.*$", replacement: "ok" }] },
    ]);
    expect(normalizeUrl("https://Example.COM/page", registry)).toBe("ok");
  });

  test("sorts remaining query params", () => {
    const url = "https://example.com/page?z=1&a=2&m=3";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/page?a=2&m=3&z=1");
  });

  test("strips trailing slashes", () => {
    expect(normalizeUrl("https://example.com/page/")).toBe("https://example.com/page");
  });

  test("preserves the root-URL trailing slash (does not strip down to bare origin)", () => {
    // The strip is skipped when pathname is exactly "/". A bare-origin URL
    // with or without the slash both normalize to the slashed root form
    // (WHATWG URL always materializes the root slash), so they collide.
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  test("handles invalid URLs gracefully", () => {
    const invalid = "not-a-url";
    expect(normalizeUrl(invalid)).toBe("not-a-url");
  });

  test("lowercases and trims non-http URI schemes", () => {
    expect(normalizeUrl("OBSIDIAN://Open?vault=Notes&file=Test")).toBe(
      "obsidian://open?vault=notes&file=test",
    );
    expect(normalizeUrl("  things:///show?id=ABC  ")).toBe("things:///show?id=abc");
  });

  test("does not strip tracking params from non-http URLs", () => {
    const url = "obsidian://open?utm_source=test&file=note";
    const normalized = normalizeUrl(url);
    expect(normalized).toContain("utm_source");
  });
});

describe("buildCanonicalizerRegistry", () => {
  test("a later spec claiming the same host overwrites the earlier one (last-spec-wins)", () => {
    // Two specs both claim example.com. The registry keeps the LAST one,
    // so normalizeUrl applies the second spec's rewrite, not the first.
    const registry = buildCanonicalizerRegistry([
      { hosts: ["example.com"], rules: [{ match: "^.*$", replacement: "https://first" }] },
      { hosts: ["example.com"], rules: [{ match: "^.*$", replacement: "https://second" }] },
    ]);
    expect(registry.get("example.com")?.rules[0]?.replacement).toBe("https://second");
    expect(normalizeUrl("https://example.com/page", registry)).toBe("https://second");
  });

  test("flattens one entry per declared host, lowercased", () => {
    const spec = {
      hosts: ["Foo.Example", "bar.example"],
      rules: [{ match: "^.*$", replacement: "ok" }],
    };
    const registry = buildCanonicalizerRegistry([spec]);
    expect(registry.get("foo.example")).toBe(spec);
    expect(registry.get("bar.example")).toBe(spec);
    expect(registry.has("Foo.Example")).toBe(false);
  });
});

describe("canonicalDomain", () => {
  test("returns the lowercased hostname", () => {
    expect(canonicalDomain("https://EXAMPLE.com/path?q=1")).toBe("example.com");
  });

  test("strips a leading www. so www and apex collide", () => {
    expect(canonicalDomain("https://www.example.com/x")).toBe("example.com");
    // The whole point: the www and apex variants produce the same key.
    expect(canonicalDomain("https://www.example.com/x")).toBe(
      canonicalDomain("https://example.com/x"),
    );
  });

  test("only strips a leading www., not www inside the label", () => {
    // A subdomain literally named "www2" or a label like "wwwx" must NOT be
    // truncated — only the exact `www.` prefix is removed.
    expect(canonicalDomain("https://www2.example.com")).toBe("www2.example.com");
    expect(canonicalDomain("https://wwwexample.com")).toBe("wwwexample.com");
  });

  test("does not strip www. when it appears deeper than the leading label", () => {
    expect(canonicalDomain("https://mail.www.example.com")).toBe("mail.www.example.com");
  });

  test("returns empty string for unparseable input (never throws)", () => {
    expect(canonicalDomain("not-a-url")).toBe("");
    expect(canonicalDomain("")).toBe("");
  });
});

describe("urlToExternalId", () => {
  test("produces consistent SHA-256 hex string", () => {
    const id = urlToExternalId("https://example.com");
    expect(id).toHaveLength(64); // SHA-256 hex = 64 chars
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(urlToExternalId("https://example.com")).toBe(id);
  });

  test("produces different hashes for different URLs", () => {
    const id1 = urlToExternalId("https://example.com/page1");
    const id2 = urlToExternalId("https://example.com/page2");
    expect(id1).not.toBe(id2);
  });
});

describe("hostIsOwned", () => {
  const owned = ["mail.google.com", "notion.so", "web.whatsapp.com"];

  test("exact host match is owned", () => {
    expect(hostIsOwned("mail.google.com", owned)).toBe(true);
    expect(hostIsOwned("web.whatsapp.com", owned)).toBe(true);
  });

  test("subdomain of an owned domain is owned", () => {
    expect(hostIsOwned("www.notion.so", owned)).toBe(true);
    expect(hostIsOwned("my-team.notion.so", owned)).toBe(true);
  });

  test("matching is case-insensitive", () => {
    expect(hostIsOwned("MAIL.Google.COM", owned)).toBe(true);
    expect(hostIsOwned("notion.so", ["NOTION.SO"])).toBe(true);
  });

  test("a host not in the set is not owned", () => {
    expect(hostIsOwned("example.com", owned)).toBe(false);
    expect(hostIsOwned("news.example.org", owned)).toBe(false);
  });

  test("a sibling host that merely shares a suffix label is not owned", () => {
    // `google.com` is not declared, only `mail.google.com` — so the bare
    // apex and other Google subdomains are not skipped.
    expect(hostIsOwned("google.com", owned)).toBe(false);
    expect(hostIsOwned("drive.google.com", owned)).toBe(false);
  });

  test("a host that only ends with the domain text (no dot boundary) is not owned", () => {
    // "evilnotion.so" ends with "notion.so" textually but is a different
    // registrable domain — the leading-dot rule prevents a false skip.
    expect(hostIsOwned("evilnotion.so", owned)).toBe(false);
  });

  test("empty host or empty set never matches", () => {
    expect(hostIsOwned("", owned)).toBe(false);
    expect(hostIsOwned("example.com", [])).toBe(false);
  });
});
