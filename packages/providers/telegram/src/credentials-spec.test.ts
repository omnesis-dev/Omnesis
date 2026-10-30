// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { MissingCredentialsError, writeProviderCredentials } from "@omnesis/core";
import { loadAppCredentials, telegramCredentialsSpec } from "./credentials-spec.js";
import { APP_CREDENTIALS, tempConfigDir } from "./testing/fixtures.js";

function field(name: string) {
  const f = telegramCredentialsSpec.fields.find((candidate) => candidate.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

describe("telegramCredentialsSpec", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("is one required app credential shared by every account", () => {
    expect(telegramCredentialsSpec.fileKey).toBe("telegram");
    expect(telegramCredentialsSpec.required).toBe(true);
    expect(telegramCredentialsSpec.perAccount).toBeUndefined();
  });

  it("accepts a numeric api_id and a 32-character hex api_hash, and nothing else", () => {
    const apiId = new RegExp(field("api_id").pattern!, "u");
    const apiHash = new RegExp(field("api_hash").pattern!, "u");
    expect(apiId.test("1234567")).toBe(true);
    expect(apiId.test("12a4")).toBe(false);
    expect(apiHash.test(APP_CREDENTIALS.api_hash)).toBe(true);
    expect(apiHash.test("0123456789ABCDEF0123456789ABCDEF")).toBe(false);
    expect(apiHash.test("0123")).toBe(false);
    expect(field("api_hash").secret).toBe(true);
    expect(field("api_id").secret).toBeFalsy();
  });

  it("carries a wizard that walks through my.telegram.org", () => {
    const wizard = telegramCredentialsSpec.wizard!;
    expect(wizard.intro).toMatch(/Telegram API/u);
    expect(wizard.why.length).toBeGreaterThan(0);
    expect(wizard.estMinutes).toBe(5);
    expect(wizard.steps.length).toBeGreaterThanOrEqual(4);
    // The wizard opens on Telegram's terms, linked rather than restated.
    expect(wizard.steps[0]).toMatchObject({ kind: "open-url", url: "https://telegram.org/tos" });
    expect(wizard.steps[0]!.body).toContain("https://core.telegram.org/api/terms");
    expect(wizard.steps[1]).toMatchObject({
      kind: "open-url",
      url: "https://my.telegram.org/apps",
    });
    for (const step of wizard.steps) expect(step.body.length).toBeGreaterThan(0);
  });

  it("loads a stored credential and refuses a malformed one as missing", async () => {
    const dir = tempConfigDir("creds");
    dirs.push(dir);
    await expect(loadAppCredentials(dir)).rejects.toBeInstanceOf(MissingCredentialsError);
    await writeProviderCredentials("telegram", APP_CREDENTIALS, dir);
    await expect(loadAppCredentials(dir)).resolves.toEqual({
      apiId: 1234567,
      apiHash: APP_CREDENTIALS.api_hash,
    });
    await writeProviderCredentials("telegram", { api_id: "abc", api_hash: "zz" }, dir);
    await expect(loadAppCredentials(dir)).rejects.toBeInstanceOf(MissingCredentialsError);
  });
});
