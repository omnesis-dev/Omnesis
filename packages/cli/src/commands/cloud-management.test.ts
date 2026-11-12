// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { runCommand, type CommandDef } from "citty";
import {
  cloudManagementCommands,
  connectGateway,
  listTrustedSignIns,
  manageCloud,
} from "./cloud-management.js";
import { formatCloudStatus } from "./cloud-status.js";
const { gatewayJson, answers, question } = vi.hoisted(() => {
  const answers: string[] = [];
  return {
    gatewayJson: vi.fn<(path: string, init?: unknown) => Promise<unknown>>(async () => ({
      enabled: false,
    })),
    answers,
    question: vi.fn(async (_prompt: string) => answers.shift() ?? ""),
  };
});
vi.mock("../utils.js", () => ({ gatewayJson }));
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({ question, close: () => {} }),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));
const tty = {
  stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
};
function terminal(interactive: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: interactive, configurable: true });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  gatewayJson.mockReset();
  gatewayJson.mockImplementation(async () => ({ enabled: false }));
  question.mockClear();
  answers.length = 0;
  for (const stream of ["stdin", "stdout"] as const) {
    const descriptor = tty[stream];
    if (descriptor) Object.defineProperty(process[stream], "isTTY", descriptor);
    else delete (process[stream] as { isTTY?: boolean }).isTTY;
  }
});
test("management refuses before reading invitations or accessing a default gateway unless explicitly enabled", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  await expect(manageCloud("status")).rejects.toThrow("OMNESIS_CLOUD_RELAY_ENABLED=1");
  expect(gatewayJson).not.toHaveBeenCalled();
});
test("all controls use authenticated common admin API and print what they did with the status", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const action of [
    "status",
    "configure",
    "enable",
    "disable",
    "reconnect",
    "renew",
  ] as const) {
    if (action === "configure") {
      await runCommand(cloudManagementCommands.configure, {
        rawArgs: [
          "--relay",
          "https://relay.example.test",
          "--origin",
          "https://custom.test",
          "--acme-directory",
          "https://ca.test/directory",
          "--accept-terms",
        ],
      });
    } else if (action === "enable") {
      await runCommand(cloudManagementCommands.enable, { rawArgs: [] });
    } else {
      await runCommand(cloudManagementCommands[action] as CommandDef, { rawArgs: [] });
    }
    expect(gatewayJson).toHaveBeenCalledWith(
      `/admin/cloud-relay${action === "status" ? "" : `/${action}`}`,
      action === "status" ? {} : { method: "POST", body: expect.any(String) },
    );
    // The version is read for context only, after the action.
    expect(gatewayJson).toHaveBeenLastCalledWith("/health");
  }
  output.mockClear();
  await manageCloud("disable");
  expect(output).toHaveBeenCalledTimes(1);
  expect(output.mock.calls[0]![0]).toBe(
    "Remote access is off. This gateway keeps its address and stays in your Omnesis account.\n\n" +
      formatCloudStatus({ enabled: false }),
  );
  output.mockClear();
  await runCommand(cloudManagementCommands.status, { rawArgs: ["--json"] });
  expect(output.mock.calls).toEqual([['{\n  "enabled": false\n}\n']]);
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay", {});
});

const FINGERPRINT = "f".repeat(64);
function troubled() {
  return {
    enabled: true,
    gatewayId: "00000000-0000-4000-8000-000000000001",
    identities: [
      {
        id: "direct",
        names: ["home.example.test", "10.0.0.7"],
        kind: "self-signed",
        state: "valid",
        expiresAt: "2029-01-01T00:00:00Z",
      },
    ],
    config: {
      relayUrl: "https://relay.example.test",
      acmeDirectoryUrl: "https://ca.example.test/directory",
    },
    enrollment: { state: "enrolled", error: "enrollment-refused" },
    tunnel: {
      state: "online",
      lastConnectedAt: "2028-01-01T00:00:00Z",
      lastError: "tunnel-disconnected",
    },
    certificate: {
      state: "expiring",
      expiresAt: "2028-05-01T00:00:00Z",
      lastRenewedAt: "2028-02-01T00:00:00Z",
      lastError: "certificate-renewal-failed",
    },
    publicMcp: {
      ready: false,
      url: "https://northstar.relay.example.test/mcp",
      lastError: "public-endpoint-unreachable",
    },
    certificateMonitor: {
      state: "incident",
      lastCompletedAt: "2028-01-02T00:00:00Z",
      lastError: "ct-provider-unavailable",
      incidents: [
        {
          hostname: "northstar.relay.example.test",
          spkiFingerprint: FINGERPRINT,
          certificateFingerprint: "e".repeat(64),
          issuer: "Fictional test issuer",
          serial: "ABCD",
          validFrom: "2028-01-01T00:00:00Z",
          validTo: "2028-02-01T00:00:00Z",
          observedAt: "2028-01-02T00:00:00Z",
          providerEntryId: "fixture-entry-1",
        },
      ],
    },
    account: { linked: true, pendingUnlink: false, lastError: "account-link-failed" },
    google: { configured: false },
    deviceEnrollment: {
      policy: "ask",
      trustedSignIns: [
        {
          type: "google",
          id: "google:fictional-subject",
          addedAt: Date.UTC(2028, 0, 3),
          source: "native-app",
        },
        {
          type: "passkey",
          id: "passkey:fictional\u001b[31m",
          addedAt: Date.UTC(2028, 0, 5) / 1000,
          source: "future-source",
        },
      ],
    },
    recovery: { receipt: "present", expiresAt: "2030-01-01T00:00:00Z" },
  };
}
test("status prints everything the portal's old connection record showed, as plain text", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation(async (path) =>
    path === "/health" ? { version: "9.8.7" } : troubled(),
  );
  await runCommand(cloudManagementCommands.status, { rawArgs: [] });
  expect(output.mock.calls).toHaveLength(1);
  expect(String(output.mock.calls[0]![0]).split("\n")).toEqual([
    "Omnesis account status",
    "  Gateway version:        9.8.7",
    "  Error codes:            enrollment-refused (registration), tunnel-disconnected (tunnel), certificate-renewal-failed (certificate), public-endpoint-unreachable (address), ct-provider-unavailable (certificate monitor), account-link-failed (account), certificate-expiring (certificate), unexpected-certificate (certificate monitor)",
    "  Remote access:          on",
    "  Address:                https://northstar.relay.example.test/mcp (not answering)",
    "  Registration:           enrolled, gateway ID 00000000-0000-4000-8000-000000000001",
    "  Tunnel:                 online, last connected 2028-01-01T00:00:00.000Z",
    "  Public certificate:     expiring, expires 2028-05-01T00:00:00.000Z, last renewed 2028-02-01T00:00:00.000Z",
    "  Home certificate:       self-signed, valid, expires 2029-01-01T00:00:00.000Z, names home.example.test 10.0.0.7",
    "  Certificate monitor:    incident, last checked 2028-01-02T00:00:00.000Z",
    `  Unexpected certificate: name northstar.relay.example.test, public key ${FINGERPRINT}, certificate ${"e".repeat(64)}, issuer Fictional test issuer, serial ABCD, valid 2028-01-01T00:00:00.000Z to 2028-02-01T00:00:00.000Z, seen 2028-01-02T00:00:00.000Z, log entry fixture-entry-1`,
    "  Account:                linked",
    "  New devices:            ask first",
    "  Trusted sign-ins:       2",
    "    google:fictional-subject  Google account, signed in in the app, trusted when a device was approved, added 2028-01-03T00:00:00.000Z",
    "    passkey:fictional [31m  passkey, source not recorded, added 2028-01-05T00:00:00.000Z",
    "  Recovery receipt:       present, expires 2030-01-01T00:00:00.000Z",
    "  Relay:                  https://relay.example.test",
    "  Certificate provider:   https://ca.example.test/directory",
    "",
  ]);
});
test("status of a gateway that reports almost nothing still prints every line, and a failed version read is not an error", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation(async (path) => {
    if (path === "/health") throw new Error("offline");
    return { account: { linked: false, pendingUnlink: true }, certificate: { state: "expired" } };
  });
  await manageCloud("status");
  const text = String(output.mock.calls[0]![0]);
  expect(text).toContain("  Gateway version:        unknown\n");
  expect(text).toContain("  Error codes:            certificate-expired (certificate)\n");
  expect(text).toContain("  Remote access:          off\n");
  expect(text).toContain("  Address:                none (not confirmed)\n");
  expect(text).toContain("  Tunnel:                 unknown, last connected not recorded\n");
  expect(text).toContain("  Account:                unlinked here, account not updated yet\n");
  expect(text).toContain("  New devices:            not reported\n");
  expect(text).toContain("  Trusted sign-ins:       0\n");
  expect(text).not.toContain("Recovery receipt");
  expect(formatCloudStatus({})).toContain("  Error codes:            none\n");
});
test("the page's remaining actions each have a command: unlink, policy, and listing or removing a trusted sign-in", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const printed = () => output.mock.calls.map((call) => String(call[0])).join("");
  gatewayJson.mockImplementation(async (path) =>
    path === "/health" ? { version: "9.8.7" } : troubled(),
  );
  await runCommand(cloudManagementCommands.unlink, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/account/unlink", {
    method: "POST",
    body: "{}",
  });
  expect(printed()).toContain("This gateway is unlinked from your Omnesis account.");
  expect(printed()).toContain("can no longer be reached from outside your home network");
  output.mockClear();
  await runCommand(cloudManagementCommands.policy, { rawArgs: ["ask"] });
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/enrollment", {
    method: "PUT",
    body: '{"policy":"ask"}',
  });
  expect(printed()).toMatch(
    /^New devices will wait for your approval\.\n\nOmnesis account status\n/,
  );
  gatewayJson.mockClear();
  await expect(
    runCommand(cloudManagementCommands.policy, { rawArgs: ["sometimes"] }),
  ).rejects.toThrow("The policy is automatic or ask");
  expect(gatewayJson).not.toHaveBeenCalled();
  output.mockClear();
  await runCommand(cloudManagementCommands["trusted-sign-ins"], { rawArgs: [] });
  expect(gatewayJson.mock.calls).toEqual([["/admin/cloud-relay"]]);
  expect(printed().split("\n")).toHaveLength(3);
  expect(printed()).toContain("google:fictional-subject  Google account");
  output.mockClear();
  await runCommand(cloudManagementCommands["remove-sign-in"], {
    rawArgs: ["google:subject/with?chars"],
  });
  expect(gatewayJson).toHaveBeenCalledWith(
    "/admin/cloud-relay/trusted-sign-ins/google%3Asubject%2Fwith%3Fchars",
    { method: "DELETE" },
  );
  expect(printed()).toContain("Trusted sign-in removed.");
  output.mockClear();
  gatewayJson.mockImplementation(async () => ({ deviceEnrollment: { policy: "automatic" } }));
  await listTrustedSignIns();
  expect(printed()).toBe("No trusted sign-ins. New devices wait for your approval.\n");
  output.mockClear();
  await runCommand(cloudManagementCommands.policy, { rawArgs: ["automatic"] });
  expect(printed()).toContain("New devices join when you sign in to your Omnesis account");
});
test("every new command refuses before any gateway call unless cloud relay is enabled", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  for (const [name, rawArgs] of [
    ["unlink", []],
    ["policy", ["ask"]],
    ["trusted-sign-ins", []],
    ["remove-sign-in", ["google:fictional-subject"]],
  ] as const)
    await expect(
      runCommand(cloudManagementCommands[name] as CommandDef, { rawArgs: [...rawArgs] }),
    ).rejects.toThrow("OMNESIS_CLOUD_RELAY_ENABLED=1");
  expect(gatewayJson).not.toHaveBeenCalled();
});
test("enrollment reads bounded private invitation JSON, never a token in command history or output", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const directory = await mkdtemp(join(tmpdir(), "cloud-management-cli-")),
    file = join(directory, "invitation.json");
  try {
    await writeFile(file, JSON.stringify({ enrollmentToken: "private-one-use-token" }));
    await runCommand(cloudManagementCommands.enable, { rawArgs: ["--invitation-file", file] });
    expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/enable", {
      method: "POST",
      body: JSON.stringify({ invitation: "private-one-use-token" }),
    });
    expect(output.mock.calls.flat().join()).not.toContain("private-one-use-token");
    for (const value of [
      "x",
      "null",
      "{}",
      '{"enrollmentToken":1}',
      '{"enrollmentToken":""}',
      JSON.stringify({ enrollmentToken: "a".repeat(4097) }),
      "a".repeat(9000),
    ]) {
      await writeFile(file, value);
      await expect(
        runCommand(cloudManagementCommands.enable, { rawArgs: ["--invitation-file", file] }),
      ).rejects.toThrow("Invalid enrollment invitation file");
    }
    await expect(
      runCommand(cloudManagementCommands.enable, {
        rawArgs: ["--invitation-file", join(directory, "missing")],
      }),
    ).rejects.toThrow("Invalid enrollment invitation file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal configure uses the gateway installation service without a relay argument", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCommand(cloudManagementCommands.configure, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/configure", {
    method: "POST",
    body: JSON.stringify({ termsAccepted: false }),
  });
});

/** Replies to the connect POST, then to each status poll, in order. */
function gatewayReplies(...polls: unknown[]) {
  gatewayJson.mockImplementation(async (path: string) =>
    path === "/admin/cloud-relay" || path.endsWith("/connect") ? polls.shift() : {},
  );
}
const waiting = {
  connect: {
    state: "waiting",
    connectUrl: "https://relay.example.test/_relay/connect",
    code: "ABCD-EF23",
  },
};
// What a freshly linked gateway reports: nothing was chosen, so new devices join automatically.
const done = { connect: { state: "done" }, deviceEnrollment: { policy: "automatic" } };
const paths = () => gatewayJson.mock.calls.map(([path]) => path);

test("connect refuses before any gateway call unless cloud relay is enabled, and needs accepted terms without a terminal", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  await expect(connectGateway({ acceptTerms: true })).rejects.toThrow(
    "OMNESIS_CLOUD_RELAY_ENABLED=1",
  );
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  terminal(false);
  await expect(runCommand(cloudManagementCommands.connect, { rawArgs: [] })).rejects.toThrow(
    "--accept-terms",
  );
  expect(gatewayJson).not.toHaveBeenCalled();
});

test("an interactive connect asks only for the terms, prints the code once while waiting, and leaves automatic joining as it is", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(true);
  answers.push("");
  gatewayReplies(
    { connect: { state: "registering" } },
    waiting,
    waiting,
    { connect: { state: "linking" } },
    done,
  );
  await runCommand(cloudManagementCommands.connect, { rawArgs: [] });
  expect(question.mock.calls.map(([prompt]) => prompt)).toEqual([
    "Accept the terms and continue? [Y/n] ",
  ]);
  expect(gatewayJson).toHaveBeenNthCalledWith(1, "/admin/cloud-relay/connect", {
    method: "POST",
    body: JSON.stringify({ termsAccepted: true }),
  });
  expect(paths()).not.toContain("/admin/cloud-relay/enrollment");
  const printed = output.mock.calls.flat().join("");
  expect(printed.match(/enter ABCD-EF23/g)).toHaveLength(1);
  expect(printed).toContain("https://relay.example.test/_relay/connect");
  expect(printed).toContain("Waiting for you to sign in to your Omnesis account");
  expect(printed).toContain(
    "New devices join when you sign in to your Omnesis account with a sign-in this gateway trusts.",
  );
  expect(printed).toContain("choose Ask me first under Settings > Omnesis account");
});

test("connect prints the relay's short address in place of its own when the gateway reports one", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(
    {
      connect: { ...waiting.connect, connectShortUrl: "https://front.example.test/connect" },
    },
    done,
  );
  await connectGateway({ acceptTerms: true });
  const printed = output.mock.calls.flat().join("");
  expect(printed).toContain(
    "On any device, visit https://front.example.test/connect\nand enter ABCD-EF23",
  );
  expect(printed).not.toContain("/_relay/connect");
});

test("declining the terms changes nothing", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  terminal(true);
  answers.push("n");
  await expect(connectGateway({ acceptTerms: false })).rejects.toThrow("Connection cancelled");
  expect(gatewayJson).not.toHaveBeenCalled();
});

test("--ask-first opts out of automatic joining; a flag that matches the gateway writes nothing, and an earlier choice is reported, not reset", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  for (const args of [
    ["--accept-terms", "--ask-first"],
    ["--accept-terms", "--ask-first", "--automatic"],
  ]) {
    gatewayJson.mockClear();
    output.mockClear();
    gatewayReplies({ connect: { state: "waiting" } }, done);
    await runCommand(cloudManagementCommands.connect, { rawArgs: args });
    expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/enrollment", {
      method: "PUT",
      body: JSON.stringify({ policy: "ask" }),
    });
    expect(output.mock.calls.flat().join("")).toContain("New devices will wait for your approval.");
  }
  for (const args of [["--accept-terms"], ["--accept-terms", "--automatic"]]) {
    gatewayJson.mockClear();
    gatewayReplies(done);
    await runCommand(cloudManagementCommands.connect, { rawArgs: args });
    expect(paths()).toEqual(["/admin/cloud-relay/connect"]);
  }
  // A gateway whose owner already chose ask keeps it, and the CLI says so.
  const asking = { connect: { state: "done" }, deviceEnrollment: { policy: "ask" } };
  gatewayJson.mockClear();
  output.mockClear();
  gatewayReplies(asking);
  await connectGateway({ acceptTerms: true });
  expect(paths()).toEqual(["/admin/cloud-relay/connect"]);
  expect(output.mock.calls.flat().join("")).toContain("New devices will wait for your approval.");
  gatewayJson.mockClear();
  gatewayReplies(asking);
  await connectGateway({ acceptTerms: true, policy: "automatic" });
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/enrollment", {
    method: "PUT",
    body: JSON.stringify({ policy: "automatic" }),
  });
  // A gateway that reports no enrollment state gets no claim about it.
  gatewayJson.mockClear();
  output.mockClear();
  gatewayReplies({ connect: { state: "done" } });
  await connectGateway({ acceptTerms: true });
  expect(paths()).toEqual(["/admin/cloud-relay/connect"]);
  expect(output.mock.calls.flat().join("")).toBe("Connected to your Omnesis account.\n");
  expect(question).not.toHaveBeenCalled();
});

test("a failed or vanished connection reports why and sets no policy", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(waiting, { connect: { state: "failed", error: "signup-denied" } });
  await expect(connectGateway({ acceptTerms: true, policy: "automatic" })).rejects.toThrow(
    "could not connect to your Omnesis account (signup-denied)",
  );
  gatewayReplies({});
  await expect(connectGateway({ acceptTerms: true, policy: "automatic" })).rejects.toThrow(
    "could not connect to your Omnesis account (unknown)",
  );
  expect(paths()).not.toContain("/admin/cloud-relay/enrollment");
});
