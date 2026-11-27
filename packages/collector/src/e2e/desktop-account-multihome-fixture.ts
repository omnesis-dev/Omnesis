// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { hostedGatewayHostname } from "@omnesis/cloud-relay";
import { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";
import { installDesktopAccountBridge } from "./desktop-account-bridge.js";
import { joinedRequest } from "./desktop-account-mixed-fixture.js";
import {
  RELAY_HOST,
  signInOnThisMachine,
  type EnrollmentGateway,
  type PasskeySession,
} from "./account-enrollment-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";
import { gatewayBootBudgetMs } from "./gateway-env.js";

export interface AccountHome {
  id: string;
  origin: string;
  request(path: string, options?: { method: "POST"; body: unknown }): Promise<unknown>;
}
interface Device {
  id: string;
  online: boolean;
}
interface Comparison {
  requestId: string;
  status: string;
  verificationCode: string;
}

export async function accountHome(
  fixture: DesktopRuntimeFixture,
  dataPort: number,
): Promise<AccountHome> {
  const status = (await fixture.request("/admin/cloud-relay")) as { gatewayId: string };
  return {
    id: status.gatewayId,
    origin: `https://${hostedGatewayHostname(status.gatewayId, RELAY_HOST)}:${dataPort}`,
    request: (path, options) => fixture.request(path, options),
  };
}
export function sourceAccountHome(gateway: EnrollmentGateway): AccountHome {
  return {
    id: gateway.gatewayId,
    origin: gateway.publicOrigin,
    request: (path, options) =>
      gateway.json(
        path,
        options ? { method: options.method, body: JSON.stringify(options.body) } : undefined,
      ),
  };
}
export async function homeRoster(home: AccountHome) {
  const devices = (await home.request("/admin/devices")) as { items: Device[] };
  const requests = (await home.request("/admin/cloud-pairing/requests")) as { items: Comparison[] };
  return {
    devices: devices.items.map((value) => value.id).sort(),
    requests: requests.items.map((value) => value.requestId).sort(),
  };
}
/** Grants persist across restart; transient request history may expire or be discarded. */
export async function assertHomeRosterUnchanged(
  home: AccountHome,
  before: Awaited<ReturnType<typeof homeRoster>>,
) {
  const after = await homeRoster(home);
  expect(after.devices).toEqual(before.devices);
  expect(after.requests.filter((requestId) => !before.requests.includes(requestId))).toEqual([]);
}

export async function createAccountJoinedFixture(relayUrl: string, owned: DesktopRuntimeFixture[]) {
  const fixture = await DesktopRuntimeFixture.create({
    prepareInstall: false,
    systemTrustRuntime: true,
    relayUrl,
  });
  owned.push(fixture);
  await installDesktopAccountBridge(fixture, {});
  return fixture;
}

/** Read only assertion metadata through the production encrypted reader; never serialize credentials. */
export async function joinedRoleMetadata(fixture: DesktopRuntimeFixture) {
  const module = new URL("../../../cli/src/desktop/coordinator-runtime.ts", import.meta.url).href;
  return JSON.parse(
    await fixture.script(`
    const {join}=await import('node:path');
    const {lstat}=await import('node:fs/promises');
    const {desktopCoordinatorDefaults:defaults}=await import(${JSON.stringify(module)});
    const options={configDir:profile.configDir,service:profile.secretService,backend:'macos-keychain'};
    const result={};
    for(const [role,file] of [['interactive','cli-device.json'],['collector','collector-device.json']]){
      const path=join(profile.configDir,'cloud-relay',file);
      const exists=await lstat(path).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!exists){result[role]=null;continue;}
      const pair=await defaults.readPair(path,options);
      result[role]=pair?{gatewayUrl:pair.gatewayUrl,deviceId:pair.deviceId,kind:pair.kind,scopes:pair.scopes,...(pair.tlsSpkiFingerprint===undefined?{gatewayFingerprint:pair.gatewayFingerprint}:{tlsSpkiFingerprint:pair.tlsSpkiFingerprint})}:null;
    }
    process.stdout.write(JSON.stringify(result));
  `),
  ) as {
    interactive: {
      gatewayUrl: string;
      deviceId: string;
      kind: string;
      scopes: string[];
      gatewayFingerprint?: string;
      tlsSpkiFingerprint?: string;
    } | null;
    collector: {
      gatewayUrl: string;
      deviceId: string;
      kind: string;
      scopes: string[];
      gatewayFingerprint?: string;
      tlsSpkiFingerprint?: string;
    } | null;
  };
}

export async function assertJoinedOnly(fixture: DesktopRuntimeFixture) {
  expect(
    JSON.parse(await readFile(join(fixture.profile.configDir, "desktop-install.json"), "utf8")),
  ).toMatchObject({ mode: "joined" });
  expect(
    await lstat(join(fixture.profile.configDir, "omnesis.db")).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }),
  ).toBeNull();
}

/** One visible home choice, then two independent real approvals at that exact home. */
export async function connectExactAccountHome(
  fixture: DesktopRuntimeFixture,
  owner: PasskeySession,
  relayOrigin: string,
  homes: readonly AccountHome[],
  selected: AccountHome,
  offline = false,
) {
  let choices = 0,
    comparisons = 0;
  const state = await fixture.interactiveCommand("connect", undefined, async (interaction) => {
    if (interaction.kind === "openBrowser") {
      expect(new URL(String(interaction.url)).origin).toBe(relayOrigin);
      await signInOnThisMachine(owner, String(interaction.url));
      return "continue";
    }
    if (interaction.kind === "chooseGateway") {
      choices++;
      expect(choices).toBe(1);
      const offered = interaction.choices as { id: string }[];
      expect(offered.map((choice) => choice.id).sort()).toEqual(
        homes.map((home) => home.id).sort(),
      );
      expect(new Set(offered.map((choice) => choice.id)).size).toBe(2);
      return selected.id;
    }
    if (interaction.kind === "compareCode") {
      expect(offline).toBe(false);
      let requestId: string | undefined;
      await waitForCondition(
        async () => {
          const pending = (await selected.request("/admin/cloud-pairing/requests")) as {
            items: Comparison[];
          };
          const matches = pending.items.filter(
            (item) => item.status === "pending" && item.verificationCode === interaction.code,
          );
          expect(matches.length).toBeLessThanOrEqual(1);
          requestId = matches[0]?.requestId;
          return requestId !== undefined;
        },
        20_000,
        "the selected home's exact role comparison",
      );
      await selected.request("/admin/cloud-pairing/decision", {
        method: "POST",
        body: { requestId, approve: true },
      });
      comparisons++;
      return "approve";
    }
    throw new Error("Unexpected multiple-home enrollment interaction");
  });
  expect(choices).toBe(1);
  if (offline) {
    expect({ phase: state.phase, connection: state.connection === undefined }).toEqual({
      phase: "error",
      connection: true,
    });
    expect(comparisons).toBe(0);
    expect(await joinedRoleMetadata(fixture)).toEqual({ interactive: null, collector: null });
  } else {
    expect({ phase: state.phase, mode: state.mode, encrypted: state.encrypted }).toEqual({
      phase: "ready",
      mode: "joined",
      encrypted: true,
    });
    expect(comparisons).toBe(2);
    const roles = await joinedRoleMetadata(fixture);
    expect(roles.interactive?.gatewayUrl).toBe(selected.origin);
    expect(roles.collector?.gatewayUrl).toBe(selected.origin);
    expect(roles.interactive?.deviceId).not.toBe(roles.collector?.deviceId);
    expect(roles.interactive?.kind).toBe("cli");
    expect(roles.collector?.kind).toBe("collector");
    expect(roles.interactive?.scopes).toEqual(expect.arrayContaining(["admin", "read"]));
    expect(roles.collector?.scopes).toEqual(expect.arrayContaining(["read", "write:*"]));
    expect(roles.collector?.tlsSpkiFingerprint ?? roles.collector?.gatewayFingerprint).toBe(
      roles.interactive?.tlsSpkiFingerprint ?? roles.interactive?.gatewayFingerprint,
    );
    expect(await joinedRequest(fixture, "/whoami")).toMatchObject({
      deviceId: roles.interactive!.deviceId,
    });
    await waitForCondition(
      async () => {
        const devices = (await selected.request("/admin/devices")) as { items: Device[] };
        return devices.items.some(
          (device) => device.id === roles.collector!.deviceId && device.online,
        );
      },
      30_000,
      "the selected home's authenticated collector",
    );
  }
  await assertJoinedOnly(fixture);
}

export async function expectAccountPresence(
  owner: PasskeySession,
  relayOrigin: string,
  homes: readonly AccountHome[],
  offline: AccountHome,
) {
  await owner.page.goto(`${relayOrigin}/_relay/account`);
  await waitForCondition(
    async () => {
      for (const home of homes) {
        const row = owner.page.locator(".gateway-item", { hasText: new URL(home.origin).hostname });
        if (
          (await row.count()) !== 1 ||
          (await row.locator(".presence").textContent()) !==
            (home.id === offline.id ? "Offline" : "Online")
        ) {
          await owner.page.evaluate(() => {
            for (const state of ["hidden", "visible"]) {
              Object.defineProperty(document, "visibilityState", {
                value: state,
                configurable: true,
              });
              document.dispatchEvent(new Event("visibilitychange"));
            }
          });
          return false;
        }
      }
      return true;
    },
    30_000,
    "the real two-home account's online and offline rows",
  );
}

/** Callback errors cannot skip the harness's actual restart or erase restart failures. */
export async function whileAccountHomeStopped(
  gateway: EnrollmentGateway,
  work: () => Promise<void>,
) {
  let failed = false,
    failure: unknown;
  try {
    await gateway.harness.restartGateway(async () => {
      try {
        await work();
      } catch (error) {
        failed = true;
        failure = error;
      }
    });
    await waitForCondition(
      async () => (await gateway.status()).tunnel.state === "online",
      gatewayBootBudgetMs(),
      "the same home tunnel after restart",
    );
  } catch (restartFailure) {
    if (failed)
      throw new AggregateError(
        [failure, restartFailure],
        "The offline assertion and owned home restart failed",
        { cause: restartFailure },
      );
    throw restartFailure;
  }
  if (failed) throw failure;
}
