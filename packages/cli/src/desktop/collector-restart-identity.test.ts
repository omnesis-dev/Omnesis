// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  generation: vi.fn(),
  authority: vi.fn(),
  mutation: vi.fn(),
  state: vi.fn(),
  token: vi.fn(),
  secret: vi.fn(),
  storage: vi.fn(),
}));
vi.mock("./generation.js", () => ({ assertDesktopProfileGeneration: mocks.generation }));
vi.mock("./process-authority.js", () => ({ assertDesktopProcessAuthority: mocks.authority }));
vi.mock("./update-admission.js", () => ({ assertDesktopMutationAllowed: mocks.mutation }));
vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  readCollectorPairingState: mocks.state,
  readSecretTextFile: mocks.token,
  secretFileEncryptionRequired: mocks.secret,
  storageEncryptionRequired: mocks.storage,
}));
import { tokenFingerprint } from "@omnesis/core";
import { readDesktopRestartIdentity } from "./collector-restart-identity.js";
const profile = {
  configDir: "/example/owned-desktop",
  instance: "desktop-0123456789abcdef",
  secretService: "fixture.desktop",
};
const token = "omn_fictional_collector";
const deviceId = "00000000-0000-4000-8000-000000000004";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.secret.mockReturnValue(true);
  mocks.storage.mockReturnValue(true);
  mocks.state.mockReturnValue({
    state: "paired",
    deviceId,
    tokenFingerprint: tokenFingerprint(token),
  });
  mocks.token.mockResolvedValue(token);
});
test("reads only the explicit managed collector token scope and saved identity", async () => {
  expect(await readDesktopRestartIdentity(profile)).toEqual({
    deviceId,
    fingerprint: tokenFingerprint(token),
  });
  expect(mocks.token).toHaveBeenCalledWith("/example/owned-desktop/collector-token", {
    configDir: profile.configDir,
    service: profile.secretService,
    backend: "macos-keychain",
  });
});
test.each(["generation", "authority", "mutation"] as const)(
  "%s admission refusal cannot read or replace credentials",
  async (guard) => {
    mocks[guard].mockImplementation(() => {
      throw new Error("refused");
    });
    await expect(readDesktopRestartIdentity(profile)).rejects.toThrow("refused");
    expect(mocks.token).not.toHaveBeenCalled();
  },
);
test.each(["missing", "different-token", "needs-pairing", "invalid-device"])(
  "%s state cannot start a new identity",
  async (failure) => {
    if (failure === "missing") mocks.state.mockReturnValue(null);
    if (failure === "different-token") mocks.token.mockResolvedValue("omn_changed");
    if (failure === "needs-pairing") mocks.state.mockReturnValue({ state: "needs-pairing" });
    if (failure === "invalid-device")
      mocks.state.mockReturnValue({
        state: "paired",
        deviceId: "unknown",
        tokenFingerprint: tokenFingerprint(token),
      });
    await expect(readDesktopRestartIdentity(profile)).rejects.toThrow("saved paired collector");
  },
);
test("lost encryption cannot restart collection", async () => {
  mocks.storage.mockReturnValue(false);
  await expect(readDesktopRestartIdentity(profile)).rejects.toThrow("Protected storage");
  expect(mocks.token).not.toHaveBeenCalled();
});
