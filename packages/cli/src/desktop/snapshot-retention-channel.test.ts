// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { desktopProfile } from "./environment.js";
import { runDesktopSnapshotCleanupHost } from "./snapshot-retention-channel.js";
import type { DesktopSnapshotGcRequest } from "./snapshot-retention-request.js";
const profile = desktopProfile("/tmp/omnesis-gc-channel-fixture");
function fixture(reply: unknown) {
  const operationId = randomUUID(),
    snapshotId = randomUUID();
  const request: DesktopSnapshotGcRequest = {
    version: 1,
    profile,
    snapshotId,
    expectedBinding: "a".repeat(64),
  };
  const response =
    typeof reply === "function"
      ? (reply as (id: string, snapshot: string) => unknown)(operationId, snapshotId)
      : reply;
  const program = `let data=Buffer.alloc(0);process.stdin.on('data',block=>{data=Buffer.concat([data,block]);if(data.length>=4&&data.length>=data.readUInt32BE(0)+4){process.stdout.write(${JSON.stringify(JSON.stringify(response))},()=>process.exit(0));}});`;
  return {
    operationId,
    snapshotId,
    request,
    dependencies: {
      invocation: (path: string, _meta: string, scope?: typeof profile) => {
        expect(path).toBe("./snapshot-retention-host.ts");
        expect(scope).toEqual(profile);
        return { command: process.execPath, args: ["-e", program, "--"] };
      },
    },
  };
}
test("the GC wrapper accepts only its own typed completed operation result", async () => {
  const f = fixture((operationId: string, snapshotId: string) => ({
    version: 1,
    ok: true,
    result: { status: "removed", operationId, snapshotId, bytes: 123 },
  }));
  expect(
    await runDesktopSnapshotCleanupHost(
      f.operationId,
      f.request,
      new AbortController().signal,
      f.dependencies,
    ),
  ).toEqual({
    status: "removed",
    operationId: f.operationId,
    snapshotId: f.snapshotId,
    bytes: 123,
  });
});
test.each(["wrong-operation", "wrong-copy", "extra-path", "unmeasured"])(
  "GC output %s cannot claim a removed copy",
  async (kind) => {
    const f = fixture((operationId: string, snapshotId: string) => ({
      version: 1,
      ok: true,
      result: {
        status: "removed",
        operationId: kind === "wrong-operation" ? randomUUID() : operationId,
        snapshotId: kind === "wrong-copy" ? randomUUID() : snapshotId,
        bytes: kind === "unmeasured" ? "unknown" : 123,
        ...(kind === "extra-path" ? { path: "invented-private-value" } : {}),
      },
    }));
    await expect(
      runDesktopSnapshotCleanupHost(
        f.operationId,
        f.request,
        new AbortController().signal,
        f.dependencies,
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_CLEANUP_REFUSED" });
  },
);
test("native failure values never replace the fixed safe guidance", async () => {
  const f = fixture({
    version: 1,
    ok: false,
    error: { code: "RECOVERY_CLEANUP_PENDING", message: "invented-private-value" },
  });
  const error: unknown = await runDesktopSnapshotCleanupHost(
    f.operationId,
    f.request,
    new AbortController().signal,
    f.dependencies,
  ).catch((failure: unknown) => failure);
  expect(error).toMatchObject({
    code: "RECOVERY_CLEANUP_PENDING",
    message: expect.stringContaining("pending"),
  });
  expect(String(error)).not.toContain("invented-private-value");
});
