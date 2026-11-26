// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  desktopAccountFailureCode,
  desktopAccountProgress,
  protectedSourceGateway,
} from "./desktop-account-mixed-fixture.js";

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
});
