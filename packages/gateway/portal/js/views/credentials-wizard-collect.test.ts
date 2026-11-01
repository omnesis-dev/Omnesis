// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wizard's two delivery modes, and the gate that decides whether it opens.
 *
 * A provider-wide credential is saved and the caller told it happened. A
 * per-account credential is not saved at all — it belongs to the account the
 * provider's probe is about to resolve — so the collected fields come back to
 * the caller, which threads them into the auth flow.
 *
 * The fields are handed over as an `onClose` argument rather than through a
 * state setter. That is the contract under test: a setter has not applied by
 * the time the caller's handler runs, so the caller would resume the auth flow
 * with `undefined`, the always-collect gate would reopen the wizard, and the
 * user would re-paste an unrecoverable API key forever.
 */

import { describe, test, expect, vi } from "vitest";
// @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
import { deliverCredentialFields } from "./credentials-wizard.js";
// @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
import { isAccountRegistered, shouldOpenCredentialsWizard } from "./add-source.js";

const ENTRY = { fileKey: "granola" };
const FIELDS = { api_key: "gk_live_supersecret" };

describe("collectOnly mode", () => {
  test("hands the fields to onClose instead of saving them", async () => {
    const setProviderCredentials = vi.fn(async () => {});
    const onClose = vi.fn();

    await deliverCredentialFields({
      cleaned: FIELDS,
      collectOnly: true,
      save: setProviderCredentials,
      onClose,
      entry: ENTRY,
      deviceId: "device-1",
    });

    expect(setProviderCredentials).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(true, FIELDS);
  });

  test("the caller receives the fields synchronously, not via a later render", async () => {
    // The regression this guards: delivering through a `useState` setter and
    // reading the value back in `onClose` yields `undefined`, because the
    // setter only schedules a re-render.
    let received: Record<string, string> | undefined;
    await deliverCredentialFields({
      cleaned: FIELDS,
      collectOnly: true,
      save: async () => {},
      onClose: (_updated, fields) => {
        received = fields;
      },
      entry: ENTRY,
      deviceId: "device-1",
    });
    expect(received).toEqual(FIELDS);
  });
});

describe("saving mode", () => {
  test("saves a provider-wide credential and reports no fields", async () => {
    const setProviderCredentials = vi.fn(async () => {});
    const onClose = vi.fn();

    await deliverCredentialFields({
      cleaned: FIELDS,
      save: setProviderCredentials,
      onClose,
      entry: ENTRY,
      deviceId: "device-1",
    });

    expect(setProviderCredentials).toHaveBeenCalledWith({
      fileKey: "granola",
      deviceId: "device-1",
      fields: FIELDS,
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  test("an explicit saveCredentials override wins over the default", async () => {
    const saveCredentials = vi.fn(async () => {});
    const setProviderCredentials = vi.fn(async () => {});

    await deliverCredentialFields({
      cleaned: FIELDS,
      saveCredentials,
      save: setProviderCredentials,
      onClose: vi.fn(),
      entry: ENTRY,
      deviceId: "device-1",
    });

    expect(saveCredentials).toHaveBeenCalledOnce();
    expect(setProviderCredentials).not.toHaveBeenCalled();
  });
});

describe("the gate that decides whether the wizard opens", () => {
  test("a per-account source opens it when no fields are in hand", () => {
    expect(shouldOpenCredentialsWizard({ perAccount: true }, { configured: true }, false)).toBe(
      true,
    );
  });

  test("and does NOT reopen it once the fields have been collected", () => {
    // Without this the resume re-enters the gate, which for a per-account spec
    // always wants to collect — an endless wizard.
    expect(shouldOpenCredentialsWizard({ perAccount: true }, { configured: true }, true)).toBe(
      false,
    );
  });

  test("a provider-wide credential is still asked for only when absent", () => {
    expect(shouldOpenCredentialsWizard({ required: true }, { configured: false }, false)).toBe(
      true,
    );
    expect(shouldOpenCredentialsWizard({ required: true }, { configured: true }, false)).toBe(
      false,
    );
  });

  test("a provider with no credentials spec never opens it", () => {
    expect(shouldOpenCredentialsWizard(undefined, undefined, false)).toBe(false);
  });

  test("a brokered account not added yet skips it", () => {
    const brokered = { configured: false, brokeredAccounts: ["workspace-1"] };
    expect(shouldOpenCredentialsWizard({ required: true }, brokered, false)).toBe(false);
    expect(shouldOpenCredentialsWizard({ perAccount: true }, brokered, false)).toBe(false);
    const isAdded = (accountId: string) => accountId === "workspace-1";
    const two = { configured: false, brokeredAccounts: ["workspace-1", "workspace-2"] };
    expect(shouldOpenCredentialsWizard({ perAccount: true }, two, false, isAdded)).toBe(false);
  });

  test("once every brokered account is added, a new account opens it as usual", () => {
    // The CLI's rule: a brokered account already added says nothing about the
    // account being added now, which is signed in here.
    const isAdded = () => true;
    const perAccount = { configured: true, brokeredAccounts: ["workspace-1"] };
    expect(shouldOpenCredentialsWizard({ perAccount: true }, perAccount, false, isAdded)).toBe(
      true,
    );
    const shared = { configured: false, brokeredAccounts: ["workspace-1"] };
    expect(shouldOpenCredentialsWizard({ required: true }, shared, false, isAdded)).toBe(true);
    const sharedSet = { configured: true, brokeredAccounts: ["workspace-1"] };
    expect(shouldOpenCredentialsWizard({ required: true }, sharedSet, false, isAdded)).toBe(false);
  });

  describe("an added brokered account is one the gateway lists, as the CLI counts it", () => {
    const spec = { required: true };
    const entry = { configured: false, brokeredAccounts: ["workspace-1"] };
    const row = {
      id: "notion-pages:workspace-1",
      type: "notion-pages",
      deviceId: "dev-other",
      enabled: true,
    };

    test("registered on another device: the wizard opens", () => {
      const isAdded = isAccountRegistered("notion-pages", [row]);
      expect(isAdded("workspace-1")).toBe(true);
      expect(shouldOpenCredentialsWizard(spec, entry, false, isAdded)).toBe(true);
    });

    test("registered but disabled: the wizard opens", () => {
      const isAdded = isAccountRegistered("notion-pages", [{ ...row, enabled: false }]);
      expect(isAdded("workspace-1")).toBe(true);
      expect(shouldOpenCredentialsWizard(spec, entry, false, isAdded)).toBe(true);
    });

    test("not registered, or registered only as another type: the wizard is skipped", () => {
      expect(shouldOpenCredentialsWizard(spec, entry, false, isAccountRegistered("notion-pages", []))).toBe(false);
      const otherType = { ...row, id: "notion-databases:workspace-1", type: "notion-databases" };
      const isAdded = isAccountRegistered("notion-pages", [otherType]);
      expect(isAdded("workspace-1")).toBe(false);
      expect(shouldOpenCredentialsWizard(spec, entry, false, isAdded)).toBe(false);
    });
  });

  test("an unknown fileKey never opens it", () => {
    expect(shouldOpenCredentialsWizard({ perAccount: true }, undefined, false)).toBe(false);
  });
});
