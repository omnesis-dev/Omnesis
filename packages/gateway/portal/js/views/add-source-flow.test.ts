// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  addSource: vi.fn(),
  cancelAuthFlow: vi.fn(),
  discoverSourceAccounts: vi.fn(),
  enableSourceMultiDeviceMode: vi.fn(),
  getAdminConfig: vi.fn(),
  getAdminSources: vi.fn(),
  getCredentialsStatus: vi.fn(),
  getSourceDescriptorsUnion: vi.fn(),
  getSourcesSnapshot: vi.fn(),
  joinSourceMember: vi.fn(),
  listDevices: vi.fn(),
  moveSourceToDevice: vi.fn(),
  resumeSource: vi.fn(),
  setProviderCredentials: vi.fn(),
  startAuthFlow: vi.fn(),
  submitAuthFlowCode: vi.fn(),
  submitAuthFlowWidgetResult: vi.fn(),
  updateSourceMemberConfig: vi.fn(),
  validateSourceParam: vi.fn(),
}));

vi.mock("../api.js", () => api);

// @ts-expect-error — portal is plain JS without sibling declarations.
import { AddSourceModal } from "./add-source.js";

const descriptor = {
  id: "notes-synth",
  name: "Synthetic notes",
  description: "Fictional local notes",
  provider: { id: "synthetic", name: "Synthetic" },
  authType: "local",
  hasDiscover: true,
  singleInstance: true,
  multiDeviceMode: "replicated",
  devices: [
    { id: "owner", name: "Maya-Laptop" },
    { id: "fresh", name: "Studio-Mini" },
  ],
};

const devices = [
  { id: "owner", name: "Maya-Laptop", kind: "collector", online: true, revokedAt: null },
  { id: "fresh", name: "Studio-Mini", kind: "collector", online: true, revokedAt: null },
];

const accountA = {
  id: "notes-synth:maya@example.com",
  type: "notes-synth",
  accountId: "maya@example.com",
  deviceId: "owner",
  enabled: true,
  members: ["owner"],
  joinCandidates: ["fresh"],
  multiDeviceMode: "replicated",
  pushBased: false,
};

describe("AddSourceModal single-instance account routing", () => {
  let host: HTMLElement;
  let onAdded: ReturnType<typeof vi.fn>;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    api.getSourceDescriptorsUnion.mockResolvedValue({ items: [descriptor] });
    api.getAdminSources.mockResolvedValue({ items: [accountA] });
    api.listDevices.mockResolvedValue({ items: devices });
    api.getSourcesSnapshot.mockResolvedValue({ configured: {} });
    api.addSource.mockResolvedValue({ sourceIds: ["notes-synth:jamie@example.org"] });
    api.joinSourceMember.mockResolvedValue({ members: ["owner", "fresh"] });
    onAdded = vi.fn();
    await act(async () => render(h(AddSourceModal, { onClose: vi.fn(), onAdded }), host));
    await settleEffects();
  });

  async function settleEffects() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function chooseAndContinue(accountId: string) {
    api.discoverSourceAccounts.mockResolvedValue({ accounts: [accountId] });
    const tile = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Synthetic notes"),
    ) as HTMLButtonElement;
    await act(async () => tile.click());
    await settleEffects();
    expect(api.getSourcesSnapshot).toHaveBeenCalledWith("fresh");
    expect(api.discoverSourceAccounts).toHaveBeenCalledWith("notes-synth", "fresh");
    const continueButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue",
    ) as HTMLButtonElement;
    await act(async () => continueButton.click());
    await settleEffects();
  }

  test("a different discovered account is added as a separate source on the free host", async () => {
    await chooseAndContinue("jamie@example.org");

    expect(api.addSource).toHaveBeenCalledWith({
      deviceId: "fresh",
      descriptorId: "notes-synth",
      accountIds: ["jamie@example.org"],
      params: undefined,
    });
    expect(api.joinSourceMember).not.toHaveBeenCalled();
  });

  test("the exact configured account joins instead of creating a duplicate", async () => {
    await chooseAndContinue("maya@example.com");

    expect(api.joinSourceMember).toHaveBeenCalledWith(
      "notes-synth:maya@example.com",
      "fresh",
      undefined,
    );
    expect(api.addSource).not.toHaveBeenCalled();
  });

  test("an exact legacy account explicitly enables replicated mode before joining", async () => {
    render(null, host);
    const legacy = { ...accountA, multiDeviceMode: "exclusive", joinCandidates: [] };
    api.getAdminSources.mockResolvedValue({ items: [legacy] });
    api.enableSourceMultiDeviceMode.mockResolvedValue({});
    let finishJoin!: (value: { members: string[] }) => void;
    api.joinSourceMember.mockReturnValue(
      new Promise((resolve) => {
        finishJoin = resolve;
      }),
    );
    await act(async () => render(h(AddSourceModal, { onClose: vi.fn(), onAdded }), host));
    await settleEffects();

    await chooseAndContinue("maya@example.com");
    expect(api.enableSourceMultiDeviceMode).not.toHaveBeenCalled();
    const enableButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Enable replicated mode"),
    ) as HTMLButtonElement;
    await act(async () => enableButton.click());

    expect(api.enableSourceMultiDeviceMode).toHaveBeenCalledWith(
      "notes-synth:maya@example.com",
      "replicated",
    );
    expect(api.joinSourceMember).toHaveBeenCalledWith(
      "notes-synth:maya@example.com",
      "fresh",
      undefined,
    );
    expect(onAdded).not.toHaveBeenCalled();
    finishJoin({ members: ["owner", "fresh"] });
    await settleEffects();
    expect(onAdded).toHaveBeenCalledWith(["notes-synth:maya@example.com"]);
    expect(api.addSource).not.toHaveBeenCalled();
  });

  test("a successful mode upgrade is reported even when the following join fails", async () => {
    render(null, host);
    const legacy = { ...accountA, multiDeviceMode: "exclusive", joinCandidates: [] };
    api.getAdminSources.mockResolvedValue({ items: [legacy] });
    api.enableSourceMultiDeviceMode.mockResolvedValue({});
    api.joinSourceMember.mockRejectedValue(new Error("synthetic join refusal"));
    await act(async () => render(h(AddSourceModal, { onClose: vi.fn(), onAdded }), host));
    await settleEffects();

    await chooseAndContinue("maya@example.com");
    const enableButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Enable replicated mode"),
    ) as HTMLButtonElement;
    await act(async () => enableButton.click());
    await settleEffects();

    expect(onAdded).toHaveBeenCalledWith(["notes-synth:maya@example.com"]);
    expect(host.textContent).toContain(
      "replicated mode was enabled, but Studio-Mini could not join: synthetic join refusal",
    );
  });
});
