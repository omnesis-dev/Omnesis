// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDemoHostStates } from "./synthetic-demo-host-state.js";

let root: string;
const pairing = {
  device: { id: "fictional-device" },
  token: "fictional-token",
  universe: "/tmp/fictional-universe",
  gatewayUrl: "https://localhost:18761",
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "demo-host-state-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("demo host filesystem and credential boundary", () => {
  it.each(["../escape", ".", "..", "/absolute", "nested/device", "nested\\device", "", "bad\0id"])(
    "rejects roster id %j before any state directory is created",
    (id) => {
      expect(() => prepareDemoHostStates(root, ["macbook", id])).toThrow("safe single");
      expect(existsSync(join(root, "demo-hosts"))).toBe(false);
    },
  );

  it("rejects duplicate ids", () => {
    expect(() => prepareDemoHostStates(root, ["macbook", "macbook"])).toThrow("distinct");
  });

  it.each(["root", "device"])(
    "rejects a symlinked %s before accessing its pairing credential",
    (level) => {
      const outside = join(root, "outside");
      mkdirSync(outside);
      if (level === "root") symlinkSync(outside, join(root, "demo-hosts"));
      else {
        mkdirSync(join(root, "demo-hosts"));
        symlinkSync(outside, join(root, "demo-hosts", "macbook"));
      }
      expect(() => prepareDemoHostStates(root, ["macbook"])).toThrow("without symlinks");
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it("rejects pairing symlinks both during initial preflight and before a later save", () => {
    const state = prepareDemoHostStates(root, ["macbook"]).get("macbook")!;
    const outside = join(root, "outside.json"),
      path = join(state.dir, "pairing.json");
    writeFileSync(outside, "must remain unchanged", { mode: 0o600 });
    symlinkSync(outside, path);
    expect(() => prepareDemoHostStates(root, ["macbook"])).toThrow("regular file");
    expect(() => state.save(pairing)).toThrow("regular file");
    expect(readFileSync(outside, "utf8")).toBe("must remain unchanged");
    expect(readdirSync(state.dir)).toEqual(["pairing.json"]);
  });

  it("checks every device's saved state before returning hosts for API pairing", () => {
    const states = prepareDemoHostStates(root, ["macbook", "iphone"]);
    mkdirSync(join(states.get("iphone")!.dir, "pairing.json"));
    expect(() => prepareDemoHostStates(root, ["macbook", "iphone"])).toThrow("regular file");
    expect(existsSync(join(states.get("macbook")!.dir, "pairing.json"))).toBe(false);
  });

  it("persists minimal private validated state atomically and loads it for retries", () => {
    const state = prepareDemoHostStates(root, ["macbook"]).get("macbook")!;
    expect(state.saved).toBeUndefined();
    state.save({
      ...pairing,
      extra: "not persisted",
      device: { ...pairing.device, name: "Fictional device" },
    });
    const path = join(state.dir, "pairing.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(pairing);
    const retry = prepareDemoHostStates(root, ["macbook"]).get("macbook")!;
    expect(retry.saved).toEqual(pairing);
    retry.save({ ...pairing, token: "replacement-fictional-token" });
    expect(prepareDemoHostStates(root, ["macbook"]).get("macbook")!.saved?.token).toBe(
      "replacement-fictional-token",
    );
    expect(readdirSync(state.dir)).toEqual(["pairing.json"]);
    expect(() => retry.save({ ...pairing, token: "" })).toThrow("Invalid demo pairing");
    expect(readFileSync(path, "utf8")).toContain("replacement-fictional-token");
  });

  it("rejects public permissions, oversize state, and malformed JSON without exposing its text", () => {
    const state = prepareDemoHostStates(root, ["macbook"]).get("macbook")!;
    const path = join(state.dir, "pairing.json");
    writeFileSync(path, JSON.stringify(pairing), { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => prepareDemoHostStates(root, ["macbook"])).toThrow("bounded private");
    chmodSync(path, 0o600);
    writeFileSync(path, " ".repeat(64 * 1024 + 1));
    expect(() => prepareDemoHostStates(root, ["macbook"])).toThrow("bounded private");
    writeFileSync(path, '{"fictional-secret":');
    expect(() => prepareDemoHostStates(root, ["macbook"])).toThrow(/^Invalid demo pairing JSON$/);
  });
});
