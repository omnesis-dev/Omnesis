// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  desktopAccountFailureCode,
  desktopAccountProgress,
  protectedSourceGateway,
} from "./desktop-account-mixed-fixture.js";
import {
  createDesktopPrepareProgress,
  desktopPrepareProgress,
  desktopPrepareFailureCategory,
  desktopPrepareStages,
  readDesktopPrepareProgress,
} from "./desktop-account-bridge.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(value: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-mixed-credential-")));
  roots.push(root);
  const configDir = join(root, "config");
  const script = vi.fn(async (_program: string) => JSON.stringify(value));
  const reader = protectedSourceGateway({ root, environment: {}, script });
  await reader.prepareGateway({ getGatewayConfigDirectory: () => configDir });
  return { reader, configDir, script };
}

test.each([
  ["fictional-source-token\n", "fictional-source-token"],
  ["  fictional-source-token\r\n", "fictional-source-token"],
  [" \r\n", null],
  [null, null],
])(
  "the protected fixture reader normalizes token-file whitespace (%j)",
  async (value, expected) => {
    const { reader, configDir } = await fixture(value);
    expect(await reader.readGatewayToken(configDir)).toBe(expected);
  },
);

test.each([0, false, {}, []])("non-string credential metadata fails closed (%j)", async (value) => {
  const { reader, configDir } = await fixture(value);
  await expect(reader.readGatewayToken(configDir)).rejects.toThrow("invalid metadata");
});

test("the token reader refuses another gateway's directory before any credential command", async () => {
  const { reader, configDir, script } = await fixture("fictional-source-token");
  script.mockClear();
  await expect(reader.readGatewayToken(join(configDir, "other"))).rejects.toThrow(
    "directory changed",
  );
  expect(script).not.toHaveBeenCalled();
});

test("account diagnostics retain only reviewed finite state and error codes", () => {
  expect(
    desktopAccountProgress({
      account: { linked: false },
      connect: { state: "failed", step: "certificate", error: "enrollment-refused" },
      enrollment: { state: "failed", error: "certificate-setup-failed" },
      tunnel: { state: "offline" },
      certificate: { state: "failed", lastError: "certificate-setup-failed" },
    }),
  ).toEqual({
    linked: false,
    connect: "failed",
    step: "certificate",
    connectError: "enrollment-refused",
    enrollment: "failed",
    enrollmentError: "certificate-setup-failed",
    tunnel: "offline",
    tunnelError: "none",
    certificate: "failed",
    certificateError: "certificate-setup-failed",
  });
  expect(
    desktopAccountFailureCode(
      "Your account could not connect. Check your internet connection and try again.",
    ),
  ).toBe("account-connect-failed");
});

test("current and legacy coordinator messages retain the same content-free diagnostic code", () => {
  for (const message of [
    "Omnesis could not finish this step. Unlock your Mac and try again.",
    "Omnesis could not finish this step. Try again to check the current status.",
  ]) {
    expect(desktopAccountFailureCode(message)).toBe("coordinator-step-failed");
  }
});

test("unknown account diagnostics never serialize invented private strings", () => {
  const secret = "invented-private-account-diagnostic-sentinel";
  const progress = desktopAccountProgress({
    account: { linked: secret, name: secret },
    connect: { state: secret, step: secret, error: secret, authorizeUrl: secret, code: secret },
    enrollment: { state: secret, error: secret },
    tunnel: { state: secret, lastError: secret },
    certificate: { state: secret, lastError: secret, expiresAt: secret },
    token: secret,
    cause: secret,
    invite: secret,
  });
  expect(Object.values(progress).every((value) => value === "unknown" || value === null)).toBe(
    true,
  );
  expect(JSON.stringify({ failure: desktopAccountFailureCode(secret), progress })).not.toContain(
    secret,
  );
  expect(desktopAccountFailureCode(secret)).toBe("unknown");
  const extended = `Omnesis could not finish this step. Try again to check the current status. ${secret}`;
  expect(desktopAccountFailureCode(extended)).toBe("unknown");
  expect(JSON.stringify({ failure: desktopAccountFailureCode(extended) })).not.toContain(secret);
});

function prepareRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-prepare-progress-")));
  roots.push(root);
  return root;
}

test.skipIf(process.platform === "win32")(
  "prepare observations activate once, serialize bounded private files and do not rewrite duplicates",
  async () => {
    const root = prepareRoot(),
      path = join(root, "prepare-progress.json");
    const journal = createDesktopPrepareProgress(root);
    await journal.record("install-entered");
    expect(existsSync(path)).toBe(false);
    expect(await readDesktopPrepareProgress(root)).toEqual({ stage: "unknown", seen: [] });
    await journal.begin();
    await Promise.all(desktopPrepareStages.map((stage) => journal.record(stage)));
    const info = lstatSync(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.nlink).toBe(1);
    expect(info.size).toBeLessThanOrEqual(1024);
    expect(await readDesktopPrepareProgress(root)).toEqual({
      stage: "coordinator-close-returned",
      seen: [...desktopPrepareStages],
      firstHealthFailure: "other",
    });
    const before = readFileSync(path);
    await journal.record("coordinator-close-returned");
    await journal.begin();
    const after = lstatSync(path);
    expect([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]).toEqual([
      info.dev,
      info.ino,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    expect(readFileSync(path)).toEqual(before);
  },
);

test("prepare projection never serializes unknown, malformed or secret values", () => {
  const secret = "invented-private-prepare-observation-sentinel";
  for (const value of [
    null,
    {},
    { format: true, stage: "handle-entered", seen: ["handle-entered"] },
    { format: 1, stage: secret, seen: [secret] },
    { format: 1, stage: "handle-entered", seen: ["handle-entered"], cause: secret },
    { format: 1, stage: "handle-entered", seen: ["handle-entered", "handle-entered"] },
    { format: 1, stage: "handle-entered", seen: Array(30).fill("handle-entered") },
    { format: 1, stage: "handle-entered", seen: [] },
    { format: 1, stage: "daemon-entered", seen: ["handle-entered"] },
  ]) {
    const safe = desktopPrepareProgress(value);
    expect(safe).toEqual({ stage: "unknown", seen: [] });
    expect(JSON.stringify(safe)).not.toContain(secret);
  }
});

test.each([
  [{ code: "ECONNREFUSED" }, "refused"],
  [{ code: "ETIMEDOUT" }, "timeout"],
  [{ code: "ABORT_ERR" }, "other"],
  [{ code: "ENOTFOUND" }, "dns"],
  [{ code: "CERT_HAS_EXPIRED" }, "certificate"],
  [{ status: 401 }, "auth"],
  [{ statusCode: 403 }, "auth"],
  [{ code: "invented-private-prepare-observation-sentinel" }, "other"],
  [
    { cause: { code: "ECONNREFUSED" }, message: "invented-private-prepare-observation-sentinel" },
    "other",
  ],
])(
  "prepare failure categories observe only direct allowlisted code/status (%j)",
  (error, expected) => {
    expect(desktopPrepareFailureCategory(error)).toBe(expected);
  },
);

test.skipIf(process.platform === "win32")(
  "only the first observed health failure category reaches the private journal",
  async () => {
    const root = prepareRoot(),
      journal = createDesktopPrepareProgress(root);
    await journal.begin();
    const secret = "invented-private-prepare-observation-sentinel";
    const failure = Object.assign(new Error(secret), {
      code: "ECONNREFUSED",
      cause: { token: secret },
    });
    await journal.record("first-health-entered");
    await journal.record("first-health-failed", failure);
    await journal.record("first-health-failed", { code: "CERT_HAS_EXPIRED" });
    expect(await readDesktopPrepareProgress(root)).toEqual({
      stage: "first-health-failed",
      seen: ["handle-entered", "first-health-entered", "first-health-failed"],
      firstHealthFailure: "refused",
    });
    expect(readFileSync(join(root, "prepare-progress.json"), "utf8")).not.toContain(secret);
    expect(
      desktopPrepareProgress({
        format: 1,
        stage: "first-health-failed",
        seen: ["handle-entered", "first-health-failed"],
        firstHealthFailure: secret,
      }),
    ).toEqual({
      stage: "first-health-failed",
      seen: ["handle-entered", "first-health-failed"],
      firstHealthFailure: "other",
    });
  },
);

test.skipIf(process.platform === "win32")(
  "actual prepare journals reject unknown stages and malformed files without losing known observations",
  async () => {
    const root = prepareRoot(),
      path = join(root, "prepare-progress.json");
    const journal = createDesktopPrepareProgress(root);
    await journal.begin();
    const secret = "invented-private-prepare-observation-sentinel";
    await expect(journal.record(secret)).rejects.toThrow("Unknown prepare journal stage");
    expect(readFileSync(path, "utf8")).not.toContain(secret);
    expect(await readDesktopPrepareProgress(root)).toEqual({
      stage: "handle-entered",
      seen: ["handle-entered"],
    });
    for (const body of [
      "{",
      " ".repeat(1025),
      JSON.stringify({ format: 1, stage: secret, seen: [secret] }),
    ]) {
      writeFileSync(path, body, { mode: 0o600 });
      expect(await readDesktopPrepareProgress(root)).toEqual({ stage: "unknown", seen: [] });
    }
  },
);

test
  .skipIf(process.platform === "win32")
  .each(["symlink", "hardlink", "public", "oversize", "directory"])(
  "prepare journal refuses %s before reading or replacing unrelated data",
  async (kind) => {
    const root = prepareRoot(),
      path = join(root, "prepare-progress.json"),
      other = join(root, "other-fixture");
    const body = JSON.stringify({ format: 1, stage: "handle-entered", seen: ["handle-entered"] });
    writeFileSync(other, body, { mode: 0o600 });
    if (kind === "symlink") symlinkSync(other, path);
    else if (kind === "hardlink") linkSync(other, path);
    else if (kind === "directory") mkdirSync(path, { mode: 0o700 });
    else {
      writeFileSync(path, kind === "oversize" ? "x".repeat(1025) : body, { mode: 0o600 });
      if (kind === "public") chmodSync(path, 0o644);
    }
    expect(await readDesktopPrepareProgress(root)).toEqual({ stage: "unknown", seen: [] });
    await expect(createDesktopPrepareProgress(root).begin()).rejects.toThrow(
      "Unsafe prepare journal",
    );
    expect(readFileSync(other, "utf8")).toBe(body);
    if (kind === "symlink") expect(lstatSync(path).isSymbolicLink()).toBe(true);
  },
);
