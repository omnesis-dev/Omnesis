// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The test-only manifest variant the headless browser E2E loads.
 *
 * Two edits, both of which must never reach a shipped build:
 *
 *   - the optional wildcard-HTTPS host permission becomes a mandatory one, so
 *     Chrome grants site access at install time. The real extension asks for
 *     it during pairing through a native dialog that no automation can click;
 *     a headless run would otherwise stall forever at "Pairing…".
 *   - a fixed `key` pins the extension id, so `chrome-extension://<id>/…`
 *     URLs are stable across runs and machines.
 *
 * The public key below is an RSA public key generated for this purpose alone;
 * no private half exists anywhere. Chrome derives the extension id from it, so
 * the id is a constant the E2E can rely on. `store-release.test.ts` asserts
 * the store ZIP carries neither edit.
 */
const TEST_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3WdPUimIntUxyAflqm0akcM1ItFw5OxqBUfBRutqBhWMQpXX3bOzBJAHA6zA2yRHieAgja/8qM/eVCQoShy+CB7zJa77aqmdsoyL7EL+ysT13c4beZjvhQf8jYk/3nsSwOuHSmGYqA8sAttYdk48B/oC5zMzJNkrZLUrS5CFRPWNY5TH8rd7MENnFD0NNcD7pY4ilxAf/bgmxp0g0U3oS8w2DY4o1o7vcVZS935rk3YbQwt/6xLnWAfbA5Bd3rNzRrA6i28z0X6Q6H1d166dmZxbXAtqdCqd4pYJgunEsFRcPyhGN1fTC/G8aJeGBIb41VRzv1w64on9YjvlRF9t2QIDAQAB";

/** The extension id Chrome derives from {@link TEST_EXTENSION_KEY}. */
export const TEST_EXTENSION_ID = "kfekefphldjmmilfoopcnmlbmfcilddi";

export function applyTestManifest(manifest) {
  const { optional_host_permissions: optional, ...rest } = manifest;
  return {
    ...rest,
    key: TEST_EXTENSION_KEY,
    host_permissions: optional ?? [],
  };
}
