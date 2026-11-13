// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { webcrypto } from "node:crypto";
import { expect, test } from "vitest";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { adoptDeviceKey, loadDeviceKey } from "./device-key-store.js";

/** Just enough IndexedDB for one object store keyed by name, with async callbacks like a browser. */
function fakeIndexedDB({ failOpen = false, failAdd = false } = {}) {
  const rows = new Map<string, unknown>();
  let closed = 0;
  const later = (fn: () => void) => setTimeout(fn, 0);
  const db = {
    createObjectStore: () => undefined,
    close: () => {
      closed += 1;
    },
    transaction: () => {
      const transaction: Record<string, any> = {};
      const store = {
        get: (key: string) => {
          const request: Record<string, any> = {};
          later(() => {
            request.result = rows.get(key);
            request.onsuccess?.();
          });
          return request;
        },
        add: (value: unknown, key: string) =>
          later(() => {
            if (failAdd || rows.has(key)) {
              transaction.error = new Error("ConstraintError");
              transaction.onerror?.();
              return;
            }
            rows.set(key, value);
            transaction.oncomplete?.();
          }),
        put: (value: unknown, key: string) =>
          later(() => {
            rows.set(key, value);
            transaction.oncomplete?.();
          }),
      };
      transaction.objectStore = () => store;
      return transaction;
    },
  };
  const indexedDB = {
    open: () => {
      const request: Record<string, any> = { result: db };
      later(() => {
        if (failOpen) {
          request.error = new Error("blocked");
          request.onerror?.();
          return;
        }
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, rows, closed: () => closed };
}

test("creates one non-extractable P-256 key per origin and reuses it", async () => {
  const store = fakeIndexedDB();
  const first = await loadDeviceKey({ indexedDB: store.indexedDB, subtle: webcrypto.subtle });
  expect(first.privateKey.extractable).toBe(false);
  expect(first.privateKey.algorithm).toMatchObject({ name: "ECDSA", namedCurve: "P-256" });
  expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{64,256}$/);
  await expect(webcrypto.subtle.exportKey("pkcs8", first.privateKey)).rejects.toThrow();
  const second = await loadDeviceKey({ indexedDB: store.indexedDB, subtle: webcrypto.subtle });
  expect(second.publicKey).toBe(first.publicKey);
  expect(store.rows.size).toBe(1);
  expect(store.closed()).toBe(2);
});

test("an unusable stored record is replaced, and a lost race keeps the other tab's key", async () => {
  const store = fakeIndexedDB();
  store.rows.set("device", { privateKey: "not a key" });
  const replaced = await loadDeviceKey({ indexedDB: store.indexedDB, subtle: webcrypto.subtle });
  expect(replaced.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  const racing = fakeIndexedDB({ failAdd: true });
  expect(await loadDeviceKey({ indexedDB: racing.indexedDB, subtle: webcrypto.subtle })).toBeNull();
});

test("a browser that cannot keep a key returns null so sign-in falls back to approval", async () => {
  expect(await loadDeviceKey({ indexedDB: null, subtle: webcrypto.subtle })).toBeNull();
  expect(await loadDeviceKey({ indexedDB: fakeIndexedDB().indexedDB, subtle: null })).toBeNull();
  expect(
    await loadDeviceKey({
      indexedDB: fakeIndexedDB({ failOpen: true }).indexedDB,
      subtle: webcrypto.subtle,
    }),
  ).toBeNull();
  const extractable = fakeIndexedDB();
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  extractable.rows.set("device", pair);
  // A key that could be exported is never used; it is replaced by a non-extractable one.
  const loaded = await loadDeviceKey({
    indexedDB: extractable.indexedDB,
    subtle: webcrypto.subtle,
  });
  expect(loaded.privateKey.extractable).toBe(false);
});

/** A key pair as the Omnesis account page hands it over: a private JWK and the SPKI it names. */
async function handedKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return {
    jwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey),
    publicKey: Buffer.from(await webcrypto.subtle.exportKey("spki", pair.publicKey)).toString(
      "base64url",
    ),
  };
}

test("a handed-over key becomes this origin's device key, non-extractable, replacing any earlier one", async () => {
  const store = fakeIndexedDB();
  const options = { indexedDB: store.indexedDB, subtle: webcrypto.subtle };
  const earlier = await loadDeviceKey(options);
  const handed = await handedKey();
  const adopted = await adoptDeviceKey(handed.jwk, handed.publicKey, options);
  expect(adopted.publicKey).toBe(handed.publicKey);
  expect(adopted.publicKey).not.toBe(earlier.publicKey);
  expect(adopted.privateKey.extractable).toBe(false);
  await expect(webcrypto.subtle.exportKey("jwk", adopted.privateKey)).rejects.toThrow();
  // Later sign-ins from this browser load the same key, and it signs for the handed-over public key.
  const loaded = await loadDeviceKey(options);
  expect(loaded.publicKey).toBe(handed.publicKey);
  const message = new TextEncoder().encode("fictional transcript");
  const signature = await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    loaded.privateKey,
    message,
  );
  const verifier = await webcrypto.subtle.importKey(
    "jwk",
    { kty: handed.jwk.kty, crv: handed.jwk.crv, x: handed.jwk.x, y: handed.jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, message),
  ).toBe(true);
  expect(store.rows.size).toBe(1);
});

test("a handed-over key that is not the named P-256 pair, or cannot be kept, is refused and changes nothing", async () => {
  const store = fakeIndexedDB();
  const options = { indexedDB: store.indexedDB, subtle: webcrypto.subtle };
  const kept = await loadDeviceKey(options);
  const handed = await handedKey(),
    other = await handedKey();
  // Another key's name, a private scalar from another pair, and a value that is no key at all.
  expect(await adoptDeviceKey(handed.jwk, other.publicKey, options)).toBeNull();
  expect(
    await adoptDeviceKey({ ...handed.jwk, d: other.jwk.d }, handed.publicKey, options),
  ).toBeNull();
  expect(await adoptDeviceKey({ kty: "EC" }, handed.publicKey, options)).toBeNull();
  expect((await loadDeviceKey(options)).publicKey).toBe(kept.publicKey);
  for (const unavailable of [
    { indexedDB: null, subtle: webcrypto.subtle },
    { indexedDB: store.indexedDB, subtle: null },
    { indexedDB: fakeIndexedDB({ failOpen: true }).indexedDB, subtle: webcrypto.subtle },
  ])
    expect(await adoptDeviceKey(handed.jwk, handed.publicKey, unavailable)).toBeNull();
});
