// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
  createPortalFleetUpdateOperation,
  portalFleetUpdateOperationPath,
  portalFleetUpdateOutputTail,
  readPortalFleetUpdateOperation,
  updatePortalFleetUpdateOperation,
  writePortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
} from "./portal-fleet-update.js";

const ID = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
const STARTED = "2026-09-16T12:00:00.000Z";

function queued(): PortalFleetUpdateOperation {
  return {
    id: ID,
    currentVersion: "1.2.2",
    targetVersion: "1.2.3",
    releaseCheckedAt: "2026-09-16T11:59:00.000Z",
    state: "queued",
    startedAt: STARTED,
    updatedAt: STARTED,
  };
}

describe("portal fleet update operation state", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-fleet-update-"));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  test("atomically persists and updates an owner-only record", () => {
    expect(readPortalFleetUpdateOperation(configDir)).toBeNull();
    expect(writePortalFleetUpdateOperation(configDir, queued())).toEqual(queued());
    expect(statSync(portalFleetUpdateOperationPath(configDir)).mode & 0o777).toBe(0o600);

    const completedAt = "2026-09-16T12:01:00.000Z";
    const updated = updatePortalFleetUpdateOperation(configDir, (current) => ({
      ...current,
      state: "succeeded",
      updatedAt: completedAt,
      completedAt,
      detail: "Fleet update completed.",
    }));

    expect(updated.state).toBe("succeeded");
    expect(readPortalFleetUpdateOperation(configDir)).toEqual(updated);
    expect(readFileSync(portalFleetUpdateOperationPath(configDir), "utf8").endsWith("\n")).toBe(
      true,
    );
  });

  test("strictly rejects unknown fields, malformed ids, unstable targets, and invalid terminal shape", () => {
    const path = portalFleetUpdateOperationPath(configDir);
    const invalid = [
      { ...queued(), unexpected: true },
      { ...queued(), id: "not-a-uuid" },
      { ...queued(), currentVersion: "1.2.2-beta.1" },
      { ...queued(), targetVersion: "1.2.3-beta.1" },
      { ...queued(), targetVersion: "1.2.1" },
      { ...queued(), releaseCheckedAt: "yesterday" },
      { ...queued(), state: "succeeded" },
      { ...queued(), completedAt: STARTED },
    ];

    for (const operation of invalid) {
      writeFileSync(path, JSON.stringify(operation));
      expect(() => readPortalFleetUpdateOperation(configDir)).toThrow();
    }
  });

  test("rejects oversized records while exposing a UTF-8-safe bounded tail", () => {
    const output = `${"x".repeat(PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES)}é-tail`;
    const tail = portalFleetUpdateOutputTail(output);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(
      PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
    );
    expect(tail.endsWith("é-tail")).toBe(true);
    expect(tail).not.toContain("�");

    expect(() => writePortalFleetUpdateOperation(configDir, { ...queued(), output })).toThrow(
      /output exceeds/u,
    );
    expect(writePortalFleetUpdateOperation(configDir, { ...queued(), output: tail }).output).toBe(
      tail,
    );
  });

  test("surfaces malformed JSON and non-ENOENT read failures", () => {
    writeFileSync(portalFleetUpdateOperationPath(configDir), "{");
    expect(() => readPortalFleetUpdateOperation(configDir)).toThrow();
    expect(() =>
      updatePortalFleetUpdateOperation(join(configDir, "absent"), (value) => value),
    ).toThrow(/does not exist/u);
  });

  test("does not let a state transition change the release plan identity", () => {
    writePortalFleetUpdateOperation(configDir, queued());
    expect(() =>
      updatePortalFleetUpdateOperation(configDir, (current) => ({
        ...current,
        targetVersion: "1.2.4",
      })),
    ).toThrow(/targetVersion is immutable/u);
    expect(readPortalFleetUpdateOperation(configDir)).toEqual(queued());
  });

  test("serializes read-modify-write transitions across operation owners", () => {
    writePortalFleetUpdateOperation(configDir, queued());
    expect(() =>
      updatePortalFleetUpdateOperation(configDir, (current) => {
        expect(() =>
          updatePortalFleetUpdateOperation(configDir, (nested) => ({
            ...nested,
            state: "running",
            updatedAt: "2026-09-16T12:00:01.000Z",
          })),
        ).toThrow(/portal fleet update operation/u);
        return {
          ...current,
          state: "failed",
          updatedAt: "2026-09-16T12:00:02.000Z",
          completedAt: "2026-09-16T12:00:02.000Z",
        };
      }),
    ).not.toThrow();
    expect(readPortalFleetUpdateOperation(configDir)?.state).toBe("failed");
  });

  test("creates at most one active operation across the operation lock", () => {
    const first = createPortalFleetUpdateOperation(configDir, queued());
    const competing = {
      ...queued(),
      id: "123e4567-e89b-42d3-a456-426614174000",
      targetVersion: "1.2.4",
    };
    const second = createPortalFleetUpdateOperation(configDir, competing);

    expect(first).toEqual({ operation: queued(), created: true });
    expect(second).toEqual({ operation: queued(), created: false });
    expect(readPortalFleetUpdateOperation(configDir)).toEqual(queued());
  });

  test("allows a fleet retry when the gateway already serves the exact target", () => {
    const retry = { ...queued(), currentVersion: "1.2.3" };
    expect(writePortalFleetUpdateOperation(configDir, retry)).toEqual(retry);
  });
});
