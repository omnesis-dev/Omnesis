// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  MissingCredentialsError,
  isMissingCredentialsError,
  isCredentialPersistError,
  CredentialPersistError,
  providerCredentialsPath,
  readProviderCredentials,
  writeProviderCredentials,
  clearProviderCredentials,
  hasProviderCredentials,
  serializeCredentialsSpec,
  validateCredentialFields,
  type ProviderCredentialsField,
  type ProviderCredentialsSpec,
} from "./credentials.js";
import { ensureInstallRootKey } from "./secret-store.js";
import { clearSecretFileKeyCacheForTests, isEncryptedSecretFile } from "./secret-file.js";

describe("credentials file IO", () => {
  let dir: string;

  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    dir = mkdtempSync(join(tmpdir(), "omnesis-creds-test-"));
  });
  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  test("providerCredentialsPath returns <configDir>/<fileKey>-credentials.json", () => {
    expect(providerCredentialsPath("google", dir)).toBe(join(dir, "google-credentials.json"));
    expect(providerCredentialsPath("strava", dir)).toBe(join(dir, "strava-credentials.json"));
  });

  test("readProviderCredentials returns null when file is absent", async () => {
    expect(await readProviderCredentials("google", dir)).toBeNull();
  });

  test("write → read round-trip preserves all fields", async () => {
    await writeProviderCredentials(
      "google",
      { client_id: "abc-123", client_secret: "GOCSPX-xyz" },
      dir,
    );
    const read = await readProviderCredentials("google", dir);
    expect(read).toEqual({ client_id: "abc-123", client_secret: "GOCSPX-xyz" });
  });

  test("write encrypts credentials when an install root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir: dir });

    await writeProviderCredentials(
      "google",
      { client_id: "abc-123", client_secret: "GOCSPX-xyz" },
      dir,
      { backend: "file" },
    );

    const path = providerCredentialsPath("google", dir);
    const raw = readFileSync(path, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain("GOCSPX-xyz");
    await expect(readProviderCredentials("google", dir, { backend: "file" })).resolves.toEqual({
      client_id: "abc-123",
      client_secret: "GOCSPX-xyz",
    });
  });

  test("write produces a 0600 file (atomic, owner-only)", async () => {
    await writeProviderCredentials("google", { client_id: "a", client_secret: "b" }, dir);
    const path = providerCredentialsPath("google", dir);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("write does not leave a scratch file behind on success", async () => {
    await writeProviderCredentials("google", { client_id: "a", client_secret: "b" }, dir);
    // The atomic writer stages the payload under a name private to that
    // write, so match on the `.tmp` suffix all of them share rather than
    // on any one name.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("readProviderCredentials unwraps Google's `installed: { ... }` envelope", async () => {
    const path = providerCredentialsPath("google", dir);
    const wrapped = { installed: { client_id: "wrapped-id", client_secret: "wrapped-secret" } };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(wrapped), { mode: 0o600 });
    const read = await readProviderCredentials("google", dir);
    expect(read).toEqual({ client_id: "wrapped-id", client_secret: "wrapped-secret" });
  });

  test("readProviderCredentials unwraps Google's `web: { ... }` envelope", async () => {
    const path = providerCredentialsPath("google", dir);
    const wrapped = { web: { client_id: "wrapped", client_secret: "secret" } };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(wrapped), { mode: 0o600 });
    const read = await readProviderCredentials("google", dir);
    expect(read).toEqual({ client_id: "wrapped", client_secret: "secret" });
  });

  test("hasProviderCredentials reflects existence", async () => {
    expect(hasProviderCredentials("google", dir)).toBe(false);
    await writeProviderCredentials("google", { client_id: "a", client_secret: "b" }, dir);
    expect(hasProviderCredentials("google", dir)).toBe(true);
  });

  test("clearProviderCredentials removes the file", async () => {
    await writeProviderCredentials("google", { client_id: "a", client_secret: "b" }, dir);
    expect(hasProviderCredentials("google", dir)).toBe(true);
    await clearProviderCredentials("google", dir);
    expect(hasProviderCredentials("google", dir)).toBe(false);
  });

  test("clearProviderCredentials is a no-op when file is absent", async () => {
    await expect(clearProviderCredentials("google", dir)).resolves.toBeUndefined();
  });

  // The power-loss / half-pasted-download recovery contract: a corrupt file
  // must degrade to `null` (re-enter the setup wizard), never throw.
  test("readProviderCredentials degrades truncated/malformed JSON to null (does not throw)", async () => {
    const path = providerCredentialsPath("google", dir);
    const { writeFileSync } = await import("node:fs");
    // Simulate a power-loss-truncated write.
    writeFileSync(path, '{"client_id": "abc", "client_sec', { mode: 0o600 });
    await expect(readProviderCredentials("google", dir)).resolves.toBeNull();
  });

  test("readProviderCredentials degrades a top-level JSON array to null", async () => {
    const path = providerCredentialsPath("google", dir);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(["client_id", "client_secret"]), { mode: 0o600 });
    await expect(readProviderCredentials("google", dir)).resolves.toBeNull();
  });

  test("readProviderCredentials degrades a top-level JSON primitive to null", async () => {
    const path = providerCredentialsPath("google", dir);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify("just-a-string"), { mode: 0o600 });
    await expect(readProviderCredentials("google", dir)).resolves.toBeNull();
  });

  test("readProviderCredentials drops non-string fields, keeping only string values", async () => {
    const path = providerCredentialsPath("strava", dir);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path,
      JSON.stringify({
        client_id: "id-1",
        client_secret: "secret-1",
        expires_in: 3600,
        scopes: ["a"],
      }),
      { mode: 0o600 },
    );
    const read = await readProviderCredentials("strava", dir);
    expect(read).toEqual({ client_id: "id-1", client_secret: "secret-1" });
  });
});

describe("validateCredentialFields", () => {
  test("optional fields may be omitted while undeclared requiredness remains required", () => {
    const fields = [
      { name: "token", label: "Token" },
      { name: "region", label: "Region", required: false },
    ];
    expect(validateCredentialFields({ token: "fictional-token" }, { fields })).toEqual({
      ok: true,
      cleaned: { token: "fictional-token" },
    });
    expect(validateCredentialFields({}, { fields }).ok).toBe(false);
    expect(validateCredentialFields({ token: "   " }, { fields }).ok).toBe(false);
    expect(validateCredentialFields({ token: "fictional-token", region: 42 }, { fields }).ok).toBe(
      false,
    );
  });
  const spec: { fields: ProviderCredentialsField[] } = {
    fields: [
      { name: "client_id", label: "Client ID" },
      {
        name: "client_secret",
        label: "Client secret",
        secret: true,
        pattern: "^GOCSPX-[A-Za-z0-9_-]+$",
        patternHint: "Client secret should start with GOCSPX-",
      },
    ],
  };

  test("rejects a missing required field with its label and name", () => {
    const result = validateCredentialFields({ client_secret: "GOCSPX-abc" }, spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Client ID");
      expect(result.error).toContain("client_id");
      expect(result.error).toContain("required");
    }
  });

  test("rejects an empty-string field as missing", () => {
    const result = validateCredentialFields({ client_id: "", client_secret: "GOCSPX-abc" }, spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Client ID");
  });

  test("rejects a non-string field value", () => {
    const result = validateCredentialFields(
      { client_id: 12345, client_secret: "GOCSPX-abc" },
      spec,
    );
    expect(result.ok).toBe(false);
  });

  test("trims surrounding whitespace in the cleaned output", () => {
    const result = validateCredentialFields(
      { client_id: "  pasted-id  ", client_secret: "GOCSPX-secret" },
      spec,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cleaned.client_id).toBe("pasted-id");
      expect(result.cleaned.client_secret).toBe("GOCSPX-secret");
    }
  });

  test("returns the patternHint when a field fails its regex", () => {
    const result = validateCredentialFields(
      { client_id: "valid-id", client_secret: "wrong-prefix" },
      spec,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Client secret should start with GOCSPX-");
  });

  test("validates the pattern against the trimmed value, not the raw input", () => {
    // Whitespace around an otherwise-valid secret must still pass.
    const result = validateCredentialFields(
      { client_id: "valid-id", client_secret: "  GOCSPX-trimmed  " },
      spec,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cleaned.client_secret).toBe("GOCSPX-trimmed");
  });

  test("only includes declared fields in the cleaned output (drops extras)", () => {
    const result = validateCredentialFields(
      { client_id: "id", client_secret: "GOCSPX-x", junk: "ignore-me" },
      spec,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.cleaned).sort()).toEqual(["client_id", "client_secret"]);
    }
  });
});

describe("MissingCredentialsError", () => {
  test("carries fileKey + providerName + structured code", () => {
    const err = new MissingCredentialsError("google", "Google");
    expect(err.code).toBe("missing-credentials");
    expect(err.fileKey).toBe("google");
    expect(err.providerName).toBe("Google");
    expect(err.message).toContain("Google");
    expect(err.message).toContain("creds set google");
  });

  test("isMissingCredentialsError narrows correctly", () => {
    const err = new MissingCredentialsError("strava", "Strava");
    expect(isMissingCredentialsError(err)).toBe(true);
    expect(isMissingCredentialsError(new Error("other"))).toBe(false);
    expect(isMissingCredentialsError(null)).toBe(false);
    expect(isMissingCredentialsError(undefined)).toBe(false);
  });

  test("refuses an error that carries the code but not what the code promises", () => {
    // A second vocabulary shares these codes: a source's typed auth failure
    // says `missing-credentials` too, and carries neither field. Claiming it
    // here hands the caller `fileKey: undefined` under a type that says it is
    // a string, and a client is then told to open a wizard it cannot name.
    const lookalike = Object.assign(new Error("no application credential"), {
      code: "missing-credentials",
    });
    expect(isMissingCredentialsError(lookalike)).toBe(false);

    const persistLookalike = Object.assign(new Error("could not store it"), {
      code: "credential-persist-failed",
    });
    expect(isCredentialPersistError(persistLookalike)).toBe(false);
    expect(
      isCredentialPersistError(new CredentialPersistError("strava", "maya@example.org", "locked")),
    ).toBe(true);
  });

  test("toJSON yields a serializable structured payload (IPC across subprocess)", () => {
    const err = new MissingCredentialsError("google", "Google");
    const json = err.toJSON();
    expect(json.code).toBe("missing-credentials");
    expect(json.fileKey).toBe("google");
    expect(json.providerName).toBe("Google");
  });
});

describe("serializeCredentialsSpec", () => {
  const spec: ProviderCredentialsSpec = {
    fileKey: "google",
    required: true,
    fields: [
      { name: "client_id", label: "Client ID" },
      { name: "client_secret", label: "Client secret", secret: true },
    ],
    wizard: {
      intro: "x",
      why: "y",
      estMinutes: 5,
      steps: [{ kind: "instruction", title: "step", body: "do it" }],
    },
  };

  test("emits publicClient: false when omitted", () => {
    expect(serializeCredentialsSpec(spec).publicClient).toBe(false);
  });

  test("preserves all wizard fields", () => {
    const out = serializeCredentialsSpec(spec);
    expect(out.wizard.intro).toBe("x");
    expect(out.wizard.steps).toHaveLength(1);
    expect(out.fields).toHaveLength(2);
  });
});
