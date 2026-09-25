// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv, parseDotEnv, scaffoldDotEnv, upsertDotEnv } from "./load-dotenv.js";

describe("loadDotEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-dotenv-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEnv(contents: string): void {
    writeFileSync(join(dir, ".env"), contents);
  }

  it("returns null and mutates nothing when no .env exists", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ dir, env });
    expect(result).toBeNull();
    expect(env).toEqual({});
  });

  it("loads a basic KEY=value pair", () => {
    writeEnv("OMNESIS_FAKE_KNOB=hello\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ dir, env });
    expect(env.OMNESIS_FAKE_KNOB).toBe("hello");
    expect(result).toEqual({ path: join(dir, ".env"), loaded: 1, keys: ["OMNESIS_FAKE_KNOB"] });
  });

  it("honours an optional leading `export `", () => {
    writeEnv("export OMNESIS_FAKE_KNOB=exported\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ dir, env });
    expect(env.OMNESIS_FAKE_KNOB).toBe("exported");
  });

  it("strips exactly one layer of matching quotes", () => {
    writeEnv(
      [
        'OMNESIS_DQ="double quoted"',
        "OMNESIS_SQ='single quoted'",
        "OMNESIS_NESTED=\"'inner'\"",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ dir, env });
    expect(env.OMNESIS_DQ).toBe("double quoted");
    expect(env.OMNESIS_SQ).toBe("single quoted");
    expect(env.OMNESIS_NESTED).toBe("'inner'");
  });

  it("skips comments and blank lines", () => {
    writeEnv("# a comment\n\n   \nOMNESIS_FAKE_KNOB=value\n# trailing\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ dir, env });
    expect(env.OMNESIS_FAKE_KNOB).toBe("value");
    expect(result?.loaded).toBe(1);
  });

  it("ignores malformed lines without throwing", () => {
    writeEnv("not_a_pair\nOMNESIS_OK=1\n=novalueforkey\n");
    const env: NodeJS.ProcessEnv = {};
    const result = loadDotEnv({ dir, env });
    expect(env.OMNESIS_OK).toBe("1");
    expect(result?.loaded).toBe(1);
  });

  it("does not overwrite a key already present in the environment", () => {
    writeEnv("OMNESIS_FAKE_KNOB=from-file\n");
    const env: NodeJS.ProcessEnv = { OMNESIS_FAKE_KNOB: "from-shell" };
    const result = loadDotEnv({ dir, env });
    expect(env.OMNESIS_FAKE_KNOB).toBe("from-shell"); // process env wins
    expect(result?.loaded).toBe(0);
  });

  it("parses duplicate keys and inline comment characters exactly as the loader does", () => {
    expect(parseDotEnv("PORT=17600\nPORT=17601\nBIND=host#literal\n")).toEqual({
      PORT: "17600",
      BIND: "host#literal",
    });
  });

  it("keeps everything after the first `=` in the value", () => {
    writeEnv("OMNESIS_URL=https://host:7600/path?a=b&c=d\n");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ dir, env });
    expect(env.OMNESIS_URL).toBe("https://host:7600/path?a=b&c=d");
  });

  it("does NOT interpolate ${VAR} references — values stay literal", () => {
    writeEnv("OMNESIS_LITERAL=${OMNESIS_FAKE_KNOB}\n");
    const env: NodeJS.ProcessEnv = { OMNESIS_FAKE_KNOB: "x" };
    loadDotEnv({ dir, env });
    expect(env.OMNESIS_LITERAL).toBe("${OMNESIS_FAKE_KNOB}");
  });

  it("resolves the dir from OMNESIS_CONFIG_DIR in the injected env when no dir is passed", () => {
    writeEnv("OMNESIS_FAKE_KNOB=via-config-dir\n");
    const env: NodeJS.ProcessEnv = { OMNESIS_CONFIG_DIR: dir };
    loadDotEnv({ env });
    expect(env.OMNESIS_FAKE_KNOB).toBe("via-config-dir");
  });
});

describe("scaffoldDotEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-scaffold-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a commented template at mode 0600 when absent", () => {
    expect(scaffoldDotEnv(dir)).toBe(true);
    const path = join(dir, ".env");
    expect(existsSync(path)).toBe(true);
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("# Omnesis environment file");
    // Every setting line is commented out, so the scaffold is inert until edited.
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ dir, env });
    expect(Object.keys(env)).toHaveLength(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing .env", () => {
    writeFileSync(join(dir, ".env"), "OMNESIS_FAKE_KNOB=keepme\n");
    expect(scaffoldDotEnv(dir)).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("OMNESIS_FAKE_KNOB=keepme\n");
  });
});

describe("upsertDotEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-upsert-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function read(): string {
    return readFileSync(join(dir, ".env"), "utf8");
  }

  it("creates the file at mode 0600 when absent", () => {
    const { changed } = upsertDotEnv(dir, { OMNESIS_TLS_CERT: "/x/c.crt" });
    expect(changed).toEqual(["OMNESIS_TLS_CERT"]);
    expect(read()).toBe("OMNESIS_TLS_CERT=/x/c.crt\n");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("updates an existing key in place rather than appending a duplicate", () => {
    writeFileSync(join(dir, ".env"), "OMNESIS_TLS_CERT=/old.crt\nOMNESIS_BIND=0.0.0.0\n");
    const { changed } = upsertDotEnv(dir, { OMNESIS_TLS_CERT: "/new.crt" });
    expect(changed).toEqual(["OMNESIS_TLS_CERT"]);
    const out = read();
    // Exactly one OMNESIS_TLS_CERT line, with the new value; other keys intact.
    expect(out.match(/OMNESIS_TLS_CERT=/g)).toHaveLength(1);
    expect(out).toContain("OMNESIS_TLS_CERT=/new.crt");
    expect(out).toContain("OMNESIS_BIND=0.0.0.0");
  });

  it("appends keys that are not yet present, preserving comments and blanks", () => {
    writeFileSync(join(dir, ".env"), "# my config\n\nOMNESIS_BIND=0.0.0.0\n");
    upsertDotEnv(dir, { OMNESIS_TLS_CERT: "/c.crt", OMNESIS_TLS_KEY: "/c.key" });
    const out = read();
    expect(out).toContain("# my config");
    expect(out).toContain("OMNESIS_BIND=0.0.0.0");
    expect(out).toContain("OMNESIS_TLS_CERT=/c.crt");
    expect(out).toContain("OMNESIS_TLS_KEY=/c.key");
  });

  it("is idempotent — a re-run with identical values changes nothing", () => {
    upsertDotEnv(dir, { OMNESIS_TLS_CERT: "/c.crt", OMNESIS_TLS_KEY: "/c.key" });
    const first = read();
    const { changed } = upsertDotEnv(dir, {
      OMNESIS_TLS_CERT: "/c.crt",
      OMNESIS_TLS_KEY: "/c.key",
    });
    expect(changed).toEqual([]);
    expect(read()).toBe(first);
  });

  it("rewrites an `export `-prefixed / quoted line cleanly without duplicating it", () => {
    writeFileSync(join(dir, ".env"), 'export OMNESIS_TLS_CERT="/old.crt"\n');
    upsertDotEnv(dir, { OMNESIS_TLS_CERT: "/new.crt" });
    const out = read();
    expect(out.match(/OMNESIS_TLS_CERT/g)).toHaveLength(1);
    expect(out).toContain("OMNESIS_TLS_CERT=/new.crt");
    // Re-reading via loadDotEnv yields the new value.
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ dir, env });
    expect(env.OMNESIS_TLS_CERT).toBe("/new.crt");
  });
});
