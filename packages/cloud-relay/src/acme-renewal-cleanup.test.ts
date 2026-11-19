// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { tlsFiles } from "../test/support.js";
import { localAcmeAuthority } from "../test/acme-authority.js";
import { issueAcmeCertificate } from "./acme-client.js";
import { GatewayAcmeRenewal } from "./acme-gateway.js";

let directory: string;
const locks: core.GatewayLock[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "acme-owned-cleanup-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
  const acquire = core.acquireGatewayLock;
  vi.spyOn(core, "acquireGatewayLock").mockImplementation(async (...args) => {
    const lock = await acquire(...args);
    locks.push(lock);
    return lock;
  });
});
afterEach(async () => {
  // Every marker here is an injected failure with no unjoined process. Retire only these fixtures.
  for (const lock of locks.splice(0)) lock.release();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
function fixture(
  issuer: NonNullable<ConstructorParameters<typeof GatewayAcmeRenewal>[0]["issuer"]>,
) {
  const files = tlsFiles(directory, "gateway.example.test");
  return {
    files,
    renewal: new GatewayAcmeRenewal({
      directoryUrl: "https://ca.example.test/directory",
      publicOrigin: "https://gateway.example.test",
      certificateFile: files.certFile,
      privateKeyFile: files.keyFile,
      accountKeyFile: join(directory, "account.key"),
      presenter: { create: async () => ({ id: "unused" }), remove: async () => {} },
      activate: async () => {},
      issuer,
    }),
  };
}

test("marked issuance preserves the renewal lease and refuses another issuer or close success", async () => {
  const marker = Object.assign(new Error("fixture issuer cleanup uncertain"), {
    cleanupFailure: undefined,
  });
  const issuer = vi.fn(async () => {
    throw marker;
  });
  const { files, renewal } = fixture(issuer);
  const original = await readFile(files.certFile, "utf8");
  await expect(renewal.renew(new AbortController().signal)).rejects.toBe(marker);
  expect(renewal.cleanupFailure()).toBe(marker);
  await expect(
    core.acquireGatewayLock(join(directory, ".acme-renewal"), { waitMs: 0 }),
  ).rejects.toThrow();
  await expect(renewal.renew(new AbortController().signal)).rejects.toBe(marker);
  expect(issuer).toHaveBeenCalledOnce();
  expect(await readFile(files.certFile, "utf8")).toBe(original);
  const close = renewal.close();
  expect(renewal.close()).toBe(close);
  await expect(close).rejects.toBe(marker);
});

test("ordinary joined issuance errors release the lease and allow a new attempt", async () => {
  const error = new Error("ordinary fixture issuer outage");
  const issuer = vi.fn(async () => {
    throw error;
  });
  const { renewal } = fixture(issuer);
  await expect(renewal.renew(new AbortController().signal)).rejects.toBe(error);
  expect(renewal.cleanupFailure()).toBeUndefined();
  const other = await core.acquireGatewayLock(join(directory, ".acme-renewal"), { waitMs: 0 });
  other.release();
  await expect(renewal.renew(new AbortController().signal)).rejects.toBe(error);
  expect(issuer).toHaveBeenCalledTimes(2);
  await expect(renewal.close()).resolves.toBeUndefined();
});

test.each(["activation-held", "joined", "rollback-held"] as const)(
  "activation mode=%s controls rollback and lease retention",
  async (mode) => {
    const uncertain = mode !== "joined";
    const hostname = "gateway.example.test";
    const files = tlsFiles(directory, hostname);
    const original = await readFile(files.certFile, "utf8");
    const records = new Map<string, string>();
    const authority = await localAcmeAuthority(directory, hostname, records);
    const marker =
      mode === "activation-held"
        ? Object.assign(new Error("fixture activation cleanup uncertain"), {
            cleanupFailure: undefined,
          })
        : new Error("ordinary fixture activation failure");
    const rollbackMarker = Object.assign(new Error("fixture rollback publication uncertain"), {
      cleanupFailure: undefined,
    });
    const write = core.atomicWriteFile;
    const publication = vi.spyOn(core, "atomicWriteFile").mockImplementation(async (...args) => {
      if (mode === "rollback-held" && args[0] === files.certFile && args[1] === original)
        throw rollbackMarker;
      return write(...args);
    });
    let renewed: string | undefined;
    const activate = vi.fn(async () => {}).mockRejectedValueOnce(marker);
    const afterActivation = vi.fn(async () => {});
    const renewal = new GatewayAcmeRenewal({
      directoryUrl: authority.directoryUrl,
      publicOrigin: `https://${hostname}`,
      certificateFile: files.certFile,
      privateKeyFile: files.keyFile,
      accountKeyFile: join(directory, "account.key"),
      trustedRoots: [authority.root],
      presenter: {
        create: async (value) => {
          records.set("lease", value);
          return { id: "lease" };
        },
        remove: async (id) => {
          records.delete(id);
        },
      },
      issuer: async (options) => {
        renewed = await issueAcmeCertificate({
          ...options,
          lookup: async (_hostname, value) => [...records.values()].includes(value),
        });
        return renewed;
      },
      activate,
      afterActivation,
    });
    try {
      const result = renewal.renew(new AbortController().signal);
      if (mode === "rollback-held") {
        const failure: unknown = await result.catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([marker, rollbackMarker]);
        expect(core.ownedProcessCleanupReceipt(failure)).toEqual({
          failure: undefined,
          pending: false,
        });
      } else await expect(result).rejects.toBe(marker);
      expect(renewed).not.toBe(original);
      expect(await readFile(files.certFile, "utf8")).toBe(uncertain ? renewed : original);
      expect(publication.mock.calls.filter(([path]) => path === files.certFile)).toHaveLength(
        mode === "activation-held" ? 1 : 2,
      );
      expect(activate).toHaveBeenCalledTimes(mode === "joined" ? 2 : 1);
      expect(afterActivation).not.toHaveBeenCalled();
      if (uncertain) {
        await expect(
          core.acquireGatewayLock(join(directory, ".acme-renewal"), { waitMs: 0 }),
        ).rejects.toThrow();
        await expect(renewal.close()).rejects.toBe(renewal.cleanupFailure());
      } else {
        const other = await core.acquireGatewayLock(join(directory, ".acme-renewal"), {
          waitMs: 0,
        });
        other.release();
        await expect(renewal.close()).resolves.toBeUndefined();
      }
    } finally {
      await authority.close();
    }
  },
  60_000,
);

test("close after a public-certificate lookup prevents a new private-key command", async () => {
  const files = tlsFiles(directory, "gateway.example.test");
  const filesystem = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.doMock("node:fs/promises", () => ({
    ...filesystem,
    readFile: async (...args: Parameters<typeof filesystem.readFile>) => {
      if (args[0] === files.certFile) {
        entered();
        await gate;
      }
      return filesystem.readFile(...args);
    },
  }));
  vi.resetModules();
  const inputs = await import("./private-inputs.js");
  const read = vi
    .spyOn(inputs, "readPrivateText")
    .mockRejectedValue(new Error("No private key command is expected"));
  const { GatewayAcmeRenewal: FreshRenewal } = await import("./acme-gateway.js");
  const issuer = vi.fn(async () => "unused");
  const renewal = new FreshRenewal({
    directoryUrl: "https://ca.example.test/directory",
    publicOrigin: "https://gateway.example.test",
    certificateFile: files.certFile,
    privateKeyFile: files.keyFile,
    accountKeyFile: join(directory, "account.key"),
    presenter: { create: async () => ({ id: "unused" }), remove: async () => {} },
    activate: async () => {},
    issuer,
  });
  try {
    const running = renewal.renew(new AbortController().signal);
    const refused = expect(running).rejects.toThrow();
    await started;
    const close = renewal.close();
    release();
    await refused;
    await close;
    expect(read).not.toHaveBeenCalled();
    expect(issuer).not.toHaveBeenCalled();
  } finally {
    release();
    await renewal.close().catch(() => {});
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
});
