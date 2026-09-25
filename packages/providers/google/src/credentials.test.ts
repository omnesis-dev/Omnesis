// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isMissingCredentialsError } from "@omnesis/core";
import { accountSelectionParams, loadClientCredentials, getCredentialsPath } from "./provider.js";
import { googleCredentialsSpec } from "./credentials-spec.js";

describe("Google loadClientCredentials", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-google-creds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws MissingCredentialsError when no file present", async () => {
    let err: unknown;
    try {
      await loadClientCredentials(dir);
    } catch (e) {
      err = e;
    }
    expect(isMissingCredentialsError(err)).toBe(true);
    expect((err as { fileKey: string }).fileKey).toBe("google");
  });

  test("reads client_id + client_secret from a flat file", async () => {
    writeFileSync(
      join(dir, "google-credentials.json"),
      JSON.stringify({ client_id: "abc", client_secret: "GOCSPX-xyz" }),
    );
    const creds = await loadClientCredentials(dir);
    expect(creds.client_id).toBe("abc");
    expect(creds.client_secret).toBe("GOCSPX-xyz");
  });

  test("unwraps Google's `installed: { ... }` envelope", async () => {
    writeFileSync(
      join(dir, "google-credentials.json"),
      JSON.stringify({ installed: { client_id: "abc", client_secret: "sec" } }),
    );
    const creds = await loadClientCredentials(dir);
    expect(creds.client_id).toBe("abc");
    expect(creds.client_secret).toBe("sec");
  });

  test("throws MissingCredentialsError when file is missing client_secret", async () => {
    writeFileSync(join(dir, "google-credentials.json"), JSON.stringify({ client_id: "abc" }));
    let err: unknown;
    try {
      await loadClientCredentials(dir);
    } catch (e) {
      err = e;
    }
    expect(isMissingCredentialsError(err)).toBe(true);
  });

  test("getCredentialsPath returns <dir>/google-credentials.json", () => {
    expect(getCredentialsPath(dir)).toBe(join(dir, "google-credentials.json"));
  });
});

describe("googleCredentialsSpec", () => {
  test("required, fileKey google, two fields", () => {
    expect(googleCredentialsSpec.required).toBe(true);
    expect(googleCredentialsSpec.fileKey).toBe("google");
    expect(googleCredentialsSpec.fields.map((f) => f.name)).toEqual(["client_id", "client_secret"]);
  });

  test("client_secret is marked secret", () => {
    const secret = googleCredentialsSpec.fields.find((f) => f.name === "client_secret");
    expect(secret?.secret).toBe(true);
  });

  test("wizard has at least 4 steps including the consent + client steps", () => {
    expect(googleCredentialsSpec.wizard.steps.length).toBeGreaterThanOrEqual(4);
    const titles = googleCredentialsSpec.wizard.steps.map((s) => s.title);
    expect(titles.some((t) => /consent/i.test(t))).toBe(true);
    expect(titles.some((t) => /client/i.test(t))).toBe(true);
  });
});

describe("Google accountSelectionParams", () => {
  test("a first-time add forces the account chooser", () => {
    // Regression: with `consent` alone and one signed-in Google session, the
    // browser silently re-authorizes that account — so adding a second mailbox
    // overwrote the first account's tokens and registered no new source.
    expect(accountSelectionParams()).toEqual({ prompt: "select_account consent" });
    expect(accountSelectionParams(undefined)).toEqual({ prompt: "select_account consent" });
  });

  test("a re-auth pins the account it is refreshing and skips the chooser", () => {
    expect(accountSelectionParams("maya.reeves@example.com")).toEqual({
      prompt: "consent",
      login_hint: "maya.reeves@example.com",
    });
  });

  test("consent is always requested, so a refresh token is always re-issued", () => {
    for (const params of [accountSelectionParams(), accountSelectionParams("a@example.com")]) {
      expect(params.prompt).toContain("consent");
    }
  });
});
