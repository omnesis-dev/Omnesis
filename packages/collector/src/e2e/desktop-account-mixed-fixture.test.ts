// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { protectedSourceGateway } from "./desktop-account-mixed-fixture.js";

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
