// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import {
  mkdtemp,
  realpath,
  rm,
  chmod,
  readFile,
  mkdir,
  open,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ownedProcessCleanupReceipt, spawnOwnedChildProcess } from "@omnesis/core";
import { createNativeCompositionWorld } from "./native-composition-world.js";
import { issueAcmeCertificate } from "../../packages/cloud-relay/src/acme-client.js";
import {
  joinCompositionSmokeProcess,
  qualifyNativeCompositionServices,
  probeCompositionServices,
  smokeNativeCompositionServices,
} from "./native-composition-smoke.mjs";

test.skipIf(process.platform === "win32")(
  "services-only probes exercise actual relay TLS, scripted HTTP and signed ACME without account inference",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-service-smoke-")));
    await chmod(root, 0o700);
    const controller = new AbortController();
    let world;
    let retain = false;
    try {
      world = await createNativeCompositionWorld(root, controller.signal);
      await expect(
        probeCompositionServices(world, issueAcmeCertificate, AbortSignal.timeout(15000)),
      ).resolves.toEqual({
        format: 1,
        scope: "services-only",
        relayTls: "passed",
        scriptedModel: "passed",
        acmeDnsCertificate: "passed",
      });
      expect(world.evidence.acmeRequests).toContain("/finalize");
      expect(world.evidence.scriptedRequests()).toBe(1);
      await world.close();
    } catch (error) {
      retain = ownedProcessCleanupReceipt(error) !== undefined;
      throw error;
    } finally {
      controller.abort();
      // An unconfirmed close must retain evidence rather than deleting beneath live services.
      await world?.close();
      if (!retain) await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

test("real smoke entry refuses a checkout Node before starting any service", async () => {
  await expect(
    smokeNativeCompositionServices(process.cwd(), "/not-created-by-smoke"),
  ).rejects.toThrow(process.platform === "win32" ? "POSIX ownership" : "copied runtime Node");
});

test.skipIf(process.platform === "win32").each(["deadline", "output"])(
  "forced %s stop physically joins only its owned child and retains conservative metadata",
  async (reason) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-service-owner-")));
    const receipt = join(root, "failure.json");
    const owner = spawnOwnedChildProcess(
      process.execPath,
      [
        "-e",
        reason === "output"
          ? "process.stdout.write(Buffer.alloc(65537)); setInterval(()=>{},1000)"
          : "setInterval(()=>{},1000)",
      ],
      { env: { ...process.env } },
    );
    try {
      await expect(
        joinCompositionSmokeProcess(owner, receipt, reason === "deadline" ? 50 : 3000),
      ).rejects.toMatchObject({ cleanupFailure: "qa-service-forced-stop" });
      expect(owner.joinedConfirmed).toBe(true);
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
        format: 1,
        scope: "services-only",
        reason,
        rootJoined: true,
        normalServiceClosure: "unverified",
      });
      if (reason === "output")
        expect(JSON.parse(await readFile(receipt, "utf8")).outputBytes).toBe(65537);
    } finally {
      await owner.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preparation refusal records bounded input metadata before any services start",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-prepare-failure-")));
    await chmod(root, 0o700);
    const runtime = join(root, "runtime");
    const artifact = join(root, "evidence/services");
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(join(root, "evidence"), { mode: 0o700 });
    const handle = await open(join(runtime, "desktop-runtime.json"), "wx", 0o600);
    try {
      await handle.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    try {
      await expect(
        qualifyNativeCompositionServices({
          runtime,
          artifact,
          architecture: "arm64",
          version: "0.8.1",
          work: join(root, "work"),
          env: {},
        }),
      ).rejects.toThrow("Invalid QA service input");
      const path = join(root, "evidence/services-smoke-failure.json");
      const receipt = JSON.parse(await readFile(path, "utf8"));
      expect(receipt).toEqual({
        format: 1,
        scope: "services-only",
        phase: "preparation",
        servicesStarted: false,
        reason: "preparation-failure",
        validation: {
          reason: "oversize",
          type: "regular",
          linkCount: 1,
          byteCount: 32 * 1024 * 1024 + 1,
          readBound: 32 * 1024 * 1024,
        },
      });
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(receipt)).not.toContain(root);
      await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(root, "evidence/qualification.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "unknown preparation errors never serialize secrets and receipt refusal preserves both causes (%s)",
  async (existingReceipt) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-prepare-unknown-")));
    await chmod(root, 0o700);
    const runtime = join(root, "runtime");
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(join(root, "evidence"), { mode: 0o700 });
    const secret = "invented-secret-value";
    await writeFile(join(runtime, "desktop-runtime.json"), secret, { mode: 0o600 });
    const receipt = join(root, "evidence/services-smoke-failure.json");
    if (existingReceipt) await writeFile(receipt, "original receipt", { mode: 0o600 });
    try {
      const error = await qualifyNativeCompositionServices({
        runtime,
        artifact: join(root, "evidence/services"),
        architecture: "arm64",
        version: "0.8.1",
        work: join(root, "work"),
        env: {},
      }).catch((error) => error);
      if (existingReceipt) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.cause).toBe(error.errors[0]);
        expect(error.errors[0]).toBeInstanceOf(SyntaxError);
        expect(error.errors[1]).toMatchObject({ code: "EEXIST" });
        expect(error.cleanupFailure).toBe("qa-service-evidence");
        expect(await readFile(receipt, "utf8")).toBe("original receipt");
      } else {
        expect(error).toBeInstanceOf(SyntaxError);
        const bytes = await readFile(receipt, "utf8");
        expect(bytes).not.toContain(secret);
        expect(bytes).not.toContain(root);
        expect(JSON.parse(bytes)).toEqual({
          format: 1,
          scope: "services-only",
          phase: "preparation",
          servicesStarted: false,
          reason: "preparation-failure",
          validation: null,
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
