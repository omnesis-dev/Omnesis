// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { isMissingCredentialsError } from "@omnesis/core";
import { buildAuthorizeUrl, loadClientCredentials, parseOAuthCallbackUrl } from "./provider.js";
import { stravaCredentialsSpec } from "./credentials-spec.js";

const CREDS = {
  client_id: "226848",
  client_secret: "abcdef0123456789abcdef0123456789abcdef01",
};

describe("Strava loadClientCredentials", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-strava-creds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("throws MissingCredentialsError when no file present", () => {
    let err: unknown;
    try {
      loadClientCredentials(dir);
    } catch (e) {
      err = e;
    }
    expect(isMissingCredentialsError(err)).toBe(true);
    expect((err as { fileKey: string }).fileKey).toBe("strava");
  });

  test("reads client_id + client_secret from the file", () => {
    writeFileSync(
      join(dir, "strava-credentials.json"),
      JSON.stringify({
        client_id: "12345",
        client_secret: "abcdef0123456789abcdef0123456789abcdef01",
      }),
    );
    const creds = loadClientCredentials(dir);
    expect(creds.client_id).toBe("12345");
    expect(creds.client_secret).toBe("abcdef0123456789abcdef0123456789abcdef01");
  });

  test("throws when file is missing client_secret", () => {
    writeFileSync(join(dir, "strava-credentials.json"), JSON.stringify({ client_id: "12345" }));
    let err: unknown;
    try {
      loadClientCredentials(dir);
    } catch (e) {
      err = e;
    }
    expect(isMissingCredentialsError(err)).toBe(true);
  });
});

describe("stravaCredentialsSpec", () => {
  test("required, fileKey strava, two fields", () => {
    expect(stravaCredentialsSpec.required).toBe(true);
    expect(stravaCredentialsSpec.fileKey).toBe("strava");
    expect(stravaCredentialsSpec.fields.map((f) => f.name)).toEqual(["client_id", "client_secret"]);
  });

  test("client_id pattern accepts numeric strings", () => {
    const field = stravaCredentialsSpec.fields.find((f) => f.name === "client_id");
    expect(field?.pattern).toBeDefined();
    expect(new RegExp(field!.pattern!).test("226848")).toBe(true);
    expect(new RegExp(field!.pattern!).test("not-a-number")).toBe(false);
  });
});

describe("Strava auth helpers", () => {
  test("authorize URL carries redirect URI, scopes, and state", () => {
    const url = new URL(
      buildAuthorizeUrl(CREDS, "http://localhost:3003/oauth2callback", "flow-state-1"),
    );

    expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("226848");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3003/oauth2callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    // `force`, not `auto`: under `auto` Strava skips the authorization
    // screen once the athlete has approved, so a second add silently
    // re-authorizes whoever is already signed in.
    expect(url.searchParams.get("approval_prompt")).toBe("force");
    expect(url.searchParams.get("scope")).toBe("read,activity:read_all,profile:read_all");
    expect(url.searchParams.get("state")).toBe("flow-state-1");
  });

  test("callback parser accepts only the expected state", () => {
    expect(
      parseOAuthCallbackUrl(
        "/oauth2callback?code=auth-code-1&scope=read,activity:read_all&state=flow-state-1",
        "flow-state-1",
      ),
    ).toEqual({ kind: "code", code: "auth-code-1", scope: "read,activity:read_all" });

    const mismatch = parseOAuthCallbackUrl(
      "/oauth2callback?code=auth-code-1&state=wrong-state",
      "flow-state-1",
    );
    expect(mismatch).toMatchObject({ kind: "ignored", status: 400 });
  });

  test("callback parser ignores other paths", () => {
    expect(parseOAuthCallbackUrl("/not-the-callback?code=auth-code-1", "flow-state-1")).toEqual({
      kind: "ignored",
      status: 404,
      body: "Not found.",
    });
  });

  test("callback parser returns provider errors only with matching state", () => {
    expect(parseOAuthCallbackUrl("/oauth2callback?error=access_denied&state=s-1", "s-1")).toEqual({
      kind: "error",
      error: "access_denied",
    });

    const mismatch = parseOAuthCallbackUrl("/oauth2callback?error=access_denied&state=s-2", "s-1");
    expect(mismatch).toMatchObject({ kind: "ignored", status: 400 });
  });
});
