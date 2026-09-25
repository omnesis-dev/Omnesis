// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CliError } from "../utils.js";
import {
  FileConfigTarget,
  GatewayConfigTarget,
  isConnectionRefused,
  probeGateway,
  resolveConfigTarget,
  type ConfigTargetEnvironment,
} from "./config-target.js";
import type { AddressInfo } from "node:net";
import type { GatewayLockHolder } from "@omnesis/core";

const HOLDER: GatewayLockHolder = {
  pid: 4242,
  processStart: null,
  hostname: "gateway-host",
  startedAt: "2026-09-14T10:00:00.000Z",
};

function refused(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7600"), {
      code: "ECONNREFUSED",
    }),
  });
}

describe("isConnectionRefused", () => {
  test("a refused connect under fetch's TypeError", () => {
    expect(isConnectionRefused(refused())).toBe(true);
  });

  test("every address of a multi-address host refused", () => {
    const all = new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED ::1:7600"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7600"), { code: "ECONNREFUSED" }),
    ]);
    expect(isConnectionRefused(new TypeError("fetch failed", { cause: all }))).toBe(true);
  });

  test("one address refused and another timed out is not a refusal", () => {
    const mixed = new AggregateError([
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    ]);
    expect(isConnectionRefused(new TypeError("fetch failed", { cause: mixed }))).toBe(false);
  });

  test("TLS failures, timeouts and non-errors are not refusals", () => {
    const tls = new TypeError("fetch failed", {
      cause: Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    });
    expect(isConnectionRefused(tls)).toBe(false);
    expect(isConnectionRefused(new DOMException("The operation timed out.", "TimeoutError"))).toBe(
      false,
    );
    expect(isConnectionRefused("ECONNREFUSED")).toBe(false);
    expect(isConnectionRefused(null)).toBe(false);
  });
});

describe("probeGateway", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  test("any HTTP response counts as answered, errors included", async () => {
    server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await probeGateway(`http://127.0.0.1:${port}`)).toBe("answered");
  });

  test("a closed port is refused", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await probeGateway(`http://127.0.0.1:${port}`)).toBe("refused");
  });
});

describe("resolveConfigTarget", () => {
  function env(overrides: Partial<ConfigTargetEnvironment>): ConfigTargetEnvironment {
    return {
      gatewayUrl: "https://localhost:7600",
      configDir: "/tmp/omnesis-config-target-test",
      gatewayHolder: () => null,
      probe: vi.fn(() => Promise.resolve("refused" as const)),
      ...overrides,
    };
  }

  test("a remote gateway is always the gateway, without probing", async () => {
    const probe = vi.fn(() => Promise.resolve("refused" as const));
    const target = await resolveConfigTarget(
      env({ gatewayUrl: "https://gateway.example.com:7600", probe }),
    );
    expect(target).toBeInstanceOf(GatewayConfigTarget);
    expect(probe).not.toHaveBeenCalled();
  });

  test("a local gateway holding its lock is the gateway, even before it listens", async () => {
    const probe = vi.fn(() => Promise.resolve("refused" as const));
    const target = await resolveConfigTarget(env({ gatewayHolder: () => HOLDER, probe }));
    expect(target).toBeInstanceOf(GatewayConfigTarget);
    expect(probe).not.toHaveBeenCalled();
  });

  test("something answering at the URL is the gateway, whatever the lock says", async () => {
    expect(
      await resolveConfigTarget(env({ probe: () => Promise.resolve("answered" as const) })),
    ).toBeInstanceOf(GatewayConfigTarget);
  });

  test("an unreachable but not refused URL is the gateway, so its error surfaces", async () => {
    expect(
      await resolveConfigTarget(env({ probe: () => Promise.resolve("unreachable" as const) })),
    ).toBeInstanceOf(GatewayConfigTarget);
  });

  test("a local, unlocked, refusing gateway means the file", async () => {
    for (const gatewayUrl of [
      "https://localhost:7600",
      "https://127.0.0.1:7600",
      "https://[::1]:7600",
    ]) {
      const target = await resolveConfigTarget(env({ gatewayUrl }));
      expect(target).toBeInstanceOf(FileConfigTarget);
      expect((target as FileConfigTarget).path).toBe(
        "/tmp/omnesis-config-target-test/omnesis.json",
      );
    }
  });
});

describe("FileConfigTarget", () => {
  let dir: string;
  let holder: GatewayLockHolder | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-config-target-"));
    holder = null;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const target = () => new FileConfigTarget(dir, () => holder);
  const file = () => join(dir, "omnesis.json");

  test("a missing file reads as the empty config", async () => {
    expect(await target().load()).toEqual({ config: {}, version: 0 });
    expect(await target().loadRaw()).toBe("{}\n");
  });

  test("a patch creates the file owner-only, reporting the leaf that changed", async () => {
    const res = await target().patch({ gateway: { mdns: { enabled: false } } });
    expect(res).toMatchObject({ ok: true, changedPaths: ["/gateway/mdns/enabled"] });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      gateway: { mdns: { enabled: false } },
    });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["omnesis.json"]);
    expect((await target().load()).config).toEqual({ gateway: { mdns: { enabled: false } } });
  });

  test("a patch merges into what is already set", async () => {
    writeFileSync(file(), JSON.stringify({ search: { params: { resultLimit: 10 } } }));
    const res = await target().patch({ gateway: { mdns: { enabled: false } } });
    expect(res).toMatchObject({ ok: true, changedPaths: ["/gateway/mdns/enabled"] });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      search: { params: { resultLimit: 10 } },
      gateway: { mdns: { enabled: false } },
    });
  });

  test("a patch that changes nothing leaves the file untouched", async () => {
    const text = JSON.stringify({ gateway: { mdns: { enabled: false } } });
    writeFileSync(file(), text);
    const res = await target().patch({ gateway: { mdns: { enabled: false } } });
    expect(res).toMatchObject({ ok: true, changedPaths: [] });
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  test("an invalid value is refused with the validator's path and nothing is written", async () => {
    const res = await target().patch({ gateway: { mdns: { enabled: "sometimes" } } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Validation failed");
    expect(res.errors?.map((e) => e.path)).toContain("/gateway/mdns/enabled");
    expect(existsSync(file())).toBe(false);
  });

  test("an unrecognised key is refused in a mutation, as the gateway's admin API refuses it", async () => {
    const res = await target().patch({ gateway: { mdns: { enabeld: false } } });
    expect(res.ok).toBe(false);
  });

  test("keys the gateway would drop at boot are dropped when the file is rewritten", async () => {
    writeFileSync(
      file(),
      JSON.stringify({ retiredKnob: true, search: { params: { resultLimit: 10 } } }),
    );
    expect((await target().load()).config).toEqual({ search: { params: { resultLimit: 10 } } });
    await target().patch({ gateway: { mdns: { enabled: false } } });
    expect(JSON.parse(readFileSync(file(), "utf8"))).not.toHaveProperty("retiredKnob");
  });

  test("a file that fails validation can be repaired by the mutation", async () => {
    writeFileSync(file(), JSON.stringify({ gateway: { mdns: { enabled: "sometimes" } } }));
    const res = await target().patch({ gateway: { mdns: { enabled: true } } });
    expect(res).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      gateway: { mdns: { enabled: true } },
    });
  });

  test("a file that is not JSON, or not an object, is refused", async () => {
    writeFileSync(file(), "{ not json");
    await expect(target().load()).rejects.toThrow(/is not valid JSON/);
    writeFileSync(file(), "[]");
    await expect(target().patch({ gateway: { mdns: { enabled: false } } })).rejects.toThrow(
      /must hold a JSON object/,
    );
  });

  test("a replacement validates the whole config", async () => {
    writeFileSync(file(), JSON.stringify({ search: { params: { resultLimit: 10 } } }));
    const res = await target().replace({ gateway: { mdns: { enabled: false } } });
    expect(res).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      gateway: { mdns: { enabled: false } },
    });
    expect((await target().replace({ gateway: 5 })).ok).toBe(false);
  });

  test("a gateway that took the lock meanwhile leaves the file alone", async () => {
    holder = HOLDER;
    await expect(target().patch({ gateway: { mdns: { enabled: false } } })).rejects.toBeInstanceOf(
      CliError,
    );
    expect(existsSync(file())).toBe(false);
  });

  test("the version follows the file, so an editor can tell it changed underneath", async () => {
    await target().patch({ gateway: { mdns: { enabled: false } } });
    const before = await target().version();
    expect(before).toBeGreaterThan(0);
    writeFileSync(file(), JSON.stringify({}));
    const later = Date.now() / 1000 + 5;
    const { utimesSync } = await import("node:fs");
    utimesSync(file(), later, later);
    expect(await target().version()).not.toBe(before);
  });
});
