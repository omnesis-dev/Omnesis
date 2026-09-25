// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { proto } from "@whiskeysockets/baileys";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isEncryptedSecretFile,
} from "@omnesis/core";
import {
  promoteOmnesisMultiFileAuthState,
  quiesceOmnesisMultiFileAuthState,
  sealOmnesisMultiFileAuthState,
  useOmnesisMultiFileAuthState,
} from "./baileys-auth-state.js";

let configDir: string;
let authDir: string;
let oldSecretStore: string | undefined;

beforeEach(() => {
  oldSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
  configDir = mkdtempSync(join(tmpdir(), "omnesis-wa-auth-state-"));
  authDir = join(configDir, "whatsapp", "+15550100001", "auth");
});

afterEach(() => {
  clearSecretFileKeyCacheForTests();
  if (oldSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = oldSecretStore;
  rmSync(configDir, { recursive: true, force: true });
});

describe("useOmnesisMultiFileAuthState", () => {
  test("keeps plaintext compatibility when no install root key exists", async () => {
    const { state, saveCreds } = await useOmnesisMultiFileAuthState(authDir, configDir);
    state.creds.me = { id: "15550100001:0@s.whatsapp.net" };

    await saveCreds();

    const credsPath = join(authDir, "creds.json");
    expect(existsSync(credsPath)).toBe(true);
    const raw = readFileSync(credsPath, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(false);
    expect(raw).toContain("15550100001");
  });

  test("wraps credentials and Signal key fragments when a root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const { state, saveCreds } = await useOmnesisMultiFileAuthState(authDir, configDir);
    state.creds.me = { id: "15550100001:0@s.whatsapp.net" };

    await saveCreds();
    await state.keys.set({ session: { "user@s.whatsapp.net": Uint8Array.from([1, 2, 3]) } });

    const credsRaw = readFileSync(join(authDir, "creds.json"), "utf8");
    const sessionRaw = readFileSync(join(authDir, "session-user@s.whatsapp.net.json"), "utf8");
    expect(isEncryptedSecretFile(credsRaw)).toBe(true);
    expect(isEncryptedSecretFile(sessionRaw)).toBe(true);
    expect(credsRaw).not.toContain("s.whatsapp.net");

    const reopened = await useOmnesisMultiFileAuthState(authDir, configDir);
    expect(reopened.state.creds.me?.id).toBe("15550100001:0@s.whatsapp.net");
    const sessions = await reopened.state.keys.get("session", ["user@s.whatsapp.net"]);
    expect(Array.from(sessions["user@s.whatsapp.net"])).toEqual([1, 2, 3]);
  });

  test("quiescing waits for in-flight Signal writes", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const { state } = await useOmnesisMultiFileAuthState(authDir, configDir);
    const ids = Array.from({ length: 32 }, (_, index) => `fictional-${index}`);
    const pending = state.keys.set({
      session: Object.fromEntries(ids.map((id, index) => [id, Uint8Array.from([index])])),
    });

    await quiesceOmnesisMultiFileAuthState(authDir);
    await pending;

    const reopened = await useOmnesisMultiFileAuthState(authDir, configDir);
    const sessions = await reopened.state.keys.get("session", ids);
    expect(Object.keys(sessions)).toHaveLength(ids.length);
  });

  test("quiescing prevents a late writer from changing staged credentials", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const { state, saveCreds } = await useOmnesisMultiFileAuthState(authDir, configDir);
    state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await saveCreds();

    await quiesceOmnesisMultiFileAuthState(authDir);
    state.creds.me = { id: "user@s.whatsapp.net" };
    await saveCreds();

    const reopened = await useOmnesisMultiFileAuthState(authDir, configDir);
    expect(reopened.state.creds.me?.id).toBe("15550100001:0@s.whatsapp.net");
  });

  test("an external generation rotation invalidates an older writer", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const { state, saveCreds } = await useOmnesisMultiFileAuthState(authDir, configDir);
    state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await saveCreds();

    writeFileSync(`${authDir}.generation`, "replacement-generation");
    state.creds.me = { id: "user@s.whatsapp.net" };
    await saveCreds();

    const reopened = await useOmnesisMultiFileAuthState(authDir, configDir);
    expect(reopened.state.creds.me?.id).toBe("15550100001:0@s.whatsapp.net");
  });

  test("sealing prevents another process from reopening staged auth", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await staged.saveCreds();

    await sealOmnesisMultiFileAuthState(authDir);

    await expect(useOmnesisMultiFileAuthState(authDir, configDir)).rejects.toThrow(
      "WhatsApp auth state is sealed",
    );
  });

  test("promotion rejects missing credentials without deleting destination state", async () => {
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "session-user@s.whatsapp.net.json"), "{}");
    const destination = join(configDir, "whatsapp", "destination", "auth");
    mkdirSync(destination, { recursive: true });
    const retained = join(destination, "retained.json");
    writeFileSync(retained, "keep");

    await expect(promoteOmnesisMultiFileAuthState(authDir, destination, configDir)).rejects.toThrow(
      "WhatsApp auth state is incomplete or contains unexpected entries",
    );
    expect(readFileSync(retained, "utf8")).toBe("keep");
  });

  test("promotion rejects a symlinked destination auth directory", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await staged.saveCreds();
    const outside = join(configDir, "outside");
    mkdirSync(outside, { recursive: true });
    const sentinel = join(outside, "creds.json");
    writeFileSync(sentinel, "keep");
    const destination = join(configDir, "whatsapp", "destination", "auth");
    mkdirSync(join(configDir, "whatsapp", "destination"), { recursive: true });
    symlinkSync(outside, destination, "dir");

    await expect(promoteOmnesisMultiFileAuthState(authDir, destination, configDir)).rejects.toThrow(
      "WhatsApp auth path contains an unsafe filesystem entry",
    );
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  test("promotion rejects structurally incomplete credentials", async () => {
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "user@s.whatsapp.net" } }),
    );
    const destination = join(configDir, "whatsapp", "destination", "auth");
    mkdirSync(destination, { recursive: true });
    const retained = join(destination, "retained.json");
    writeFileSync(retained, "keep");

    await expect(promoteOmnesisMultiFileAuthState(authDir, destination, configDir)).rejects.toThrow(
      "creds.json: missing",
    );
    expect(readFileSync(retained, "utf8")).toBe("keep");
  });

  test("promotion keeps a session in the shape libsignal actually serialises", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    staged.state.creds.registered = true;
    await staged.saveCreds();
    // What `SessionRecord.serialize()` returns. Baileys types this entry as a
    // Uint8Array, so its declaration is not a description of what reaches disk,
    // and refusing this shape refuses every real pairing.
    writeFileSync(
      join(authDir, "session-15550100002_1.0.json"),
      JSON.stringify({ _sessions: { abc: { registrationId: 1 } }, version: "v1" }),
    );
    const destination = join(configDir, "whatsapp", "destination", "auth");

    await promoteOmnesisMultiFileAuthState(authDir, destination, configDir);

    expect(existsSync(join(destination, "session-15550100002_1.0.json"))).toBe(true);
  });

  test("promotion rejects a fragment that carries no state", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    staged.state.creds.registered = true;
    await staged.saveCreds();
    writeFileSync(join(authDir, "session-15550100002_1.0.json"), "null");

    await expect(
      promoteOmnesisMultiFileAuthState(
        authDir,
        join(configDir, "whatsapp", "destination", "auth"),
        configDir,
      ),
    ).rejects.toThrow("session-15550100002_1.0.json: null");
  });

  test("promotion reports every rejected entry in one verdict", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    staged.state.creds.registered = true;
    await staged.saveCreds();
    writeFileSync(join(authDir, "session-15550100002_1.0.json"), "null");
    writeFileSync(join(authDir, "pre-key-9.json"), "{ not json");

    const failure = await promoteOmnesisMultiFileAuthState(
      authDir,
      join(configDir, "whatsapp", "destination", "auth"),
      configDir,
    ).catch((err: Error) => err.message);

    expect(failure).toContain("session-15550100002_1.0.json: null");
    expect(failure).toContain("pre-key-9.json: invalid JSON");
  });

  test("promotion keeps an app-state sync key written by the store itself", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    staged.state.creds.registered = true;
    await staged.saveCreds();
    // Through the production writer, because the shape on disk is the protobuf's
    // own JSON — a base64 `keyData`, not a Buffer — and a fixture written by hand
    // would assert the shape this module used to believe in rather than the one
    // it produces.
    await staged.state.keys.set({
      "app-state-sync-key": {
        "AAAAALE+": proto.Message.AppStateSyncKeyData.fromObject({
          keyData: Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
          fingerprint: { rawId: 7, currentIndex: 1, deviceIndexes: [0, 1] },
          timestamp: 1790000000000,
        }),
      },
    });
    const destination = join(configDir, "whatsapp", "destination", "auth");

    await promoteOmnesisMultiFileAuthState(authDir, destination, configDir);

    const promoted = await useOmnesisMultiFileAuthState(destination, configDir);
    const read = await promoted.state.keys.get("app-state-sync-key", ["AAAAALE+"]);
    expect(read["AAAAALE+"]?.keyData).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(read["AAAAALE+"]!.keyData!).toString("hex")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
  });

  test("promotion rejects an app-state sync key with no usable key material", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    staged.state.creds.registered = true;
    await staged.saveCreds();
    writeFileSync(
      join(authDir, "app-state-sync-key-AAAAALE+.json"),
      JSON.stringify({ fingerprint: { rawId: 7 }, timestamp: "1790000000000" }),
    );

    await expect(
      promoteOmnesisMultiFileAuthState(
        authDir,
        join(configDir, "whatsapp", "destination", "auth"),
        configDir,
      ),
    ).rejects.toThrow("app-state-sync-key-AAAAALE+.json: object{fingerprint:object");
  });

  test("promotion rejects unknown fragments without changing destination state", async () => {
    const staged = await useOmnesisMultiFileAuthState(authDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await staged.saveCreds();
    writeFileSync(join(authDir, "unexpected.json"), "{}");
    const destination = join(configDir, "whatsapp", "destination", "auth");
    mkdirSync(destination, { recursive: true });
    const retained = join(destination, "retained.json");
    writeFileSync(retained, "keep");

    await expect(promoteOmnesisMultiFileAuthState(authDir, destination, configDir)).rejects.toThrow(
      "unexpected.json: not a recognised auth file",
    );
    expect(readFileSync(retained, "utf8")).toBe("keep");
  });

  test("fails closed when encrypted auth state exists but the root key is unavailable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const { state, saveCreds } = await useOmnesisMultiFileAuthState(authDir, configDir);
    state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await saveCreds();

    rmSync(join(configDir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();

    await expect(useOmnesisMultiFileAuthState(authDir, configDir)).rejects.toThrow(
      /install root key/,
    );
  });
});
