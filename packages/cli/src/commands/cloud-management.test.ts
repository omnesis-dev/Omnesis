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
import { formatCloudStatus, INVITE_ONLY_LINE } from "./cloud-status.js";
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
test("all controls use authenticated common admin API and print what they did with the status", async () => {
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
      // Only status lets the gateway ask the relay whether accounts are invite-only.
      `/admin/cloud-relay${action === "status" ? "?signup=1" : `/${action}`}`,
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
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay?signup=1", {});
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
  // Listing sign-ins is a local read: it never lets the gateway ask the relay anything.
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
  expect(printed()).toContain("--revoke-devices");
  output.mockClear();
  // With --revoke-devices the gateway also revokes the devices that joined with it.
  for (const [revokedDevices, line] of [
    [["fictional-device"], "1 device that joined with it was revoked."],
    [["one", "two"], "2 devices that joined with it were revoked."],
    [[], "No paired device had joined with it."],
  ] as const) {
    gatewayJson.mockImplementation(async (path: string) =>
      path.startsWith("/admin/cloud-relay/trusted-sign-ins/")
        ? { deviceEnrollment: { policy: "automatic" }, revokedDevices }
        : {},
    );
    await runCommand(cloudManagementCommands["remove-sign-in"], {
      rawArgs: ["passkey-id", "--revoke-devices"],
    });
    expect(gatewayJson).toHaveBeenCalledWith(
      "/admin/cloud-relay/trusted-sign-ins/passkey-id?revokeDevices=true",
      { method: "DELETE" },
    );
    expect(printed()).toContain(line);
    output.mockClear();
  }
  gatewayJson.mockImplementation(async () => ({ deviceEnrollment: { policy: "automatic" } }));
  await listTrustedSignIns();
  expect(printed()).toBe("No trusted sign-ins. New devices wait for your approval.\n");
  output.mockClear();
  await runCommand(cloudManagementCommands.policy, { rawArgs: ["automatic"] });
  expect(printed()).toContain("New devices join when you sign in to your Omnesis account");
});
test("trusted sign-ins say whether, and how, the owner confirmed each on this gateway", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation(async () => ({
    deviceEnrollment: {
      policy: "automatic",
      trustedSignIns: [
        { type: "passkey", id: "passkey-one", addedAt: Date.UTC(2028, 0, 3), source: "link-page" },
        {
          type: "google",
          id: "google-two",
          addedAt: Date.UTC(2028, 0, 4),
          source: "countersigned",
        },
      ],
      confirmedSignIns: [
        {
          type: "passkey",
          id: "passkey-one",
          at: Date.UTC(2028, 0, 5) / 1000,
          via: "gateway-origin",
        },
        {
          type: "passkey",
          id: "passkey-three",
          at: Date.UTC(2028, 0, 6) / 1000,
          via: "android-app",
        },
        { type: "passkey", id: "passkey-four", at: Date.UTC(2028, 0, 7) / 1000, via: "later" },
      ],
    },
  }));
  await listTrustedSignIns();
  expect(String(output.mock.calls[0]![0]).split("\n")).toEqual([
    "passkey-one  passkey, signed in on the Omnesis account page, added 2028-01-03T00:00:00.000Z, confirmed on this gateway's own page 2028-01-05T00:00:00.000Z",
    "google-two  Google account, already on the account when a passkey trusted here was added, signed for by that passkey, added 2028-01-04T00:00:00.000Z, not confirmed on this gateway",
    "passkey-three  passkey, confirmed in the Android app 2028-01-06T00:00:00.000Z",
    "passkey-four  passkey, confirmed 2028-01-07T00:00:00.000Z",
    "",
  ]);
});
test("status says whether new devices can join yet: only once a sign-in is confirmed here", () => {
  expect(
    formatCloudStatus({ deviceEnrollment: { policy: "automatic", confirmationNeeded: true } }),
  ).toContain(
    "  New devices:            join automatically once a sign-in is confirmed here; until then each waits for approval\n",
  );
  expect(
    formatCloudStatus({ deviceEnrollment: { policy: "automatic", confirmationNeeded: false } }),
  ).toContain("  New devices:            join automatically with a sign-in confirmed here\n");
});
test("enrollment reads bounded private invitation JSON, never a token in command history or output", async () => {
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
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runCommand(cloudManagementCommands.configure, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/configure", {
    method: "POST",
    body: JSON.stringify({ termsAccepted: false }),
  });
});
/** Replies to the status reads and the connect POST, in the order the command makes them. */
function gatewayReplies(...replies: unknown[]) {
  gatewayJson.mockImplementation(async (path: string) =>
    path === "/admin/cloud-relay?signup=1" || path.endsWith("/connect") ? replies.shift() : {},
  );
}
/** What a gateway that never connected reports before connecting starts. */
const ready = {
  config: { acmeTermsUrl: "https://letsencrypt.org/repository/" },
  account: { linked: false },
};
const waiting = {
  connect: {
    state: "waiting",
    connectUrl: "https://relay.example.test/_relay/connect",
    code: "ABCD-EF23",
  },
};
// What a freshly linked gateway reports: nothing was chosen, so new devices join automatically.
const done = {
  connect: { state: "done" },
  deviceEnrollment: { policy: "automatic" },
  publicOrigin: "https://g-fictional.relay.example.test",
  publicMcp: { url: "https://g-fictional.relay.example.test/mcp" },
};
const paths = () => gatewayJson.mock.calls.map(([path]) => path);
const connectBody = () =>
  JSON.parse(
    String(
      (
        gatewayJson.mock.calls.find(([path]) => path === "/admin/cloud-relay/connect")![1] as {
          body: string;
        }
      ).body,
    ),
  ) as unknown;
const printed = (output: { mock: { calls: unknown[][] } }) =>
  output.mock.calls.map(([value]) => String(value)).join("");

test("without a terminal, connect needs --existing or --invite and contacts no gateway without one", async () => {
  terminal(false);
  for (const rawArgs of [[], ["--accept-terms"]])
    await expect(runCommand(cloudManagementCommands.connect, { rawArgs })).rejects.toThrow(
      "pass --existing to sign in to an Omnesis account you already have, or --invite '<link>' to create one",
    );
  await expect(
    connectGateway({ existing: true, invite: "https://relay.example.test/invite#abc" }),
  ).rejects.toThrow("Pass --existing or --invite, not both");
  expect(gatewayJson).not.toHaveBeenCalled();
});

test("an interactive connect asks whether there is an account, states the certificate terms, and shows each step", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(true);
  answers.push("y");
  gatewayReplies(
    ready,
    waiting,
    waiting,
    { connect: { state: "registering", step: "registering" } },
    { connect: { state: "registering", step: "certificate" } },
    { connect: { state: "registering", step: "certificate" } },
    { connect: { state: "registering", step: "tunnel" } },
    { connect: { state: "linking" } },
    done,
  );
  await runCommand(cloudManagementCommands.connect, { rawArgs: [] });
  expect(question.mock.calls.map(([prompt]) => prompt)).toEqual([
    "Do you already have an Omnesis account? [y/N] ",
  ]);
  expect(connectBody()).toEqual({ termsAccepted: true, intent: "existing" });
  expect(paths()).not.toContain("/admin/cloud-relay/enrollment");
  const text = printed(output);
  expect(text).toContain(
    "By connecting, you agree to Let's Encrypt's Subscriber Agreement: https://letsencrypt.org/repository/\n",
  );
  expect(text.match(/enter ABCD-EF23/g)).toHaveLength(1);
  expect(text).toContain("https://relay.example.test/_relay/connect");
  // One line per step, in order, each said once.
  const steps = [
    "Waiting for you to sign in to your Omnesis account…",
    "Signed in.",
    "Registering this gateway with the Omnesis relay…",
    "Getting this gateway's certificate from Let's Encrypt. This usually takes under a minute…",
    "Opening the connection…",
    "Linking this gateway to your Omnesis account…",
    "Connected to your Omnesis account.",
  ];
  for (const step of steps) expect(text.split(step), step).toHaveLength(2);
  expect(steps.map((step) => text.indexOf(step))).toEqual(
    steps.map((step) => text.indexOf(step)).sort((a, b) => a - b),
  );
  // Then where the gateway is now.
  expect(text).toContain(
    "  Address: https://g-fictional.relay.example.test\n  Portal:  https://g-fictional.relay.example.test/portal/\n  MCP:     https://g-fictional.relay.example.test/mcp\n",
  );
  expect(text).toContain(
    "New devices join when you sign in to your Omnesis account with a sign-in this gateway trusts.",
  );
  expect(text).toContain("choose Ask me first under Settings > Connectivity, New devices");
});

test("answering no on an invite-only relay says how to use an invite and starts nothing", async () => {
  terminal(true);
  for (const answer of ["", "n", "no"]) {
    gatewayJson.mockClear();
    answers.push(answer);
    gatewayReplies(ready, { ...ready, signup: { inviteOnly: true } });
    await expect(connectGateway({})).rejects.toThrow(INVITE_ONLY_LINE);
    expect(paths()).toEqual(["/admin/cloud-relay?signup=1", "/admin/cloud-relay?signup=1"]);
  }
  // A relay that takes new accounts without an invite creates one.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  answers.push("n");
  gatewayReplies(ready, ready, waiting, done);
  await connectGateway({});
  expect(connectBody()).toEqual({ termsAccepted: true, intent: "create" });
});

test("--existing and --invite run unattended, and --accept-terms changes nothing", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(ready, waiting, done);
  await runCommand(cloudManagementCommands.connect, { rawArgs: ["--existing", "--accept-terms"] });
  expect(connectBody()).toEqual({ termsAccepted: true, intent: "existing" });
  gatewayJson.mockClear();
  gatewayReplies(ready, waiting, done);
  const link = "https://relay.example.test/invite#fictional.invite.token";
  await runCommand(cloudManagementCommands.connect, { rawArgs: ["--invite", link] });
  expect(connectBody()).toEqual({ termsAccepted: true, intent: "create", invite: link });
  expect(question).not.toHaveBeenCalled();
});

test("a gateway already linked to an account is told to unlink first, before connecting starts", async () => {
  terminal(false);
  gatewayReplies({ ...ready, account: { linked: true } });
  await expect(connectGateway({ existing: true })).rejects.toThrow(
    "This gateway is already connected to an Omnesis account. To connect it to another, run `omnesis cloud unlink` first.",
  );
  expect(paths()).toEqual(["/admin/cloud-relay?signup=1"]);
  // A gateway linked meanwhile refuses the connect itself, in the same words.
  gatewayJson.mockImplementation(async (path: string) => {
    if (path.endsWith("/connect"))
      throw new Error('Gateway 409 /admin/cloud-relay/connect: {"code":"already-connected"}');
    return ready;
  });
  await expect(connectGateway({ existing: true })).rejects.toThrow(
    "run `omnesis cloud unlink` first",
  );
});

test("a chosen new account that already existed is said, with the invite left unused", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(ready, waiting, { ...done, connect: { state: "done", existingAccount: true } });
  await connectGateway({ invite: "https://relay.example.test/invite#fictional.invite.token" });
  expect(printed(output)).toContain(
    "Connected to your Omnesis account.\nYou already had an Omnesis account, so this gateway is now linked to it. Your invite wasn't used.\n",
  );
  // Said here, the portal is told not to say it again.
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/connect/acknowledge", {
    method: "POST",
    body: "{}",
  });
  // A gateway that can't record it still connected, and the command still succeeds.
  gatewayJson.mockImplementation(async (path: string) => {
    if (path.endsWith("/acknowledge")) throw new Error("Gateway 503");
    return path === "/admin/cloud-relay?signup=1"
      ? ready
      : { ...done, connect: { state: "done", existingAccount: true } };
  });
  await connectGateway({ invite: "https://relay.example.test/invite#fictional.invite.token" });
  output.mockClear();
  gatewayJson.mockClear();
  gatewayReplies(ready, waiting, done);
  await connectGateway({ invite: "https://relay.example.test/invite#fictional.invite.token" });
  expect(printed(output)).not.toContain("Your invite wasn't used");
  expect(paths()).not.toContain("/admin/cloud-relay/connect/acknowledge");
});

test("connect prints the relay's short address in place of its own when the gateway reports one", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(
    ready,
    {
      connect: { ...waiting.connect, connectShortUrl: "https://front.example.test/connect" },
    },
    done,
  );
  await connectGateway({ existing: true });
  const text = printed(output);
  expect(text).toContain(
    "On any device, visit https://front.example.test/connect\nand enter ABCD-EF23",
  );
  expect(text).not.toContain("/_relay/connect");
});

test("--ask-first opts out of automatic joining; a flag that matches the gateway writes nothing, and an earlier choice is reported, not reset", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  for (const args of [
    ["--existing", "--ask-first"],
    ["--existing", "--ask-first", "--automatic"],
  ]) {
    gatewayJson.mockClear();
    output.mockClear();
    gatewayReplies(ready, { connect: { state: "waiting" } }, done);
    await runCommand(cloudManagementCommands.connect, { rawArgs: args });
    expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/enrollment", {
      method: "PUT",
      body: JSON.stringify({ policy: "ask" }),
    });
    expect(printed(output)).toContain("New devices will wait for your approval.");
  }
  for (const args of [["--existing"], ["--existing", "--automatic"]]) {
    gatewayJson.mockClear();
    gatewayReplies(ready, done);
    await runCommand(cloudManagementCommands.connect, { rawArgs: args });
    expect(paths()).toEqual(["/admin/cloud-relay?signup=1", "/admin/cloud-relay/connect"]);
  }
  // A gateway whose owner already chose ask keeps it, and the CLI says so.
  const asking = { connect: { state: "done" }, deviceEnrollment: { policy: "ask" } };
  gatewayJson.mockClear();
  output.mockClear();
  gatewayReplies(ready, asking);
  await connectGateway({ existing: true });
  expect(paths()).not.toContain("/admin/cloud-relay/enrollment");
  expect(printed(output)).toContain("New devices will wait for your approval.");
  gatewayJson.mockClear();
  gatewayReplies(ready, asking);
  await connectGateway({ existing: true, policy: "automatic" });
  expect(gatewayJson).toHaveBeenLastCalledWith("/admin/cloud-relay/enrollment", {
    method: "PUT",
    body: JSON.stringify({ policy: "automatic" }),
  });
  // A gateway that reports no enrollment state or address gets no claim about either.
  gatewayJson.mockClear();
  output.mockClear();
  gatewayReplies({}, { connect: { state: "done" } });
  await connectGateway({ existing: true });
  expect(paths()).toEqual(["/admin/cloud-relay?signup=1", "/admin/cloud-relay/connect"]);
  expect(printed(output)).toBe("Connected to your Omnesis account.\n");
  expect(question).not.toHaveBeenCalled();
});

test("a failed or vanished connection reports why and sets no policy", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(ready, waiting, { connect: { state: "failed", error: "signup-denied" } });
  await expect(connectGateway({ existing: true, policy: "automatic" })).rejects.toThrow(
    "could not connect to your Omnesis account (signup-denied)",
  );
  gatewayReplies(ready, {});
  await expect(connectGateway({ existing: true, policy: "automatic" })).rejects.toThrow(
    "could not connect to your Omnesis account (unknown)",
  );
  expect(paths()).not.toContain("/admin/cloud-relay/enrollment");
});

test("creating an account on an invite-only relay without an invite says once that it needs one", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(true);
  const signup = { inviteOnly: true };
  const line = `${INVITE_ONLY_LINE}\n`;
  // The relay's answer arrived only once connecting started.
  answers.push("n");
  gatewayReplies(ready, ready, waiting, { ...waiting, signup }, { ...waiting, signup }, done);
  await connectGateway({});
  expect(output.mock.calls.filter(([text]) => text === line)).toHaveLength(1);
  // Someone who brought an invite, or signs in to an account they have, needs no telling.
  for (const options of [{ invite: "https://relay.example.test/invite#abc" }, { existing: true }]) {
    output.mockClear();
    gatewayReplies(ready, { ...waiting, signup }, { ...done, signup });
    await connectGateway(options);
    expect(output.mock.calls.filter(([text]) => text === line)).toHaveLength(0);
  }
});

test("connect --invite names each way the invite can be refused", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  const link = "https://relay.example.test/invite#fictional.invite.token";
  for (const [code, words] of [
    ["invite-invalid", "The invite isn't valid: check that you copied the whole link."],
    ["invite-expired", "The invite has expired: ask for a new one."],
    ["invite-used", "The invite was already used to create an account: ask for a new one."],
  ] as const) {
    // Refused by the gateway's check before connecting starts…
    gatewayJson.mockImplementation(async (path: string) => {
      if (path.endsWith("/connect")) throw new Error(`Gateway answered 400: ${code}`);
      return ready;
    });
    await expect(connectGateway({ invite: link })).rejects.toThrow(words);
    // …or by the relay when the sign-up started.
    gatewayReplies(ready, waiting, { connect: { state: "failed", error: code } });
    await expect(connectGateway({ invite: link })).rejects.toThrow(
      `could not connect to your Omnesis account (${code}). Nothing changed on this gateway's existing access. ${words}`,
    );
  }
  gatewayJson.mockImplementation(async (path: string) => {
    if (path.endsWith("/connect")) throw new Error("Gateway answered 503");
    return ready;
  });
  await expect(connectGateway({ invite: link })).rejects.toThrow("503");
  gatewayReplies(ready, waiting, { connect: { state: "failed", error: "not-allowed" } });
  await expect(connectGateway({ existing: true })).rejects.toThrow(
    "could not connect to your Omnesis account (not-allowed). Nothing changed on this gateway's existing access.",
  );
  gatewayReplies(ready, waiting, { connect: { state: "failed" } });
  await expect(connectGateway({ existing: true })).rejects.toThrow("(unknown)");
});

test("status says when the relay creates new accounts only with an invite", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation(async (path) =>
    path === "/health" ? { version: "1.2.3" } : { enabled: false, signup: { inviteOnly: true } },
  );
  await manageCloud("status");
  expect(String(output.mock.calls[0]![0])).toContain(
    "  Sign-up:                invite-only: a new account needs an invite link\n",
  );
  for (const status of [{ enabled: false }, { enabled: false, signup: { inviteOnly: "yes" } }]) {
    output.mockClear();
    gatewayJson.mockImplementation(async (path) => (path === "/health" ? {} : status));
    await manageCloud("status");
    expect(String(output.mock.calls[0]![0])).not.toContain("Sign-up");
  }
});

test("connect prints the independent security check once, then continues to ordinary sign-in", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  const verification = {
    url: "https://dns.example.test/_dns/v2/enroll?ticket=fictional",
    expiresAt: Date.now() + 60_000,
  };
  gatewayReplies(
    ready,
    { connect: { state: "waiting", verification } },
    { connect: { state: "waiting", verification } },
    waiting,
    done,
  );
  await connectGateway({ existing: true });
  const text = printed(output);
  expect(text.split(verification.url)).toHaveLength(2);
  expect(text).toContain("No approval from Omnesis is needed");
  expect(text).toContain("ABCD-EF23");
  expect(text.indexOf(verification.url)).toBeLessThan(text.indexOf("ABCD-EF23"));
  expect(text).toContain("Connected to your Omnesis account.");
});

test("connect refuses malformed browser check links without printing them", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  for (const url of [
    "javascript:alert(1)",
    "https://dns.example.test/not-enrollment?ticket=fictional",
    "https://dns.example.test/_dns/v2/enroll?ticket=one&ticket=two",
  ]) {
    gatewayReplies(ready, {
      connect: { state: "waiting", verification: { url, expiresAt: Date.now() + 60_000 } },
    });
    await expect(connectGateway({ existing: true })).rejects.toThrow(
      "security check link was refused",
    );
    expect(printed(output)).not.toContain(url);
  }
});

test("start-over discards an unfinished connection, and a connected gateway is pointed to unlink", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation(async (path: string) =>
    path === "/health" ? { version: "1.2.3" } : { enabled: false, configured: false },
  );
  await runCommand(cloudManagementCommands["start-over"], { rawArgs: [] });
  expect(gatewayJson).toHaveBeenCalledWith("/admin/cloud-relay/start-over", {
    method: "POST",
    body: "{}",
  });
  expect(printed(output)).toContain(
    "The unfinished connection is discarded. This gateway is as if it had never connected",
  );
  gatewayJson.mockImplementation(async () => {
    throw new Error('Gateway 409 /admin/cloud-relay/start-over: {"code":"already-connected"}');
  });
  await expect(runCommand(cloudManagementCommands["start-over"], { rawArgs: [] })).rejects.toThrow(
    "there is no unfinished connection to discard. To leave your Omnesis account, run `omnesis cloud unlink`.",
  );
});

test("status says when connecting didn't finish, why, and both ways on", () => {
  expect(formatCloudStatus({ unfinished: {} })).toContain(
    "  Connecting:             didn't finish, it was interrupted. Run `omnesis cloud connect` to try again, or `omnesis cloud start-over` to discard it\n",
  );
  expect(formatCloudStatus({ unfinished: { error: "enrollment-refused" } })).toContain(
    "didn't finish (enrollment-refused). Run `omnesis cloud connect`",
  );
  expect(formatCloudStatus({})).not.toContain("Connecting:");
});

test("another authority's certificate step names none, and an address the gateway reports badly is not printed", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  terminal(false);
  gatewayReplies(
    { account: { linked: false } },
    { connect: { state: "registering", step: "certificate" } },
    { ...done, publicOrigin: "https://[not-an-address", publicMcp: undefined },
  );
  await connectGateway({ existing: true });
  let text = printed(output);
  expect(text).toContain("Getting this gateway's certificate. This usually takes under a minute…");
  expect(text).not.toContain("Let's Encrypt");
  expect(text).not.toContain("Address:");
  // Without an MCP address of its own, the gateway's MCP path is at its address.
  output.mockClear();
  gatewayReplies(ready, {
    ...done,
    publicOrigin: "https://g-fictional.relay.example.test",
    publicMcp: {},
  });
  await connectGateway({ existing: true });
  text = printed(output);
  expect(text).toContain("  MCP:     https://g-fictional.relay.example.test/mcp\n");
  // Only an https address without credentials is printed.
  for (const publicOrigin of [
    "http://g-fictional.relay.example.test",
    "https://user:secret@g-fictional.relay.example.test",
  ]) {
    output.mockClear();
    gatewayReplies(ready, { ...done, publicOrigin, publicMcp: {} });
    await connectGateway({ existing: true });
    expect(printed(output)).not.toContain("Address:");
  }
});

test("start-over passes any other failure on unchanged", async () => {
  gatewayJson.mockImplementation(async () => {
    throw new Error("Gateway 503 /admin/cloud-relay/start-over: unavailable");
  });
  await expect(runCommand(cloudManagementCommands["start-over"], { rawArgs: [] })).rejects.toThrow(
    "Gateway 503",
  );
});
