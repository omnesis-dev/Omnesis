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
import { shouldOpenCredentialsWizard } from "./add-source.js";

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

  test("an unknown fileKey never opens it", () => {
    expect(shouldOpenCredentialsWizard({ perAccount: true }, undefined, false)).toBe(false);
  });
});
