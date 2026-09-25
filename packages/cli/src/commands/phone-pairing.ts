// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  discoverNetworkIdentities,
  swapHost,
  type AwayFromHomeHint,
  type NetworkIdentity,
  type PairingAddressOption,
  type PairingAddressPlan,
  type PairingPlatform,
} from "@omnesis/core";
import {
  c,
  gatewayFetch,
  gatewayJson,
  GATEWAY_URL,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";

/** What the pairing output calls each phone. */
const PHONE_NOUNS: Record<PairingPlatform, string> = { ios: "iPhone", android: "Android phone" };

type UsableOption = Extract<PairingAddressOption, { usable: true }>;
type RefusedOption = Extract<PairingAddressOption, { usable: false }>;

/**
 * Print the pairing QR for a phone and return the gateway URL it carries.
 *
 * The gateway judges every address it could put in the code for the phone
 * the code was minted for, and refuses to encode one that phone cannot use.
 * With no `--gateway-url` the QR carries the gateway's recommendation; either
 * way the output says where the address works, lists the other usable
 * addresses as `--gateway-url` alternatives, and names the refused ones with
 * the reason, so no printed QR code is bound to fail.
 */
export async function showPhonePairing(opts: {
  platform: PairingPlatform;
  pairingCode: string;
  gatewayUrlFlag?: string;
}): Promise<string> {
  const explicit =
    (opts.gatewayUrlFlag || process.env.OMNESIS_IOS_GATEWAY_URL)?.replace(/\/$/, "") || undefined;
  const plan = await fetchPairingAddressPlan(opts.pairingCode);
  if (!plan) {
    // A gateway without address judgement: discover addresses on this host.
    const url = await pickReachableGatewayUrl(explicit);
    await printQr(await buildPairQrPayload(opts.pairingCode, url));
    return url;
  }

  const phone = PHONE_NOUNS[opts.platform];
  const url = explicit ?? plan.recommendedUrl;
  if (!url) {
    for (const line of refusedLines(refusedOptions(plan), phone)) console.log(line);
    for (const line of awayLines(plan, phone)) console.log(line);
    console.log(`\n${c.dim}This pairing code won't be used; it expires on its own.${c.reset}`);
    throw new CliError(
      `None of this gateway's addresses can be used by an ${phone}, so there is no QR code to scan.`,
      EXIT_USER_ERROR,
    );
  }
  const judged = plan.addresses.find((o) => sameOrigin(o.gatewayUrl, url));
  const encoded =
    judged && !judged.usable
      ? { ok: false as const, reason: judged.reason }
      : await encodePairingQr(opts.pairingCode, url);
  if (!encoded.ok) {
    console.log();
    console.log(`${c.red}No QR code for ${url}:${c.reset} ${encoded.reason}`);
    for (const line of alternativeLines(plan, url, phone)) console.log(line);
    for (const line of awayLines(plan, phone)) console.log(line);
    console.log(`\n${c.dim}This pairing code won't be used; it expires on its own.${c.reset}`);
    throw new CliError("", EXIT_USER_ERROR);
  }
  console.log();
  console.log(`${c.bold}Scan this QR with the Omnesis app on your ${phone}:${c.reset}`);
  const chosen = plan.addresses.find((o) => sameOrigin(o.gatewayUrl, url));
  await printQr(
    encoded.payload,
    chosen?.usable && chosen.systemTrust
      ? { gatewayUrl: url, pairingCode: opts.pairingCode }
      : undefined,
  );
  for (const line of phonePairingLines(plan, url, phone)) console.log(line);
  return url;
}

/**
 * The lines printed under a phone's QR code: where the chosen address works,
 * the other usable addresses, the refused ones, and the away-from-home steps
 * when nothing reaches beyond the local network.
 */
export function phonePairingLines(
  plan: PairingAddressPlan,
  chosenUrl: string,
  phone: string,
): string[] {
  const chosen = usableOptions(plan).find((o) => sameOrigin(o.gatewayUrl, chosenUrl));
  const lines: string[] = [""];
  if (chosen) {
    const dot = chosen.reach === "local-network" ? c.yellow : c.green;
    lines.push(`${dot}●${c.reset} ${chosen.summary}`);
    lines.push(`  ${c.dim}Address: ${chosen.label} · ${chosen.host}${c.reset}`);
  } else {
    lines.push(`  ${c.dim}Address: ${chosenUrl}${c.reset}`);
  }
  lines.push(...alternativeLines(plan, chosenUrl, phone));
  lines.push(...awayLines(plan, phone));
  return lines;
}

/**
 * The usable addresses other than `chosenUrl`, the recommended one marked,
 * then the refused ones other than `chosenUrl`.
 */
function alternativeLines(plan: PairingAddressPlan, chosenUrl: string, phone: string): string[] {
  const others = usableOptions(plan).filter((o) => !sameOrigin(o.gatewayUrl, chosenUrl));
  const lines: string[] = [];
  if (others.length > 0) {
    lines.push(
      "",
      `${c.bold}Other addresses this ${phone} can use${c.reset} ${c.dim}(create a new code with --gateway-url):${c.reset}`,
    );
    for (const option of others) {
      const recommended = option.gatewayUrl === plan.recommendedUrl ? " (recommended)" : "";
      lines.push(`  ${option.label} · ${option.host}${recommended}`);
      lines.push(`    ${c.dim}${option.summary}${c.reset}`);
      lines.push(`    ${c.dim}--gateway-url ${option.gatewayUrl}${c.reset}`);
    }
  }
  const refused = refusedOptions(plan).filter((o) => !sameOrigin(o.gatewayUrl, chosenUrl));
  lines.push(...refusedLines(refused, phone));
  return lines;
}

function refusedLines(refused: RefusedOption[], phone: string): string[] {
  if (refused.length === 0) return [];
  const lines = ["", `${c.bold}Not offered for an ${phone}:${c.reset}`];
  for (const option of refused) {
    lines.push(`  ${option.label} · ${option.host}`);
    lines.push(`    ${c.dim}${option.reason}${c.reset}`);
  }
  return lines;
}

function awayLines(plan: PairingAddressPlan, phone: string): string[] {
  return plan.awayFromHome ? awayFromHomeLines(plan.awayFromHome, plan.platform, phone) : [];
}

/**
 * The steps to reach the gateway away from home. Both phones need the gateway
 * host and the phone on one tailnet; an iPhone also needs a Tailscale
 * certificate, which needs the host's Tailscale name.
 */
function awayFromHomeLines(
  hint: AwayFromHomeHint,
  platform: PairingPlatform | null,
  phone: string,
): string[] {
  const needsCertificate = platform === "ios";
  const steps: string[] = [];
  if (!hint.onTailnet) {
    steps.push(
      `Install Tailscale on the gateway computer and on the ${phone}, and sign both in to the same tailnet.`,
    );
  }
  if (needsCertificate && hint.onTailnet && !hint.tailscaleName) {
    steps.push("Turn on MagicDNS for your tailnet in the Tailscale admin console.");
  }
  if (needsCertificate) {
    steps.push(
      `Turn on HTTPS certificates for your tailnet, then run \`omnesis tls provision\` on the gateway computer. It gets a certificate${hint.tailscaleName ? ` for ${hint.tailscaleName}` : ""} from Tailscale. Any phone you paired before this step will need to pair again.`,
    );
  }
  steps.push("Create a new pairing code and scan it.");
  return [
    "",
    `${c.bold}To use this ${phone} away from home:${c.reset}`,
    ...steps.map((step, i) => `  ${i + 1}. ${step}`),
    `  ${c.dim}https://omnesis.dev/docs/setup#away-from-home${c.reset}`,
  ];
}

function usableOptions(plan: PairingAddressPlan): UsableOption[] {
  return plan.addresses.filter((o): o is UsableOption => o.usable);
}

function refusedOptions(plan: PairingAddressPlan): RefusedOption[] {
  return plan.addresses.filter((o): o is RefusedOption => !o.usable);
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** The gateway's address plan for a code; null when the gateway predates the route. */
async function fetchPairingAddressPlan(pairingCode: string): Promise<PairingAddressPlan | null> {
  const res = await gatewayFetch("/admin/devices/pair-addresses", {
    method: "POST",
    body: JSON.stringify({ pairingCode }),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new CliError(await errorSentence(res), pickGatewayExitCode(res.status));
  }
  return (await res.json()) as PairingAddressPlan;
}

/** Encode a QR payload, or the gateway's plain-language refusal of the address. */
async function encodePairingQr(
  pairingCode: string,
  gatewayUrl: string,
): Promise<{ ok: true; payload: string } | { ok: false; reason: string }> {
  const res = await gatewayFetch("/admin/devices/pair-qr", {
    method: "POST",
    body: JSON.stringify({ pairingCode, gatewayUrl, trustMode: "auto" }),
  });
  if (res.status === 400) return { ok: false, reason: await errorSentence(res) };
  if (!res.ok) throw new CliError(await errorSentence(res), pickGatewayExitCode(res.status));
  return { ok: true, payload: ((await res.json()) as { qrPayload: string }).qrPayload };
}

async function errorSentence(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const envelope = JSON.parse(text) as { error?: unknown };
    if (typeof envelope.error === "string") return envelope.error;
  } catch {
    // Not a JSON envelope: fall through to the raw body.
  }
  return `Gateway ${res.status}: ${text}`;
}

/**
 * Print the QR code, then what a phone that cannot scan enters instead: the
 * payload for the app's Paste JSON sheet, and, when `manualEntry` is given,
 * the gateway URL and pairing code for its Manual entry sheet. Manual entry
 * carries no certificate fingerprint, so it works only where the phone's own
 * trust store accepts the gateway's certificate.
 */
async function printQr(
  payload: string,
  manualEntry?: { gatewayUrl: string; pairingCode: string },
): Promise<void> {
  try {
    const qrTerminal = await import("qrcode-terminal");
    qrTerminal.default.generate(payload, { small: true });
  } catch {
    /* QR lib missing — fall through to the raw payload below */
  }
  console.log(
    `${c.dim}Can't scan the code? In the Omnesis app, choose Paste JSON and paste:${c.reset}`,
  );
  console.log(`${c.dim}  ${payload}${c.reset}`);
  if (manualEntry) {
    console.log(
      `${c.dim}Or choose Manual entry and type the gateway URL ${manualEntry.gatewayUrl} and the pairing code ${manualEntry.pairingCode}.${c.reset}`,
    );
  }
}

/**
 * Encode a pairing QR on a gateway that predates address judgement. Tries the
 * `auto` trust mode first and retries without it only when an even older
 * gateway rejects that field.
 */
export async function buildPairQrPayload(pairingCode: string, gatewayUrl: string): Promise<string> {
  const request = (trustMode?: "auto") =>
    gatewayJson<{ qrPayload: string }>("/admin/devices/pair-qr", {
      method: "POST",
      body: JSON.stringify({ pairingCode, gatewayUrl, ...(trustMode ? { trustMode } : {}) }),
    });
  try {
    return (await request("auto")).qrPayload;
  } catch (error) {
    if (
      !(error instanceof CliError) ||
      !error.message.includes("VALIDATION_ERROR") ||
      !error.message.includes("trustMode")
    ) {
      throw error;
    }
    return (await request()).qrPayload;
  }
}

/**
 * The gateway URL for a QR on a gateway that predates address judgement: the
 * explicit URL, else the configured gateway URL when it is not loopback, else
 * an address discovered on this host (asking when there are several).
 */
async function pickReachableGatewayUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const url = new URL(GATEWAY_URL);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!isLoopback) return GATEWAY_URL;

  const identities = await discoverNetworkIdentities();
  if (identities.length === 0) {
    console.warn(
      `${c.yellow}Could not detect a reachable address — QR will use localhost and will not work from the device.${c.reset}`,
    );
    return GATEWAY_URL;
  }
  const pick = identities.length === 1 ? identities[0]! : await promptHostPick(identities);
  return swapHost(GATEWAY_URL, pick.address);
}

async function promptHostPick(identities: NetworkIdentity[]): Promise<NetworkIdentity> {
  const prompts = await import("@clack/prompts");
  console.log();
  const answer = (await prompts.select({
    message: "Which address should the new device connect to?",
    options: identities.map((id, i) => ({
      value: i,
      label: `${id.address}   ${c.dim}${id.label}${c.reset}`,
      hint: id.offLan ? "works off-LAN" : undefined,
    })),
    initialValue: 0,
  })) as number | symbol;
  if (prompts.isCancel(answer)) {
    prompts.cancel("Cancelled.");
    throw new CliError("", EXIT_CANCELLED);
  }
  return identities[answer as number]!;
}
