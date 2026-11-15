// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stopOwnedProbeHost } from "../lib/owned-probe-host.mjs";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owned probe host "));
  const entry = join(root, "invented child.mjs"),
    asset = join(root, "retained.txt");
  writeFileSync(entry, "process.stdout.write('ready\\n');setInterval(()=>{},1000);\n");
  writeFileSync(asset, "invented runtime asset");
  const child = spawn(process.execPath, [entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  void closed.catch(() => {});
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("error", reject);
    child.once("close", () => reject(Error("Fixture exited before readiness")));
  });
  return { root, asset, child, closed };
}
async function cleanupFixture(fx) {
  // The fixture is exactly one fixed Node program with no descendants. Its
  // synthetic receipt can fail while this actual physical close is confirmed.
  if (fx.child.exitCode === null && fx.child.signalCode === null) fx.child.kill("SIGKILL");
  await fx.closed;
  rmSync(fx.root, { recursive: true, force: true });
}

test("actual child close cannot authorize scratch retirement before the held join proof", async () => {
  const fx = await fixture();
  let release;
  const proof = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const stopping = stopOwnedProbeHost(
    fx.child,
    fx.closed.then(() => proof),
  ).then(() => {
    settled = true;
    rmSync(fx.asset);
  });
  void stopping.catch(() => {});
  try {
    await fx.closed;
    expect(fx.child.exitCode !== null || fx.child.signalCode !== null).toBe(true);
    expect(settled).toBe(false);
    expect(existsSync(fx.asset)).toBe(true);
    release();
    await stopping;
    expect(existsSync(fx.asset)).toBe(false);
  } finally {
    release();
    await stopping.catch(() => {});
    await cleanupFixture(fx);
  }
});

test.each([
  undefined,
  Object.assign(new Error("invented unjoined result"), { cleanupFailure: undefined }),
])("rejected join proof retains assets and an explicit undefined marker (%#)", async (reason) => {
  const fx = await fixture();
  let reject;
  const proof = new Promise((_resolve, failure) => {
    reject = failure;
  });
  const stopping = stopOwnedProbeHost(
    fx.child,
    fx.closed.then(() => proof),
  ).then(() => rmSync(fx.asset));
  void stopping.catch(() => {});
  try {
    await fx.closed;
    reject(reason);
    const error = await stopping.then(
      () => undefined,
      (failure) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(Object.hasOwn(error, "cleanupFailure")).toBe(true);
    expect(error.cleanupFailure).toBeUndefined();
    expect(error.cause).toBe(reason);
    expect(existsSync(fx.asset)).toBe(true);
  } finally {
    reject(reason);
    await stopping.catch(() => {});
    await cleanupFixture(fx);
  }
});

test.each(["SIGINT", "SIGKILL"])(
  "a thrown %s report still waits for the independent actual-child proof",
  async (failingSignal) => {
    const fx = await fixture();
    const originalKill = fx.child.kill.bind(fx.child),
      problem = new Error("invented signal report failure");
    fx.child.kill = (signal) => {
      if (failingSignal === "SIGKILL" && signal === "SIGINT") return true;
      const result = originalKill(signal);
      if (signal === failingSignal) throw problem;
      return result;
    };
    let release;
    const proof = new Promise((resolve) => {
      release = resolve;
    });
    let settled = false;
    const stopping = stopOwnedProbeHost(
      fx.child,
      fx.closed.then(() => proof),
      10,
    );
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await fx.closed;
      expect(settled).toBe(false);
      expect(existsSync(fx.asset)).toBe(true);
      release();
      const error = await stopping.then(
        () => undefined,
        (failure) => failure,
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(problem);
      expect(Object.hasOwn(error, "cleanupFailure")).toBe(false);
    } finally {
      release();
      fx.child.kill = originalKill;
      await stopping.catch(() => {});
      await cleanupFixture(fx);
    }
  },
);

test("an explicit marked signal failure remains terminal after a positive join", async () => {
  const fx = await fixture(),
    originalKill = fx.child.kill.bind(fx.child);
  const problem = Object.assign(new Error("invented unconfirmed signal cleanup"), {
    cleanupFailure: undefined,
  });
  fx.child.kill = (signal) => {
    originalKill(signal);
    throw problem;
  };
  try {
    const error = await stopOwnedProbeHost(fx.child, fx.closed).then(
      () => undefined,
      (error) => error,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(problem);
    expect(Object.hasOwn(error, "cleanupFailure")).toBe(true);
    expect(error.cleanupFailure).toBeUndefined();
    expect(existsSync(fx.asset)).toBe(true);
  } finally {
    fx.child.kill = originalKill;
    await cleanupFixture(fx);
  }
});
