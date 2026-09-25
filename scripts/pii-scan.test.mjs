// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  scanText,
  staleAllowlistEntries,
  isGhWrite,
  extractBodyFiles,
  isOwnCopyrightHeaderLine,
} from "./pii-scan.mjs";

// All example data here is invented (RFC-2606 reserved domains, NANP/Ofcom
// fiction ranges, fabricated names). Never source test data from the corpus.

const emptyAllowlist = {
  emails: [],
  phones: [],
  privateIps: [],
  tailnetIps: [],
  names: [],
  secretFixtures: [],
};

const kinds = (text, opts) =>
  scanText(text, { denylist: [], allowlist: emptyAllowlist, ...opts }).map((f) => f.kind);

describe("emails", () => {
  it("flags a real-looking email", () => {
    expect(kinds("ping kai@redwoodlabs.com about it")).toContain("email");
  });
  it("allows reviewed fixture emails case-insensitively", () => {
    expect(
      scanText("ping MAYA.REALISH@REDWOODLABS.COM", {
        path: "fixtures/email.test.ts",
        denylist: [],
        allowlist: {
          emails: [
            {
              value: "maya.realish@redwoodlabs.com",
              paths: ["fixtures/email.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it("does not let a reviewed fixture email escape its path scope", () => {
    const allowlist = {
      emails: [
        {
          value: "maya.realish@redwoodlabs.com",
          paths: ["fixtures/email.test.ts"],
          reason: "invented test fixture",
        },
      ],
    };
    expect(
      scanText("ping maya.realish@redwoodlabs.com", {
        path: "fixtures/other.test.ts",
        denylist: [],
        allowlist,
      }).map((f) => f.kind),
    ).toContain("email");
    expect(
      scanText("ping maya.realish@redwoodlabs.com", {
        denylist: [],
        allowlist,
      }).map((f) => f.kind),
    ).toContain("email");
  });
  it("allows reserved example domains", () => {
    expect(scanText("maya@example.com, dev@example.org, x@example.io", { denylist: [] })).toEqual(
      [],
    );
  });
  it("allows reserved TLDs and example subdomains", () => {
    expect(scanText("a@host.invalid b@mail.example.com c@svc.test", { denylist: [] })).toEqual([]);
  });
});

describe("phones", () => {
  it("flags a real-looking phone number", () => {
    expect(kinds("call +1 312 624 0719 today")).toContain("phone");
  });
  it("allows reviewed fixture phones across formatting variants", () => {
    expect(
      scanText("call (312) 624-0719 today", {
        path: "fixtures/phone.test.ts",
        denylist: [],
        allowlist: {
          phones: [
            {
              value: "+1 312 624 0719",
              paths: ["fixtures/phone.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it("does not let a reviewed fixture phone escape its path scope", () => {
    expect(
      scanText("call (312) 624-0719 today", {
        path: "fixtures/other.test.ts",
        denylist: [],
        allowlist: {
          phones: [
            {
              value: "+1 312 624 0719",
              paths: ["fixtures/phone.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }).map((f) => f.kind),
    ).toContain("phone");
  });
  it("allows the NANP 555-01xx fiction range, incl. the (555) 010-0xxx form", () => {
    expect(kinds("ring +1 (555) 010-0123 or 555-0142")).not.toContain("phone");
  });
  it("allows the UK Ofcom drama range", () => {
    expect(kinds("UK line +44 7700 900123")).not.toContain("phone");
  });
  it("ignores short digit runs that are not phone numbers", () => {
    expect(kinds("port 17600 and version 4.8.1")).not.toContain("phone");
  });
});

describe("network identifiers", () => {
  it("flags a tailnet (CGNAT 100.64/10) IP", () => {
    expect(kinds("host at 100.80.0.1")).toContain("tailnet-ip");
  });
  it("allows reviewed fixture private and tailnet IPs", () => {
    expect(
      scanText("router 192.168.1.1 and tailnet 100.80.0.1", {
        path: "fixtures/network.test.ts",
        denylist: [],
        allowlist: {
          privateIps: [
            {
              value: "192.168.1.1",
              paths: ["fixtures/network.test.ts"],
              reason: "invented test fixture",
            },
          ],
          tailnetIps: [
            {
              value: "100.80.0.1",
              paths: ["fixtures/network.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it("does not let reviewed fixture IPs escape their path scope", () => {
    expect(
      scanText("router 192.168.1.1 and tailnet 100.80.0.1", {
        path: "fixtures/other.test.ts",
        denylist: [],
        allowlist: {
          privateIps: [
            {
              value: "192.168.1.1",
              paths: ["fixtures/network.test.ts"],
              reason: "invented test fixture",
            },
          ],
          tailnetIps: [
            {
              value: "100.80.0.1",
              paths: ["fixtures/network.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }).map((f) => f.kind),
    ).toEqual(expect.arrayContaining(["private-ip", "tailnet-ip"]));
  });
  it("flags a private-LAN IP", () => {
    expect(kinds("router 192.168.1.1")).toContain("private-ip");
  });
  it("flags a Tailscale ULA IPv6 in any case", () => {
    expect(kinds("node at fd7a:115c:a1e0::12ab:34cd")).toContain("tailnet-ip");
    expect(kinds("node at FD7A:115C:A1E0::12AB:34CD")).toContain("tailnet-ip");
  });
  it("allows a reviewed fixture Tailscale IPv6 case-insensitively, path-scoped", () => {
    const allowlist = {
      tailnetIps: [
        {
          value: "fd7a:115c:a1e0::12ab:34cd",
          paths: ["fixtures/network.test.ts"],
          reason: "invented test fixture",
        },
      ],
    };
    expect(
      scanText("node at FD7A:115C:A1E0::12AB:34CD", {
        path: "fixtures/network.test.ts",
        denylist: [],
        allowlist,
      }),
    ).toEqual([]);
    expect(
      scanText("node at fd7a:115c:a1e0::12ab:34cd", {
        path: "fixtures/other.test.ts",
        denylist: [],
        allowlist,
      }).map((f) => f.kind),
    ).toContain("tailnet-ip");
  });
  it("does not treat other ULA IPv6 space as tailnet", () => {
    expect(kinds("fdab:cdef:1234::1")).not.toContain("tailnet-ip");
  });
  it("does not treat a public IP as private/tailnet", () => {
    const k = kinds("8.8.8.8");
    expect(k).not.toContain("tailnet-ip");
    expect(k).not.toContain("private-ip");
  });
});

describe("secrets", () => {
  it("flags a GitHub token", () => {
    expect(kinds(`token ghp_${"A".repeat(40)} here`)).toContain("github-token");
  });
  it("flags an OpenAI-style key", () => {
    expect(kinds(`key sk-${"b".repeat(32)}`)).toContain("openai-key");
  });
  it("flags an Anthropic key (hyphens defeat the openai-key pattern)", () => {
    const k = kinds(`key sk-ant-api03-${"c".repeat(24)}-x9AB_cd`);
    expect(k).toContain("anthropic-key");
    expect(k).not.toContain("openai-key");
  });
  it("flags a Google API key", () => {
    expect(kinds(`key AIza${"D".repeat(35)}`)).toContain("google-api-key");
  });
  it("flags a Slack token", () => {
    expect(kinds(`xoxb-123456789012-abcdefABCDEF`)).toContain("slack-token");
  });
  it("flags an AWS access key id", () => {
    expect(kinds("AKIAABCDEFGHIJKLMNOP")).toContain("aws-access-key");
  });
  it("flags a private key block", () => {
    expect(kinds("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private-key");
  });
  it("allows path-scoped fake secret fixtures without allowing other paths", () => {
    const allowlist = {
      secretFixtures: [
        {
          path: "fixtures/fake-key.test.ts",
          kind: "private-key",
          reason: "fake fixture",
        },
      ],
    };
    expect(
      scanText("-----BEGIN OPENSSH PRIVATE KEY-----", {
        path: "fixtures/fake-key.test.ts",
        denylist: [],
        allowlist,
      }),
    ).toEqual([]);
    expect(
      scanText("-----BEGIN OPENSSH PRIVATE KEY-----", {
        path: "fixtures/other.test.ts",
        denylist: [],
        allowlist,
      }).map((f) => f.kind),
    ).toContain("private-key");
  });
  it("flags a literal bearer token but not an env-substituted one", () => {
    expect(kinds(`Authorization: Bearer ${"x".repeat(30)}`)).toContain("bearer-token");
    expect(kinds("Authorization: Bearer $(cat ~/.config/omnesis/token)")).not.toContain(
      "bearer-token",
    );
  });
  it("redacts the secret value in the finding", () => {
    const f = scanText(`ghp_${"A".repeat(40)}`, { denylist: [] });
    expect(f[0].match).toMatch(/redacted/);
    expect(f[0].match).not.toContain("A".repeat(40));
  });
});

describe("non-public references", () => {
  it("flags references to the private repository", () => {
    expect(kinds("See the omnesis-private issue tracker for the design")).toContain(
      "non-public-reference",
    );
    expect(kinds("https://github.com/example/Omnesis-Private/issues/42")).toContain(
      "non-public-reference",
    );
  });
});

describe("operator denylist", () => {
  it("flags a denylisted literal case-insensitively without echoing it", () => {
    const f = scanText("deploying to Acme-DeployBot now", { denylist: ["acme-deploybot"] });
    expect(f.map((x) => x.kind)).toContain("denylist");
    expect(f.find((x) => x.kind === "denylist").match).not.toMatch(/acme-deploybot/i);
  });
});

describe("names", () => {
  it("flags full-name candidates only when requested", () => {
    expect(kinds("Maya Redwood reviewed it")).not.toContain("name");
    expect(scanText("Maya Redwood reviewed it", { denylist: [], scanNames: true })).toContainEqual(
      expect.objectContaining({ kind: "name", match: "Maya Redwood" }),
    );
  });
  it("allows reviewed fixture names", () => {
    expect(
      scanText("Maya Redwood reviewed it", {
        path: "fixtures/demo.test.ts",
        denylist: [],
        scanNames: true,
        allowlist: {
          names: [
            {
              value: "Maya Redwood",
              paths: ["fixtures/demo.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }),
    ).toEqual([]);
  });
  it("does not let a reviewed fixture name escape its path scope", () => {
    expect(
      scanText("Maya Redwood reviewed it", {
        path: "fixtures/other.test.ts",
        denylist: [],
        scanNames: true,
        allowlist: {
          names: [
            {
              value: "Maya Redwood",
              paths: ["fixtures/demo.test.ts"],
              reason: "invented test fixture",
            },
          ],
        },
      }).map((f) => f.kind),
    ).toContain("name");
  });
  it("reports file and line when a path is provided", () => {
    expect(
      scanText("clean\nMaya Redwood reviewed it", {
        denylist: [],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }),
    ).toContainEqual(expect.objectContaining({ path: "fixtures/demo.test.ts", line: 2 }));
  });
  it("treats copyright attribution as metadata, while still scanning the same name in content", () => {
    const copyright =
      "// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (c) 2026 Maya Redwood";
    expect(scanText(copyright, { denylist: [], scanNames: true })).toEqual([]);
    expect(
      scanText(copyright, {
        denylist: [],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }),
    ).toEqual([]);
    expect(
      scanText(`${copyright}\nMaya Redwood reviewed it`, {
        denylist: [],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }),
    ).toContainEqual(expect.objectContaining({ kind: "name", match: "Maya Redwood", line: 3 }));
  });
  it("does not exempt copyright-shaped fixture content outside the SPDX header", () => {
    expect(
      scanText("const record = true;\n// Copyright (c) 2026 Maya Redwood", {
        denylist: [],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }),
    ).toContainEqual(expect.objectContaining({ kind: "name", match: "Maya Redwood", line: 2 }));
  });
  it("still applies the operator denylist to copyright attribution", () => {
    expect(
      scanText("// Copyright (c) 2026 Maya Redwood", {
        denylist: ["Maya Redwood"],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }).map((finding) => finding.kind),
    ).toContain("denylist");
  });
  it("still scans non-name identifiers on copyright lines", () => {
    expect(
      scanText("// Copyright (c) 2026 Maya Redwood <maya@redwoodlabs.com>", {
        denylist: [],
        scanNames: true,
        path: "fixtures/demo.test.ts",
      }).map((finding) => finding.kind),
    ).toContain("email");
  });
});

describe("a file's own licence header in a staged diff", () => {
  // A diff hands each added line on its own, so a newly added file's header
  // loses the context that exempts it in whole-file scans. Without this the
  // guard blocks every new file the repo's own header script would produce.
  it("exempts the copyright line of the file it belongs to", () => {
    expect(
      isOwnCopyrightHeaderLine("scripts/pii-scan.test.mjs", "// Copyright (c) 2026 Adrien Conrath"),
    ).toBe(true);
  });
  it("does not exempt a name dressed up as a copyright line further down a file", () => {
    expect(
      isOwnCopyrightHeaderLine("scripts/pii-scan.test.mjs", "// Copyright (c) 2026 Maya Reeves"),
    ).toBe(false);
  });
  it("does not exempt a line attributed to no file", () => {
    expect(isOwnCopyrightHeaderLine("", "// Copyright (c) 2026 Adrien Conrath")).toBe(false);
  });
  it("does not exempt an ordinary added line", () => {
    expect(
      isOwnCopyrightHeaderLine("scripts/pii-scan.test.mjs", "const owner = 'Maya Reeves';"),
    ).toBe(false);
  });
});

describe("clean text", () => {
  it("returns no findings for ordinary prose", () => {
    expect(
      scanText("Refactor the indexer to dedup chunks before ranking.", { denylist: [] }),
    ).toEqual([]);
  });
});

describe("dedupe", () => {
  it("reports a repeated value once", () => {
    const f = scanText("kai@redwoodlabs.com and again kai@redwoodlabs.com", { denylist: [] });
    expect(f.filter((x) => x.kind === "email")).toHaveLength(1);
  });
});

describe("staleAllowlistEntries", () => {
  const allowlist = {
    ...emptyAllowlist,
    emails: [
      {
        value: "maya.realish@redwoodlabs.com",
        paths: ["fixtures/live.ts", "fixtures/gone.ts", "fixtures/missing.ts"],
        reason: "invented test fixture",
      },
    ],
    phones: [
      { value: "+1 312 624 0719", paths: ["fixtures/live.ts"], reason: "invented test fixture" },
    ],
    secretFixtures: [
      { path: "fixtures/live.ts", kind: "private-key", reason: "fake fixture" },
      { path: "fixtures/gone.ts", kind: "private-key", reason: "fake fixture" },
    ],
  };
  const files = {
    // Formatting differs from the allowlisted phone value — normalization must match it.
    "fixtures/live.ts":
      "MAYA.REALISH@REDWOODLABS.COM (312) 624-0719 -----BEGIN OPENSSH PRIVATE KEY-----",
    "fixtures/gone.ts": "nothing sensitive here",
  };
  const readFn = (p) => files[p] ?? null;

  it("keeps grants whose value is still present (across case and phone formatting)", () => {
    const stale = staleAllowlistEntries(allowlist, readFn);
    expect(stale).toHaveLength(3);
    expect(stale.every((f) => f.kind === "stale-allowlist")).toBe(true);
  });
  it("reports absent values and missing files with the grant location", () => {
    const matches = staleAllowlistEntries(allowlist, readFn).map((f) => f.match);
    expect(matches).toContainEqual(expect.stringContaining("fixtures/gone.ts (value absent)"));
    expect(matches).toContainEqual(expect.stringContaining("fixtures/missing.ts (file missing)"));
    expect(matches).toContainEqual(
      expect.stringContaining("secretFixtures: private-key @ fixtures/gone.ts"),
    );
  });
});

describe("isGhWrite", () => {
  it.each([
    ["gh issue create --title x --body y", true],
    ["gh issue comment 5 --body hi", true],
    ["gh pr create --base main --head b --body z", true],
    ["gh pr edit 7 --body z", true],
    ['gh api repos/o/r/issues/1/comments -f body="hi"', true],
    ["gh issue view 5", false],
    ["gh pr list --state open", false],
    ["git push origin main", false],
    ["echo hello", false],
  ])("%s -> %s", (cmd, expected) => {
    expect(isGhWrite(cmd)).toBe(expected);
  });
});

describe("extractBodyFiles", () => {
  it("pulls --body-file paths", () => {
    expect(extractBodyFiles("gh pr create --body-file /tmp/body.md")).toEqual(["/tmp/body.md"]);
  });
  it("pulls -F field=@file paths", () => {
    expect(extractBodyFiles("gh api x -F body=@/tmp/b.txt")).toEqual(["/tmp/b.txt"]);
  });
});
