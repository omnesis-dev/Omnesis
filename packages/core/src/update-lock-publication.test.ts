// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomic-write.js")>();
  return { ...actual, atomicWriteFileSync: vi.fn(actual.atomicWriteFileSync) };
});
import { atomicWriteFileSync } from "./atomic-write.js";
import { claimGuard, releaseGuard } from "./update-lock-guard.js";
import { acquireUpdateLock, adoptUpdateLock, type UpdateLock } from "./update-lock.js";
import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";

let directory: string;
let handles: UpdateLock[];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("./atomic-write.js")>("./atomic-write.js");
  vi.mocked(atomicWriteFileSync).mockReset().mockImplementation(actual.atomicWriteFileSync);
  directory = mkdtempSync(join(tmpdir(), "update-publication-refusal-"));
  handles = [];
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import("./atomic-write.js")>("./atomic-write.js");
  vi.mocked(atomicWriteFileSync).mockImplementation(actual.atomicWriteFileSync);
  // Faults substitute the publisher itself: no helper is left using this fixture.
  for (const handle of handles) {
    try {
      handle.release();
    } catch (error) {
      if (!ownedProcessCleanupReceipt(error)) throw error;
    }
  }
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
function acquire(): UpdateLock {
  const handle = acquireUpdateLock(directory, { owner: "invented updater" });
  handles.push(handle);
  return handle;
}
function thrownBy(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("Expected publication refusal");
}
function claims(): string[] {
  return readdirSync(join(directory, "update.lock")).filter((name) => name.startsWith(".claim-"));
}
function refuse(target: "claim" | "owner", failure: Error): void {
  const write = vi.mocked(atomicWriteFileSync).getMockImplementation()!;
  vi.mocked(atomicWriteFileSync).mockImplementation((path, data, options) => {
    const selected =
      target === "claim" ? basename(path).startsWith(".claim-") : basename(path) === "owner.json";
    if (selected) throw failure;
    write(path, data, options);
  });
}

for (const wrapped of [false, true]) {
  describe(
    wrapped ? "nested native publication uncertainty" : "direct native publication uncertainty",
    () => {
      for (const cleanupFailure of [undefined, new Error("Invented join refusal")]) {
        const marker = Object.assign(new Error("Invented native publisher"), {
          cleanupFailure,
          code: "EEXIST",
        });
        const failure = wrapped ? new Error("Publisher wrapper", { cause: marker }) : marker;
        test(`retains the initial owner directory (${String(cleanupFailure)})`, () => {
          refuse("owner", failure);
          expect(thrownBy(acquire)).toBe(failure);
          expect(claims()).toHaveLength(1);
          const count = vi.mocked(atomicWriteFileSync).mock.calls.length;
          expect(
            thrownBy(() =>
              acquireUpdateLock(directory, {
                owner: "invented replacement",
                staleMs: 0,
                now: () => new Date(Date.now() + 60_000),
              }),
            ),
          ).toBe(failure);
          expect(vi.mocked(atomicWriteFileSync).mock.calls).toHaveLength(count);
          expect(claims()).toHaveLength(1);
        });
        test(`retains the choosing claim and original error (${String(cleanupFailure)})`, () => {
          const holder = acquire();
          const before = readFileSync(join(directory, "update.lock", "owner.json"), "utf8");
          refuse("claim", failure);
          expect(thrownBy(() => holder.setStep("unconfirmed claim"))).toBe(failure);
          expect(claims()).toHaveLength(1);
          expect(readFileSync(join(directory, "update.lock", "owner.json"), "utf8")).toBe(before);
          expect(thrownBy(() => holder.setStep("retry"))).toBe(failure);
        });
        for (const operation of ["step", "group", "adopt", "handBack", "reclaim"] as const) {
          test(`fences ${operation} after an unjoined owner write (${String(cleanupFailure)})`, () => {
            const original = acquire();
            let holder = original;
            if (operation === "handBack" || operation === "reclaim") {
              holder = adoptUpdateLock(directory, original.id, { owner: "invented continuation" });
              handles.push(holder);
            }
            const ownerPath = join(directory, "update.lock", "owner.json");
            if (operation === "reclaim") {
              const record = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
              record.pid = 2_147_483_647;
              record.processStart = null;
              writeFileSync(ownerPath, JSON.stringify(record));
            }
            const before = readFileSync(ownerPath, "utf8");
            refuse("owner", failure);
            const run = () => {
              if (operation === "step") return holder.setStep("unconfirmed step");
              if (operation === "group") return holder.setProcessGroup(process.pid);
              if (operation === "adopt")
                return adoptUpdateLock(directory, holder.id, { owner: "invented adopter" });
              if (operation === "handBack") return holder.handBack();
              return original.reclaim();
            };
            expect(thrownBy(run)).toBe(failure);
            expect(claims()).toHaveLength(1);
            expect(readFileSync(ownerPath, "utf8")).toBe(before);
            const count = vi.mocked(atomicWriteFileSync).mock.calls.length;
            expect(thrownBy(() => claimGuard(join(directory, "update.lock")))).toBe(failure);
            expect(thrownBy(() => original.setStep("retry"))).toBe(failure);
            expect(vi.mocked(atomicWriteFileSync).mock.calls).toHaveLength(count);
            expect(claims()).toHaveLength(1);
          });
        }
      }
    },
  );
}

test("joined owner refusal releases the claim and the next explicit step can succeed", async () => {
  const holder = acquire();
  const failure = Object.assign(new Error("Invented joined write refusal"), { code: "EACCES" });
  refuse("owner", failure);
  expect(thrownBy(() => holder.setStep("refused"))).toBe(failure);
  expect(claims()).toHaveLength(0);
  const actual = await vi.importActual<typeof import("./atomic-write.js")>("./atomic-write.js");
  vi.mocked(atomicWriteFileSync).mockImplementation(actual.atomicWriteFileSync);
  holder.setStep("joined retry");
  expect(
    JSON.parse(readFileSync(join(directory, "update.lock", "owner.json"), "utf8")),
  ).toHaveProperty("currentStep", "joined retry");
});

test("joined claim refusal is an ordinary busy result and leaves no claim", () => {
  acquire();
  refuse("claim", new Error("Invented joined claim refusal"));
  expect(claimGuard(join(directory, "update.lock"))).toBeNull();
  expect(claims()).toHaveLength(0);
});

test("joined initial owner refusal retires its own directory", () => {
  refuse("owner", Object.assign(new Error("Invented joined initial refusal"), { code: "EACCES" }));
  expect(thrownBy(acquire)).toHaveProperty("code", "EACCES");
  expect(existsSync(join(directory, "update.lock"))).toBe(false);
});

test("ordinary guard release removes only its own claim", () => {
  acquire();
  const claim = claimGuard(join(directory, "update.lock"))!;
  expect(claims()).toHaveLength(1);
  releaseGuard(claim);
  expect(claims()).toHaveLength(0);
});

test("an uncertain heartbeat stops retrying and unregisters its exit handler", () => {
  vi.useFakeTimers();
  const listeners = process.listenerCount("exit");
  const holder = acquire();
  const failure = Object.assign(new Error("Invented heartbeat publication refusal"), {
    cleanupFailure: undefined,
  });
  refuse("owner", failure);
  vi.advanceTimersByTime(5_000);
  const calls = vi.mocked(atomicWriteFileSync).mock.calls.length;
  vi.advanceTimersByTime(60_000);
  expect(vi.mocked(atomicWriteFileSync).mock.calls).toHaveLength(calls);
  expect(process.listenerCount("exit")).toBe(listeners);
  expect(claims()).toHaveLength(1);
  expect(thrownBy(() => holder.setStep("retry"))).toBe(failure);
});
