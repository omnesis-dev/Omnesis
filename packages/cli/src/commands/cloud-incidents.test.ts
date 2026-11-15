// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, expect, test, vi } from "vitest";
import { runCommand, type CommandDef } from "citty";
import { CliError, EXIT_AUTH, EXIT_GATEWAY_ERROR } from "@omnesis/cli-shared";
import { cloudIncidentCommands } from "./cloud-incidents.js";
import { formatCloudStatus, incidentLines } from "./cloud-status.js";

const { gatewayJson } = vi.hoisted(() => ({
  gatewayJson: vi.fn<(path: string, init?: unknown) => Promise<unknown>>(),
}));
vi.mock("../utils.js", () => ({ gatewayJson }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  gatewayJson.mockReset();
});
const ROGUE = "e".repeat(64);
const incident = {
  hostname: "northstar.relay.example.test",
  spkiFingerprint: "f".repeat(64),
  certificateFingerprint: ROGUE,
  issuer: "Fictional test issuer",
  serial: "ABCD",
  validFrom: "2028-01-01T00:00:00Z",
  validTo: "2028-02-01T00:00:00Z",
  observedAt: "2028-01-02T00:00:00Z",
  providerEntryId: "fixture-entry-1",
};
const held = {
  enabled: true,
  incidentHold: { since: "2028-01-02T00:00:00.000Z", certificates: [ROGUE] },
  certificateMonitor: {
    state: "incident",
    incidents: [incident, { ...incident, certificateFingerprint: "1".repeat(64) }],
  },
  deviceEnrollment: { policy: "ask", trustedSignIns: [] },
};
const incidents = cloudIncidentCommands.incidents.subCommands as unknown as Record<
  "list" | "ack",
  CommandDef
>;

test("listing says whether new devices are held and which certificates hold them", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockResolvedValueOnce(held);
  await runCommand(incidents.list, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenCalledExactlyOnceWith("/admin/cloud-relay");
  expect(String(output.mock.calls[0]![0]).split("\n")).toEqual([
    "New devices are held for approval since 2028-01-02T00:00:00.000Z: 1 unexpected certificates. Run `omnesis cloud incidents ack` on the gateway host once you have looked into them.",
    `name northstar.relay.example.test, public key ${"f".repeat(64)}, certificate ${ROGUE}, issuer Fictional test issuer, serial ABCD, valid 2028-01-01T00:00:00.000Z to 2028-02-01T00:00:00.000Z, seen 2028-01-02T00:00:00.000Z, log entry fixture-entry-1, holding new devices`,
    `name northstar.relay.example.test, public key ${"f".repeat(64)}, certificate ${"1".repeat(64)}, issuer Fictional test issuer, serial ABCD, valid 2028-01-01T00:00:00.000Z to 2028-02-01T00:00:00.000Z, seen 2028-01-02T00:00:00.000Z, log entry fixture-entry-1`,
    "",
  ]);
  gatewayJson.mockResolvedValueOnce({ enabled: true });
  await runCommand(incidents.list, { rawArgs: [] });
  expect(output.mock.calls[1]![0]).toBe("No certificate incidents recorded.\n");
  // A hold an older or sparse gateway reports without its list still reads.
  expect(
    incidentLines({ incidentHold: { since: "2028-01-02T00:00:00.000Z" } as never })[0],
  ).toContain(": 0 unexpected certificates.");
});

test("status shows the hold among the error codes and on its own line", () => {
  const text = formatCloudStatus(held as never);
  expect(text).toContain("incident-hold (new devices)");
  expect(text).toContain(
    "  Incident hold:          since 2028-01-02T00:00:00.000Z: every new device waits for approval until `omnesis cloud incidents ack` on the gateway host\n",
  );
  expect(formatCloudStatus({ enabled: true })).not.toContain("Incident hold");
});

test("ack asks the gateway to lift the hold and says what that does, or why the gateway refused", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  gatewayJson.mockImplementation((path) =>
    Promise.resolve(path === "/health" ? { version: "9.8.7" } : { enabled: true }),
  );
  await runCommand(incidents.ack, { rawArgs: [] });
  expect(gatewayJson).toHaveBeenNthCalledWith(1, "/admin/cloud-relay/incidents/ack", {
    method: "POST",
    body: "{}",
  });
  expect(String(output.mock.calls[0]![0])).toMatch(
    /^Certificate incident acknowledged\. New devices follow your new-device setting again\./,
  );
  await runCommand(incidents.ack, { rawArgs: ["--json"] });
  expect(output.mock.calls.at(-1)![0]).toBe(JSON.stringify({ enabled: true }, null, 2) + "\n");

  // Through the relay the gateway refuses, and the CLI says where to run it instead.
  gatewayJson.mockRejectedValue(
    new CliError(
      'Gateway 403 /admin/cloud-relay/incidents/ack: {"code":"local-request-required"}',
      EXIT_AUTH,
    ),
  );
  const refused = await runCommand(incidents.ack, { rawArgs: [] }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(CliError);
  expect((refused as CliError).message).toContain("only be acknowledged on the gateway itself");
  expect((refused as CliError).exitCode).toBe(EXIT_AUTH);
  // Anything else is passed on as it is.
  const other = new CliError(
    "Gateway 503 /admin/cloud-relay/incidents/ack: {}",
    EXIT_GATEWAY_ERROR,
  );
  gatewayJson.mockRejectedValue(other);
  await expect(runCommand(incidents.ack, { rawArgs: [] })).rejects.toBe(other);
});

test("both refuse before any gateway call unless cloud relay is enabled", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  await expect(runCommand(incidents.list, { rawArgs: [] })).rejects.toThrow(
    "OMNESIS_CLOUD_RELAY_ENABLED=1",
  );
  await expect(runCommand(incidents.ack, { rawArgs: [] })).rejects.toThrow(
    "OMNESIS_CLOUD_RELAY_ENABLED=1",
  );
  expect(gatewayJson).not.toHaveBeenCalled();
});
