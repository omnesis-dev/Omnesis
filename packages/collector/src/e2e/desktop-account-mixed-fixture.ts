// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";

/** Only OS credential storage is substituted; the ordinary source gateway opens real encrypted stores. */
export function protectedSourceGateway(
  adapter: Pick<DesktopRuntimeFixture, "root" | "environment" | "script">,
) {
  let configDir: string | undefined;
  const service =
    "dev.omnesis.fixture." +
    createHash("sha256")
      .update(adapter.root + "/source-gateway")
      .digest("hex");
  return {
    extraEnv: {
      PATH: adapter.environment.PATH,
      OMNESIS_SECRET_STORE: "macos-keychain",
      OMNESIS_SECRET_SERVICE: service,
    },
    prepareGateway: async (harness: { getGatewayConfigDirectory(): string }) => {
      configDir = harness.getGatewayConfigDirectory();
      await adapter.script(`
        const {ensureInstallRootKey,markSecretFileEncryptionRequired,markStorageEncryptionRequired}=await import('@omnesis/core');
        const {writeFile}=await import('node:fs/promises');
        const {join}=await import('node:path');
        const configDir=${JSON.stringify(configDir)},options={configDir,service:${JSON.stringify(service)},backend:'macos-keychain'};
        // Exercise the real configured disabled assignments, rather than relying on model defaults.
        await writeFile(join(configDir,'omnesis.json'),JSON.stringify({inference:{
          assignments:{embedder:null,agent:null,transcriber:null,'background-agent':null},
          recordings:{speakers:'off'}
        }}),{mode:0o600,flag:'wx'});
        const root=await ensureInstallRootKey(options);
        if(!root.valid||!root.store.secure)throw new Error('The owned source gateway credential adapter refused protection');
        await markSecretFileEncryptionRequired(configDir,options);
        await markStorageEncryptionRequired(configDir,options);
      `);
    },
    readGatewayToken: async (directory: string) => {
      if (directory !== configDir)
        throw new Error("The source gateway credential directory changed");
      const token: unknown = JSON.parse(
        await adapter.script(`
        const {readSecretTextFile}=await import('@omnesis/core');
        process.stdout.write(JSON.stringify(await readSecretTextFile(${JSON.stringify(join(directory, "token"))},{configDir:${JSON.stringify(directory)},service:${JSON.stringify(service)},backend:'macos-keychain'})));
      `),
      );
      if (token === null) return null;
      if (typeof token !== "string")
        throw new Error("The source gateway token reader returned invalid metadata");
      return token.trim() || null;
    },
  };
}

/** Exercise the saved Desktop interactive grant over its real independently pinned transport. */
export async function joinedRequest(
  fixture: DesktopRuntimeFixture,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const runtime = new URL("../../../cli/src/desktop/coordinator-runtime.ts", import.meta.url).href;
  return JSON.parse(
    await fixture.script(`
    const {join}=await import('node:path');
    const {desktopCoordinatorDefaults:defaults}=await import(${JSON.stringify(runtime)});
    const pairing=await defaults.readPair(join(profile.configDir,'cloud-relay','cli-device.json'),{configDir:profile.configDir,service:profile.secretService,backend:'macos-keychain'});
    const transport=await defaults.startTransport(profile);
    try {
      const signal=AbortSignal.timeout(15000);
      await defaults.verifyTransport(transport,pairing,signal);
      const response=await fetch(new URL(${JSON.stringify(path)},transport.url),{
        method:${JSON.stringify(options.method ?? "GET")},
        headers:{authorization:'Bearer '+pairing.token,'content-type':'application/json'},
        ${options.body === undefined ? "" : `body:JSON.stringify(${JSON.stringify(options.body)}),`}
        signal,redirect:'error'
      });
      if(!response.ok)throw new Error('The verified joined gateway refused the fixture operation');
      const text=await response.text();
      if(text.length>1048576)throw new Error('The joined fixture response exceeded its bound');
      process.stdout.write(JSON.stringify(JSON.parse(text)));
    } finally {await transport.close();}
  `),
  );
}

/** Fixed public UI branches only; a new/raw message is never a diagnostic payload. */
export function desktopAccountFailureCode(message: unknown): string {
  switch (message) {
    case "Your account could not connect. Check your internet connection and try again.":
      return "account-connect-failed";
    case "Omnesis could not finish this step. Unlock your Mac and try again.":
    case "Omnesis could not finish this step. Try again to check the current status.":
      return "coordinator-step-failed";
    case "That invitation code was not accepted. Check the code and try again.":
      return "invite-invalid";
    case "That invitation has expired. Ask for a new invitation and try again.":
      return "invite-expired";
    case "That invitation has already been used. Sign in to your existing account or use a new invitation.":
      return "invite-used";
    case "Account sign-in expired. Start sign-in again.":
      return "expired";
    case "The connection service is busy. Try again in a moment.":
      return "capacity";
    default:
      return "unknown";
  }
}

/** Content-free fixture observation; never retain names, messages, URLs, credentials or causes. */
export function desktopAccountProgress(value: unknown) {
  const record = (raw: unknown): Record<string, unknown> =>
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const fixed = (raw: unknown, allowed: readonly string[]) =>
    typeof raw === "string" && allowed.includes(raw) ? raw : "unknown";
  const errors = [
    "relay-service-unavailable",
    "relay-service-mismatch",
    "configuration-invalid",
    "dns-verification-required",
    "dns-capacity",
    "dns-allocation-rate",
    "relay-unreachable",
    "invite-invalid",
    "invite-expired",
    "invite-used",
    "invitation-required",
    "enrollment-refused",
    "hostname-required",
    "hostname-conflict",
    "ca-terms-required",
    "operation-in-progress",
    "already-connected",
    "google-unavailable",
    "google-link-failed",
    "account-unavailable",
    "account-link-failed",
    "tunnel-disconnected",
    "certificate-setup-failed",
    "certificate-renewal-failed",
    "public-endpoint-unreachable",
    "passkey-origin-unavailable",
    "passkey-not-confirmed",
    "passkey-not-on-account",
    "not-allowed",
    "capacity",
    "expired",
  ];
  const error = (raw: unknown) => (raw === undefined ? "none" : fixed(raw, errors));
  const raw = record(value),
    connect = record(raw.connect),
    enrollment = record(raw.enrollment),
    tunnel = record(raw.tunnel),
    certificate = record(raw.certificate),
    account = record(raw.account);
  return {
    linked: typeof account.linked === "boolean" ? account.linked : null,
    connect: fixed(connect.state, ["idle", "waiting", "registering", "linking", "done", "failed"]),
    step: fixed(connect.step, ["registering", "certificate", "tunnel"]),
    connectError: error(connect.error),
    enrollment: fixed(enrollment.state, ["unconfigured", "pending", "enrolled", "failed"]),
    enrollmentError: error(enrollment.error),
    tunnel: fixed(tunnel.state, ["disabled", "offline", "connecting", "online"]),
    tunnelError: error(tunnel.lastError),
    certificate: fixed(certificate.state, [
      "unconfigured",
      "bootstrap",
      "valid",
      "expiring",
      "expired",
      "failed",
    ]),
    certificateError: error(certificate.lastError),
  };
}
