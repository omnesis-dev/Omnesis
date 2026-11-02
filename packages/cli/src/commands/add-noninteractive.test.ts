// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis sources add` with no terminal — automation, an agent, `ssh` without
 * a tty. Nothing is prompted: what the descriptor asks for comes from
 * `--set` / `--config` / `--account`, and an answer nobody gave fails the run,
 * non-zero, naming the flag that supplies it. A prompt a terminal user
 * cancels fails the run too.
 */

import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseSourceKey } from "@omnesis/core";
import {
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  type SerializedDescriptor,
} from "../utils.js";
import type { AddFlowDeps } from "./add.js";
import type { UnionDescriptor } from "../device-picker.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const mocks = vi.hoisted(() => ({
  fetchDescriptors: vi.fn(),
  fetchSourcesSnapshot: vi.fn(),
  gatewayJson: vi.fn(),
  gatewayFetch: vi.fn(),
  pathInput: vi.fn(),
  runAuthFlowDetailed: vi.fn(),
  isTTY: false,
}));

vi.mock("../auth-flow.js", () => ({ runAuthFlowDetailed: mocks.runAuthFlowDetailed }));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  fetchDescriptors: mocks.fetchDescriptors,
  fetchSourcesSnapshot: mocks.fetchSourcesSnapshot,
  gatewayJson: mocks.gatewayJson,
  gatewayFetch: mocks.gatewayFetch,
  pathInput: mocks.pathInput,
  withSpinner: (_label: string, operation: (spin: { message(value: string): void }) => unknown) =>
    operation({ message: () => undefined }),
}));

const studio = { id: "dev-studio", name: "Studio-Mini" };
const devices: AdminDeviceEntry[] = [{ ...studio, kind: "collector", online: true }];

function descriptor(id: string, extra: Partial<SerializedDescriptor> = {}): SerializedDescriptor {
  return {
    id,
    name: `Synthetic ${id}`,
    description: `${id} source`,
    provider: { id: id.split("-")[0], name: "Synth" },
    authType: "local",
    hasAuthFlow: false,
    hasDiscover: false,
    singleInstance: false,
    multiDeviceMode: "exclusive",
    ...extra,
  } as unknown as SerializedDescriptor;
}

/** A vault-like source: one required, machine-local folder that names the account. */
const vault = descriptor("vault-synth", {
  hasResolveAccountId: true,
  params: [
    {
      name: "vaultPath",
      label: "Vault path",
      type: "path",
      required: true,
      scope: "member",
      placeholder: "/path/to/vault",
    },
    { name: "note", label: "Note", type: "string" },
  ],
});
/** A notes-app-like source: the collector discovers its accounts. */
const notes = descriptor("notes-synth", { hasDiscover: true });
/** A mail-like source: an OAuth sign-in behind a provider-wide application credential. */
const mail = descriptor("mail-synth", {
  authType: "oauth",
  hasAuthFlow: true,
  hasDiscover: true,
  credentials: {
    fileKey: "mailco",
    required: true,
    publicClient: false,
    perAccount: false,
    fields: [
      { name: "client_id", label: "Client ID" },
      { name: "client_secret", label: "Client secret", secret: true },
    ],
    wizard: { intro: "", why: "", estMinutes: 1, steps: [] },
  },
} as Partial<SerializedDescriptor>);
/** A self-hosted-server-like source: the credential is the account. */
const photos = descriptor("photos-synth", {
  authType: "api-key",
  hasAuthFlow: true,
  credentials: {
    fileKey: "photos-synth",
    required: true,
    publicClient: false,
    perAccount: true,
    fields: [
      { name: "base_url", label: "Server URL" },
      { name: "api_key", label: "API key", secret: true },
    ],
    wizard: { intro: "", why: "", estMinutes: 1, steps: [] },
  },
} as Partial<SerializedDescriptor>);

function union(descs: SerializedDescriptor[], hosts = [studio]): UnionDescriptor[] {
  return descs.map((d) => ({ ...d, devices: hosts })) as unknown as UnionDescriptor[];
}

function fakePrompts() {
  return {
    autocompleteMultiselect: vi.fn(
      async ({ initialValues }: { initialValues?: string[] }) => initialValues ?? [],
    ),
    select: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    isCancel: (value: unknown) => typeof value === "symbol",
    cancel: vi.fn(),
    intro: () => undefined,
  } as unknown as typeof import("@clack/prompts");
}

interface Scenario {
  descs?: SerializedDescriptor[];
  sourceArg?: string;
  interactive?: boolean;
  supplied?: Record<string, string>;
  accounts?: string[];
  sources?: AdminSourceEntry[];
  prompts?: ReturnType<typeof fakePrompts>;
  hosts?: Array<{ id: string; name: string }>;
}

async function runAdd(s: Scenario): Promise<void> {
  const { runMultiCollectorAddFlow } = await import("./add.js");
  const descs = s.descs ?? [vault];
  mocks.fetchDescriptors.mockResolvedValue({
    deviceId: studio.id,
    collectorHostname: "studio.example",
    items: descs,
  });
  const deps: AddFlowDeps = {
    prompts: s.prompts ?? fakePrompts(),
    resolve,
    join,
    parseSourceKey,
    joinConfirmation: s.interactive ? "ask" : "no-terminal",
    interactive: s.interactive ?? false,
    supplied: s.supplied ?? {},
    ...(s.accounts ? { accounts: s.accounts } : {}),
    reconnectWaitMs: 0,
  };
  await runMultiCollectorAddFlow(
    union(descs, s.hosts),
    { sources: s.sources ?? [], devices },
    s.sourceArg,
    undefined,
    deps,
  );
}

/** The calls the add made to one gateway path, with their bodies parsed. */
function bodies(path: string): Record<string, unknown>[] {
  return mocks.gatewayJson.mock.calls
    .filter(([p]) => p === path)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function failure(run: Promise<void>): Promise<{ exitCode: number; message: string }> {
  try {
    await run;
  } catch (err) {
    const e = err as { exitCode: number; message: string };
    return { exitCode: e.exitCode, message: stripVTControlCharacters(e.message) };
  }
  throw new Error("expected the add to fail");
}

let logged: string[];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logged.push(stripVTControlCharacters(String(line)));
  });
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    logged.push(stripVTControlCharacters(String(line)));
  });
  mocks.fetchSourcesSnapshot.mockResolvedValue({ deviceId: studio.id, configured: {} });
  mocks.gatewayJson.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/admin/sources/validate-param") return { valid: true };
    if (path === "/admin/sources/resolve-account") return { accountId: "field-notes-1a2b" };
    if (path === "/admin/sources/discover") return { accounts: ["maya@example.com"] };
    if (path.startsWith("/admin/credentials/")) return { ok: true };
    if (path.startsWith("/admin/credentials")) {
      return { deviceId: studio.id, hostname: "studio.example", items: credentialItems };
    }
    if (path === "/admin/sources/add") {
      const ids = body.accountIds as string[];
      return { sourceIds: ids.map((a) => `${String(body.descriptorId)}:${a}`) };
    }
    throw new Error(`unexpected path ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.gatewayJson.mockReset();
  mocks.pathInput.mockReset();
  mocks.runAuthFlowDetailed.mockReset();
  credentialItems = [];
});

let credentialItems: Array<Record<string, unknown>> = [];

describe("settings with no terminal", () => {
  test("a required setting nobody gave fails non-zero, naming the flag, before anything is sent", async () => {
    const result = await failure(runAdd({ sourceArg: "vault-synth" }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("vault-synth needs a value that this run has no terminal");
    expect(result.message).toContain("--set vaultPath=/path/to/vault");
    expect(mocks.pathInput).not.toHaveBeenCalled();
    expect(bodies("/admin/sources/validate-param")).toEqual([]);
    expect(bodies("/admin/sources/add")).toEqual([]);
  });

  test("--set settings go through validate, resolve and add — the portal's own calls", async () => {
    await runAdd({ sourceArg: "vault-synth", supplied: { vaultPath: "/srv/field-notes" } });

    expect(bodies("/admin/sources/validate-param")).toEqual([
      {
        deviceId: studio.id,
        descriptorId: "vault-synth",
        paramName: "vaultPath",
        value: "/srv/field-notes",
      },
      // The optional setting nobody gave is answered the way Enter answers it.
      { deviceId: studio.id, descriptorId: "vault-synth", paramName: "note", value: "" },
    ]);
    expect(bodies("/admin/sources/resolve-account")).toEqual([
      {
        deviceId: studio.id,
        descriptorId: "vault-synth",
        params: { vaultPath: "/srv/field-notes", note: "" },
      },
    ]);
    expect(bodies("/admin/sources/add")).toEqual([
      {
        deviceId: studio.id,
        descriptorId: "vault-synth",
        accountIds: ["field-notes-1a2b"],
        params: { vaultPath: "/srv/field-notes", note: "" },
      },
    ]);
    expect(logged.join("\n")).toContain("added successfully");
    expect(mocks.pathInput).not.toHaveBeenCalled();
  });

  test("a key the source does not declare is refused before the collector is asked anything", async () => {
    const result = await failure(runAdd({ sourceArg: "vault-synth", supplied: { vault: "/x" } }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain('has no setting named "vault"');
    expect(mocks.gatewayJson).not.toHaveBeenCalledWith(
      "/admin/sources/validate-param",
      expect.anything(),
    );
  });

  test("a path the collector refuses fails the run with the collector's reason", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") {
        return { valid: false, error: "Not an Obsidian-style vault: no settings directory" };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result = await failure(
      runAdd({ sourceArg: "vault-synth", supplied: { vaultPath: "/srv/plain-folder" } }),
    );
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("no settings directory");
  });

  test("a gateway refusing the add fails the run", async () => {
    const { CliError } = await import("../utils.js");
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") return { valid: true };
      if (path === "/admin/sources/resolve-account") return { accountId: "field-notes-1a2b" };
      throw new CliError("Gateway 409 /admin/sources/add: already configured", EXIT_USER_ERROR);
    });
    const result = await failure(
      runAdd({ sourceArg: "vault-synth", supplied: { vaultPath: "/srv/field-notes" } }),
    );
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(result.message).toContain("Failed to add source");
  });
});

describe("pickers with no terminal", () => {
  test("no source named: refused with the types there are, and where to read one", async () => {
    const result = await failure(runAdd({ descs: [vault, notes] }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("Name the source to add");
    expect(result.message).toContain("Sources: vault-synth, notes-synth");
    expect(result.message).toContain("omnesis sources describe <type>");
  });

  test("a provider with several sources is refused with the ones to choose from", async () => {
    const a = descriptor("multi-mail", { provider: { id: "multi", name: "Multi" } });
    const b = descriptor("multi-calendar", { provider: { id: "multi", name: "Multi" } });
    const prompts = fakePrompts();
    const result = await failure(runAdd({ descs: [a, b], sourceArg: "multi", prompts }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("multi offers several sources: multi-mail, multi-calendar");
    expect(prompts.select).not.toHaveBeenCalled();
  });

  test("one account found is added, and said so", async () => {
    const prompts = fakePrompts();
    await runAdd({ descs: [notes], sourceArg: "notes-synth", prompts });
    expect(prompts.autocompleteMultiselect).not.toHaveBeenCalled();
    expect(logged.join("\n")).toContain(
      "Found one notes-synth account: maya@example.com. Adding it.",
    );
    expect(bodies("/admin/sources/add")[0]).toMatchObject({ accountIds: ["maya@example.com"] });
  });

  test("several accounts found are refused, one --account per account named", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") {
        return { accounts: ["maya@example.com", "jamie@example.org"] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const result = await failure(runAdd({ descs: [notes], sourceArg: "notes-synth" }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("found 2 notes-synth accounts");
    expect(result.message).toContain("--account maya@example.com");
    expect(result.message).toContain("--account jamie@example.org");
  });

  test("--account chooses among them, and an account the collector did not find is refused", async () => {
    const discovered = { accounts: ["maya@example.com", "jamie@example.org"] };
    mocks.gatewayJson.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/admin/sources/discover") return discovered;
      if (path === "/admin/sources/add") {
        const body = JSON.parse(String(init?.body)) as { accountIds: string[] };
        return { sourceIds: body.accountIds.map((a) => `notes-synth:${a}`) };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await runAdd({ descs: [notes], sourceArg: "notes-synth", accounts: ["jamie@example.org"] });
    expect(bodies("/admin/sources/add")[0]).toMatchObject({ accountIds: ["jamie@example.org"] });

    const result = await failure(
      runAdd({ descs: [notes], sourceArg: "notes-synth", accounts: ["david@example.io"] }),
    );
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("found no notes-synth account david@example.io");
    expect(result.message).toContain("It found: maya@example.com, jamie@example.org");
  });

  test("--account on a source that discovers no accounts is refused", async () => {
    const result = await failure(
      runAdd({ sourceArg: "vault-synth", supplied: { vaultPath: "/v" }, accounts: ["x"] }),
    );
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("--account does not apply");
  });

  test("several collectors hosting the source: refused, naming --device and the choices", async () => {
    const { pickDeviceForDescriptor } = await import("../device-picker.js");
    const result = await failure(
      pickDeviceForDescriptor({
        id: "vault-synth",
        devices: [studio, { id: "dev-laptop", name: "Maya-Laptop" }],
      }),
    );
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("Re-run with --device <name>");
    expect(result.message).toContain("Studio-Mini, Maya-Laptop");
  });
});

describe("credentials with no terminal", () => {
  test("a missing application credential is refused, naming its keys and `creds set`", async () => {
    credentialItems = [
      { fileKey: "mailco", providerName: "Synth", configured: false, spec: mail.credentials },
    ];
    const result = await failure(runAdd({ descs: [mail], sourceArg: "mail-synth" }));
    expect(result.exitCode).toBe(EXIT_USER_ERROR);
    expect(result.message).toContain("the collector has no Synth application credentials yet");
    expect(result.message).toContain("--set client_id=");
    expect(result.message).toContain("--set client_secret=");
    expect(result.message).toContain("omnesis creds set mailco");
    expect(mocks.runAuthFlowDetailed).not.toHaveBeenCalled();
  });

  test("given with --set, the application credential is saved and the sign-in runs", async () => {
    credentialItems = [
      { fileKey: "mailco", providerName: "Synth", configured: false, spec: mail.credentials },
    ];
    mocks.runAuthFlowDetailed.mockResolvedValue({ accountId: "maya@example.com" });
    // No account is signed in on the collector yet, so the add signs one in.
    const base = mocks.gatewayJson.getMockImplementation()!;
    mocks.gatewayJson.mockImplementation(async (path: string, init?: RequestInit) =>
      path === "/admin/sources/discover" ? { accounts: [] } : base(path, init),
    );
    await runAdd({
      descs: [mail],
      sourceArg: "mail-synth",
      supplied: { client_id: "fictional-id.example", client_secret: "fictional-secret" },
    });
    expect(bodies("/admin/credentials/mailco")).toEqual([
      {
        deviceId: studio.id,
        fields: { client_id: "fictional-id.example", client_secret: "fictional-secret" },
      },
    ]);
    expect(mocks.runAuthFlowDetailed).toHaveBeenCalledWith(
      expect.anything(),
      "mail-synth",
      {},
      expect.objectContaining({ interactive: false }),
    );
    expect(bodies("/admin/sources/add")[0]).toMatchObject({ accountIds: ["maya@example.com"] });
  });

  test("an application credential already set up is not replaced by an add", async () => {
    credentialItems = [
      { fileKey: "mailco", providerName: "Synth", configured: true, spec: mail.credentials },
    ];
    mocks.runAuthFlowDetailed.mockResolvedValue({ accountId: "maya@example.com" });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/credentials")) {
        return { deviceId: studio.id, hostname: "studio.example", items: credentialItems };
      }
      if (path === "/admin/sources/discover") return { accounts: [] };
      if (path === "/admin/sources/add") return { sourceIds: ["mail-synth:maya@example.com"] };
      throw new Error(`unexpected path ${path}`);
    });
    await runAdd({
      descs: [mail],
      sourceArg: "mail-synth",
      supplied: { client_id: "other-id", client_secret: "other-secret" },
    });
    expect(bodies("/admin/credentials/mailco")).toEqual([]);
    expect(logged.join("\n")).toContain(
      "already set up on this collector, so the ones given are not used",
    );
  });

  test("an account credential nobody gave is refused; given, it goes to the sign-in unsaved", async () => {
    credentialItems = [
      {
        fileKey: "photos-synth",
        providerName: "Synth",
        configured: false,
        spec: photos.credentials,
      },
    ];
    const refused = await failure(runAdd({ descs: [photos], sourceArg: "photos-synth" }));
    expect(refused.exitCode).toBe(EXIT_USER_ERROR);
    expect(refused.message).toContain("--set base_url=");
    expect(refused.message).toContain("--config @file");

    mocks.runAuthFlowDetailed.mockResolvedValue({ accountId: "photos.example.com" });
    await runAdd({
      descs: [photos],
      sourceArg: "photos-synth",
      supplied: { base_url: "https://photos.example.com", api_key: "fictional-key" },
    });
    expect(mocks.runAuthFlowDetailed).toHaveBeenCalledWith(
      expect.anything(),
      "photos-synth",
      {},
      expect.objectContaining({
        credentials: { base_url: "https://photos.example.com", api_key: "fictional-key" },
      }),
    );
    expect(bodies("/admin/credentials/photos-synth")).toEqual([]);
  });

  test("a sign-in that ends without an account fails the run", async () => {
    credentialItems = [
      { fileKey: "mailco", providerName: "Synth", configured: true, spec: mail.credentials },
    ];
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/credentials")) {
        return { deviceId: studio.id, hostname: "studio.example", items: credentialItems };
      }
      if (path === "/admin/sources/discover") return { accounts: [] };
      throw new Error(`unexpected path ${path}`);
    });
    mocks.runAuthFlowDetailed.mockResolvedValue({ errorMessage: "denied" });
    const result = await failure(runAdd({ descs: [mail], sourceArg: "mail-synth" }));
    expect(result.exitCode).toBe(EXIT_FAILURE);
  });
});

describe("on a terminal", () => {
  test("an unanswered setting is still asked, and a cancelled prompt fails as cancelled", async () => {
    mocks.pathInput.mockResolvedValue(Symbol("cancel"));
    const prompts = fakePrompts();
    const result = await failure(runAdd({ sourceArg: "vault-synth", interactive: true, prompts }));
    expect(mocks.pathInput).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Vault path", placeholder: "/path/to/vault" }),
    );
    expect(result.exitCode).toBe(EXIT_CANCELLED);
    expect(prompts.cancel).toHaveBeenCalledWith("Cancelled.");
  });

  test("a setting given with --set is not asked again; the rest are", async () => {
    const prompts = fakePrompts();
    (prompts.text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("from the prompt");
    await runAdd({
      sourceArg: "vault-synth",
      interactive: true,
      prompts,
      supplied: { vaultPath: "/srv/field-notes" },
    });
    expect(mocks.pathInput).not.toHaveBeenCalled();
    expect(prompts.text).toHaveBeenCalledTimes(1);
    expect(bodies("/admin/sources/add")[0]).toMatchObject({
      params: { vaultPath: "/srv/field-notes", note: "from the prompt" },
    });
  });

  test("several accounts are offered in the picker, as before", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/admin/sources/discover")
        return { accounts: ["maya@example.com", "jamie@example.org"] };
      if (path === "/admin/sources/add") {
        const body = JSON.parse(String(init?.body)) as { accountIds: string[] };
        return { sourceIds: body.accountIds.map((a) => `notes-synth:${a}`) };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const prompts = fakePrompts();
    (prompts.autocompleteMultiselect as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      "jamie@example.org",
    ]);
    await runAdd({ descs: [notes], sourceArg: "notes-synth", interactive: true, prompts });
    expect(prompts.autocompleteMultiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Found 2 accounts. Which would you like to add?" }),
    );
    expect(bodies("/admin/sources/add")[0]).toMatchObject({ accountIds: ["jamie@example.org"] });
  });
});

describe("a collector that is restarting", () => {
  test("a named device that is paired but offline is waited for, then the add goes on", async () => {
    const { ensureDeviceConnected } = await import("./add.js");
    let now = 0;
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce([{ ...studio, kind: "collector", online: false }])
      .mockResolvedValueOnce([{ ...studio, kind: "collector", online: false }])
      .mockResolvedValue([{ ...studio, kind: "collector", online: true }]);
    await ensureDeviceConnected(studio, 60_000, {
      listDevices,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(listDevices.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("an online device costs one look; one that never connects is refused by name", async () => {
    const { ensureDeviceConnected } = await import("./add.js");
    const online = vi.fn().mockResolvedValue([{ ...studio, kind: "collector", online: true }]);
    await ensureDeviceConnected(studio, 60_000, {
      listDevices: online,
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(online).toHaveBeenCalledTimes(1);

    let now = 0;
    const result = await failure(
      ensureDeviceConnected(studio, 10_000, {
        listDevices: vi.fn().mockResolvedValue([{ ...studio, kind: "collector", online: false }]),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    );
    expect(result.exitCode).toBe(EXIT_FAILURE);
    expect(result.message).toContain("Studio-Mini is paired but has not connected");
  });

  test("a source no connected collector offers waits for an offline collector to come back", async () => {
    const { awaitOfflineCollectors } = await import("./add.js");
    let now = 0;
    const fetchUnion = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway restarting"))
      .mockResolvedValueOnce([])
      .mockResolvedValue(union([vault]));
    const listing = {
      sources: [],
      devices: [{ ...studio, kind: "collector", online: false }] as AdminDeviceEntry[],
    };
    const latest = await awaitOfflineCollectors([], listing, "vault-synth", 60_000, {
      fetchUnion,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(latest.map((d) => d.id)).toEqual(["vault-synth"]);
    // Online collectors only, or no collectors at all: nothing to wait for.
    const noWait = vi.fn();
    await awaitOfflineCollectors([], { sources: [], devices }, "vault-synth", 60_000, {
      fetchUnion: noWait,
      sleep: vi.fn(),
      now: () => 0,
    });
    expect(noWait).not.toHaveBeenCalled();
  });
});
