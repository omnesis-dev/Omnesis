// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// This browser's device key for sign-in enrollment (docs/device-enrollment.md):
// one non-extractable P-256 key per origin, kept in IndexedDB and reused, so a
// later sign-in from this browser proves it is the same device. The private
// key can sign but can never be read back out of the browser.

import { base64url } from "./cloud-pairing.js";

const DB_NAME = "omnesis-device-key";
const STORE = "keys";
const ID = "device";

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function openDatabase(indexedDB) {
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

async function read(db) {
  return request(db.transaction(STORE, "readonly").objectStore(STORE).get(ID));
}

async function write(db, value, replace) {
  const transaction = db.transaction(STORE, "readwrite");
  // `add` refuses to overwrite, so two tabs racing keep the first key. Only an
  // unusable record is replaced.
  if (replace) transaction.objectStore(STORE).put(value, ID);
  else transaction.objectStore(STORE).add(value, ID);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const usable = (value) =>
  value?.privateKey?.type === "private" &&
  value?.publicKey?.type === "public" &&
  value.privateKey.extractable === false;

/**
 * Loads this origin's device key, creating it once. Resolves to
 * `{ privateKey, publicKey: base64url DER SPKI }`, or null when the browser
 * cannot keep one (no IndexedDB, private mode): the caller then falls back to
 * a request that waits for approval.
 */
export async function loadDeviceKey({
  indexedDB = globalThis.indexedDB,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!indexedDB || !subtle) return null;
  try {
    const db = await openDatabase(indexedDB);
    try {
      let pair = await read(db);
      if (!usable(pair)) {
        const generated = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
          "sign",
          "verify",
        ]);
        try {
          await write(
            db,
            { privateKey: generated.privateKey, publicKey: generated.publicKey },
            pair !== undefined,
          );
        } catch {
          /* another tab stored one first; read it back below */
        }
        pair = await read(db);
        if (!usable(pair)) return null;
      }
      const spki = await subtle.exportKey("spki", pair.publicKey);
      return { privateKey: pair.privateKey, publicKey: base64url(spki) };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Makes a key pair handed over by the Omnesis account page this origin's device
 * key, replacing any earlier one. The private key is stored non-extractable, so
 * from here on it can sign but cannot be read back. Resolves like `loadDeviceKey`,
 * or to null when the pair is not the P-256 key `devicePublicKey` names or the
 * browser cannot keep it.
 */
export async function adoptDeviceKey(
  jwk,
  devicePublicKey,
  { indexedDB = globalThis.indexedDB, subtle = globalThis.crypto?.subtle } = {},
) {
  if (!indexedDB || !subtle) return null;
  try {
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const privateKey = await subtle.importKey("jwk", jwk, algorithm, false, ["sign"]);
    const publicKey = await subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      algorithm,
      true,
      ["verify"],
    );
    // A JWK can pair any private scalar with any public point, so the pair proves itself.
    const probe = new Uint8Array(32);
    const signing = { name: "ECDSA", hash: "SHA-256" };
    const signature = await subtle.sign(signing, privateKey, probe);
    if (
      base64url(await subtle.exportKey("spki", publicKey)) !== devicePublicKey ||
      !(await subtle.verify(signing, publicKey, signature, probe))
    )
      return null;
    const db = await openDatabase(indexedDB);
    try {
      await write(db, { privateKey, publicKey }, true);
    } finally {
      db.close();
    }
    return { privateKey, publicKey: devicePublicKey };
  } catch {
    return null;
  }
}
