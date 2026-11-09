// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `omnesis cloud status` in plain text: the record of this gateway's Omnesis
// account link and remote access. The portal page shows only what a person
// acts on, so this is where the rest is read, and what is pasted when asking
// for help. It prints public facts only: no token, key or invitation is in the
// gateway's status.

import type { CloudRelayManagementStatus } from "@omnesis/cloud-relay";

/** What the gateway reports. Every field is optional here: an older gateway may omit some. */
export type CloudStatus = Partial<Omit<CloudRelayManagementStatus, "deviceEnrollment">> & {
  deviceEnrollment?: {
    policy?: string;
    trustedSignIns?: { type?: string; id?: string; addedAt?: number; source?: string }[];
  };
};

function iso(value: string | number | undefined): string {
  if (value === undefined || value === "") return "not recorded";
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "not recorded";
}

/** One printable value: status is data from the gateway, never terminal control or layout. */
function plain(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value
    ? value.replace(/[^\x20-\x7e]+/g, " ").slice(0, 300)
    : fallback;
}

const SIGN_IN_SOURCES: Record<string, string> = {
  "link-page": "signed in on the Omnesis account page",
  approval: "signed in on the Omnesis account page, trusted when a device was approved",
  "native-app": "signed in in the app, trusted when a device was approved",
  endorsed: "passkey added to the account, confirmed by a sign-in trusted here",
};

/** One line per trusted sign-in. The id is what `omnesis cloud remove-sign-in` takes. */
export function trustedSignInLines(status: CloudStatus): string[] {
  return (status.deviceEnrollment?.trustedSignIns ?? []).map((signIn) => {
    const source = Object.hasOwn(SIGN_IN_SOURCES, signIn.source ?? "")
      ? SIGN_IN_SOURCES[signIn.source!]
      : "source not recorded";
    return `${plain(signIn.id)}  ${signIn.type === "passkey" ? "passkey" : "Google account"}, ${source}, added ${iso(signIn.addedAt)}`;
  });
}

/** Every error code the gateway reports, with where it came from. */
function errors(status: CloudStatus): string[] {
  const reported: [string, unknown][] = [
    ["connect", status.connect?.error],
    ["registration", status.enrollment?.error],
    ["tunnel", status.tunnel?.lastError],
    ["certificate", status.certificate?.lastError],
    ["address", status.publicMcp?.lastError],
    ["certificate monitor", status.certificateMonitor?.lastError],
    ["service", status.serviceError],
    ["account", status.account?.lastError],
    ["google", status.google?.lastError],
  ];
  const codes = reported
    .filter(([, code]) => typeof code === "string" && code)
    .map(([source, code]) => `${plain(code)} (${source})`);
  if (status.certificate?.state === "expired") codes.push("certificate-expired (certificate)");
  if (status.certificate?.state === "expiring") codes.push("certificate-expiring (certificate)");
  if ((status.certificateMonitor?.incidents?.length ?? 0) > 0)
    codes.push("unexpected-certificate (certificate monitor)");
  return codes;
}

export function formatCloudStatus(status: CloudStatus, version?: string): string {
  const direct = status.identities?.find((identity) => identity.id === "direct");
  const monitor = status.certificateMonitor;
  const account = status.account;
  const address = status.publicMcp;
  const signIns = trustedSignInLines(status);
  const rows: [string, string][] = [
    ["Gateway version", plain(version)],
    ["Error codes", errors(status).join(", ") || "none"],
    ...(status.notice ? [["Notice", plain(status.notice)] as [string, string]] : []),
    ["Remote access", status.enabled ? "on" : "off"],
    [
      "Address",
      `${plain(address?.url, "none")} (${address?.ready ? "answering" : address?.lastError ? "not answering" : "not confirmed"})`,
    ],
    [
      "Registration",
      `${plain(status.enrollment?.state)}, gateway ID ${plain(status.gatewayId, "none")}`,
    ],
    [
      "Tunnel",
      `${plain(status.tunnel?.state)}, last connected ${iso(status.tunnel?.lastConnectedAt)}`,
    ],
    [
      "Public certificate",
      `${plain(status.certificate?.state)}, expires ${iso(status.certificate?.expiresAt)}, last renewed ${iso(status.certificate?.lastRenewedAt)}`,
    ],
    [
      "Home certificate",
      `${plain(direct?.kind)}, ${plain(direct?.state ?? status.directCertificate?.state)}, expires ${iso(direct?.expiresAt ?? status.directCertificate?.expiresAt)}${direct?.names?.length ? `, names ${direct.names.map((name) => plain(name)).join(" ")}` : ""}`,
    ],
    [
      "Certificate monitor",
      `${plain(monitor?.state, "not reported")}, last checked ${iso(monitor?.lastCompletedAt)}`,
    ],
    ...(monitor?.incidents ?? []).map((incident): [string, string] => [
      "Unexpected certificate",
      `name ${plain(incident.hostname)}, public key ${plain(incident.spkiFingerprint)}, certificate ${plain(incident.certificateFingerprint)}, issuer ${plain(incident.issuer)}, serial ${plain(incident.serial)}, valid ${iso(incident.validFrom)} to ${iso(incident.validTo)}, seen ${iso(incident.observedAt)}, log entry ${plain(incident.providerEntryId)}`,
    ]),
    [
      "Account",
      account?.linked || status.google?.linked
        ? "linked"
        : account?.pendingUnlink
          ? "unlinked here, account not updated yet"
          : "not linked",
    ],
    [
      "New devices",
      status.deviceEnrollment?.policy === "ask"
        ? "ask first"
        : status.deviceEnrollment?.policy === "automatic"
          ? "join automatically"
          : "not reported",
    ],
    ["Trusted sign-ins", String(signIns.length)],
    ...signIns.map((line): [string, string] => ["", line]),
    ...(status.recovery
      ? [
          [
            "Recovery receipt",
            `${plain(status.recovery.receipt)}, expires ${iso(status.recovery.expiresAt)}`,
          ] as [string, string],
        ]
      : []),
    ["Relay", plain(status.config?.relayUrl, "none")],
    ["Certificate provider", plain(status.config?.acmeDirectoryUrl, "none")],
  ];
  return (
    "Omnesis account status\n" +
    rows
      .map(([label, value]) => (label ? `  ${`${label}:`.padEnd(24)}${value}` : `    ${value}`))
      .join("\n") +
    "\n"
  );
}
