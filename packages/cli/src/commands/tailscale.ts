// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis tailscale`: the gateway's own Tailscale device. The owner's
 * commands talk to the CLI's gateway; `join` runs on a collector's machine
 * and joins it to the gateway through that machine's Tailscale. The command
 * exists only with OMNESIS_TAILSCALE_EMBED_ENABLED=1.
 */

import { hostname as osHostname } from "node:os";
import { join as pathJoin } from "node:path";
import { defineCommand } from "citty";
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_TAILSCALE_DEVICE_NAME,
  ensureGatewayTrust,
  readPackageVersion,
  tailscaleAdminStateSchema,
  tailscaleEmbedEnabled,
  tailscaleJoinPolicySchema,
  tailscaleJoinRequestSchema,
  writeSecretTextFileSync,
  type TailscaleAdminState,
  type TailscaleJoinPolicy,
} from "@omnesis/core";
import { DeviceId } from "@omnesis/types";
import { z } from "zod";
import {
  c,
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  gatewayJson,
} from "../utils.js";
import { readLocalTailnet, requestJoin, type JoinTransport } from "../tailscale-join.js";
import { getOrCreateInstallId, recordRedeemedCollector, redeemSuggestedName } from "./devices.js";

function requireFlag(): void {
  if (!tailscaleEmbedEnabled())
    throw new CliError(
      "Tailscale commands require OMNESIS_TAILSCALE_EMBED_ENABLED=1",
      EXIT_USER_ERROR,
    );
}

/** The gateway's answer to GET /admin/tailscale. */
export type TailscaleState = TailscaleAdminState;

const JOIN_POLICY_TEXT: Record<TailscaleJoinPolicy, string> = {
  ask: "ask first",
  automatic: "join automatically",
  off: "off (devices pair with a code)",
};

const CERTIFICATE_TEXT: Record<string, string> = {
  "https-disabled":
    "HTTPS certificates are off in your Tailscale network; the gateway uses its own certificate. Turn them on at https://login.tailscale.com/admin/dns",
  "magicdns-disabled":
    "MagicDNS is off in your Tailscale network; the gateway uses its own certificate. Turn it on at https://login.tailscale.com/admin/dns",
  pending: "Getting a trusted certificate…",
  failed: "Tailscale could not issue a certificate; the gateway uses its own for now.",
};

/** Plain-text summary of the state, one fact per line. */
export function describeState(state: TailscaleState): string[] {
  const lines: string[] = [];
  if (!state.enabled) return ["Tailscale: off. Turn it on with `omnesis tailscale on`."];
  if (state.helper.state === "unavailable") {
    return [`Tailscale: can't start. ${state.helper.reason ?? ""}`.trim()];
  }
  if (state.helper.state === "restarting") {
    lines.push(
      `The Tailscale helper stopped${state.helper.reason ? ` (${state.helper.reason})` : ""}; restarting.`,
    );
  }
  switch (state.connection) {
    case "needs-sign-in":
      lines.push("Tailscale: waiting for you to sign in.");
      lines.push(state.signInUrl ? `Sign in at ${state.signInUrl}` : "Getting a sign-in link…");
      break;
    case "needs-approval":
      lines.push(
        `Tailscale: an administrator of your Tailscale network must approve "${state.deviceName}" at https://login.tailscale.com/admin/machines`,
      );
      break;
    case "connected":
      lines.push(`Tailscale: connected as ${state.url}`);
      if (state.owner)
        lines.push(
          `Account: ${state.owner.displayName ?? state.owner.login} (${state.owner.login})`,
        );
      if (state.certificate?.source === "tailscale") lines.push("Certificate: trusted");
      else if (state.certificate?.reason)
        lines.push(
          `Certificate: ${CERTIFICATE_TEXT[state.certificate.reason] ?? state.certificate.reason}`,
        );
      break;
    default:
      lines.push(`Tailscale: ${state.connection}.`);
  }
  if (state.public.wanted || state.public.state !== "off") {
    switch (state.public.state) {
      case "on":
        lines.push(`Public address for cloud agents: on — ${state.public.url}/mcp`);
        break;
      case "needs-enable":
        lines.push(
          `Public address for cloud agents: allow it in Tailscale first${state.public.enableUrl ? ` at ${state.public.enableUrl}` : ""}`,
        );
        break;
      case "unavailable":
        lines.push(
          `Public address for cloud agents: unavailable (${state.public.reason === "https-disabled" ? "HTTPS certificates are off in your Tailscale network" : (state.public.reason ?? "unknown reason")})`,
        );
        break;
      default:
        lines.push(`Public address for cloud agents: ${state.public.state}`);
    }
  } else {
    lines.push("Public address for cloud agents: off");
  }
  lines.push(`Your devices joining through Tailscale: ${JOIN_POLICY_TEXT[state.joinPolicy]}`);
  for (const request of state.joinRequests) {
    lines.push(
      `Waiting: ${request.name} on ${request.machine} (${request.login}) — omnesis tailscale approve ${request.id}`,
    );
  }
  return lines;
}

const asState = (body: unknown): TailscaleState => tailscaleAdminStateSchema.parse(body);
const getState = async () => asState(await gatewayJson<unknown>("/admin/tailscale"));
const post = (path: string, body?: unknown) =>
  gatewayJson<unknown>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const postForState = async (path: string, body?: unknown) => asState(await post(path, body));
const patch = async (body: unknown) =>
  asState(
    await gatewayJson<unknown>("/admin/tailscale/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  );

function print(state: TailscaleState, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  for (const line of describeState(state)) console.log(line);
}

async function printSignInQr(url: string): Promise<void> {
  try {
    const qrTerminal = await import("qrcode-terminal");
    qrTerminal.default.generate(url, { small: true });
  } catch {
    /* No QR library: the link above is enough. */
  }
}

/** Follow the device until it is connected, printing the sign-in link once. */
async function waitForConnection(
  initial: TailscaleState,
  timeoutMs = 10 * 60 * 1000,
): Promise<TailscaleState> {
  let state = initial;
  let shownUrl: string | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.connection === "connected" || state.helper.state === "unavailable" || !state.enabled)
      return state;
    if (state.connection === "needs-sign-in" && state.signInUrl && state.signInUrl !== shownUrl) {
      shownUrl = state.signInUrl;
      console.log(
        `Sign in to Tailscale to add this gateway to your network:\n  ${state.signInUrl}`,
      );
      console.log(`${c.dim}Or scan this with a phone:${c.reset}`);
      await printSignInQr(state.signInUrl);
      console.log(`${c.dim}Waiting for the sign-in…${c.reset}`);
    }
    if (state.connection === "needs-approval" && shownUrl !== "approval") {
      shownUrl = "approval";
      for (const line of describeState(state)) console.log(line);
    }
    await new Promise((r) => setTimeout(r, 2000));
    state = await getState();
  }
  return state;
}

const jsonArg = { json: { type: "boolean" as const, description: "Print JSON" } };

const statusCommand = defineCommand({
  meta: { name: "status", description: "Show the gateway's Tailscale device" },
  args: jsonArg,
  async run({ args }) {
    requireFlag();
    print(await getState(), args.json === true);
  },
});

const onCommand = defineCommand({
  meta: { name: "on", description: "Turn on the gateway's own Tailscale device and sign it in" },
  args: {
    ...jsonArg,
    "no-wait": { type: "boolean", description: "Return without waiting for the sign-in" },
  },
  async run({ args }) {
    requireFlag();
    let state = await postForState("/admin/tailscale/enable", { enabled: true });
    if (!args["no-wait"] && !args.json) state = await waitForConnection(state);
    print(state, args.json === true);
  },
});

const offCommand = defineCommand({
  meta: {
    name: "off",
    description: "Turn off the gateway's Tailscale device; its tailnet and public addresses close",
  },
  args: jsonArg,
  async run({ args }) {
    requireFlag();
    print(await postForState("/admin/tailscale/enable", { enabled: false }), args.json === true);
  },
});

const signInCommand = defineCommand({
  meta: { name: "sign-in", description: "Get a fresh Tailscale sign-in link" },
  args: jsonArg,
  async run({ args }) {
    requireFlag();
    const state = await postForState("/admin/tailscale/sign-in");
    print(args.json ? state : await waitForConnection(state), args.json === true);
  },
});

const signOutCommand = defineCommand({
  meta: { name: "sign-out", description: "Sign the gateway's device out of Tailscale" },
  args: jsonArg,
  async run({ args }) {
    requireFlag();
    print(await postForState("/admin/tailscale/sign-out"), args.json === true);
  },
});

function onOff(value: unknown, usage: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CliError(usage, EXIT_USER_ERROR);
}

const publicCommand = defineCommand({
  meta: { name: "public", description: "Open or close the public address cloud agents use" },
  args: { state: { type: "positional", required: true, description: "on | off" }, ...jsonArg },
  async run({ args }) {
    requireFlag();
    const wanted = onOff(args.state, "Usage: omnesis tailscale public on|off");
    print(await patch({ publicAccess: wanted }), args.json === true);
  },
});

const joiningCommand = defineCommand({
  meta: {
    name: "joining",
    description: "What happens when one of your own Tailscale devices asks to join",
  },
  args: {
    policy: { type: "positional", required: true, description: "ask | automatic | off" },
    ...jsonArg,
  },
  async run({ args }) {
    requireFlag();
    const policy = tailscaleJoinPolicySchema.safeParse(String(args.policy));
    if (!policy.success)
      throw new CliError("Usage: omnesis tailscale joining ask|automatic|off", EXIT_USER_ERROR);
    print(await patch({ joinPolicy: policy.data }), args.json === true);
  },
});

const nameCommand = defineCommand({
  meta: { name: "name", description: "Set the gateway's device name on Tailscale" },
  args: {
    name: { type: "positional", required: true, description: "letters, digits and hyphens" },
    ...jsonArg,
  },
  async run({ args }) {
    requireFlag();
    print(await patch({ deviceName: String(args.name) }), args.json === true);
  },
});

const requestsCommand = defineCommand({
  meta: { name: "requests", description: "List collectors waiting to join through Tailscale" },
  args: jsonArg,
  async run({ args }) {
    requireFlag();
    const { requests } = z
      .object({ requests: z.array(tailscaleJoinRequestSchema) })
      .parse(await gatewayJson<unknown>("/admin/tailscale/join-requests"));
    if (args.json) {
      console.log(JSON.stringify(requests, null, 2));
      return;
    }
    if (requests.length === 0) {
      console.log("No devices are waiting.");
      return;
    }
    for (const r of requests) console.log(`${r.id}  ${r.name} on ${r.machine} (${r.login})`);
  },
});

function decisionCommand(approve: boolean) {
  return defineCommand({
    meta: {
      name: approve ? "approve" : "deny",
      description: approve ? "Let a waiting collector join" : "Refuse a waiting collector",
    },
    args: {
      id: {
        type: "positional",
        required: true,
        description: "request id from `omnesis tailscale requests`",
      },
    },
    async run({ args }) {
      requireFlag();
      await post(`/admin/tailscale/join-requests/${encodeURIComponent(String(args.id))}/decision`, {
        approve,
      });
      console.log(
        approve ? "Approved. The collector finishes joining on its next check." : "Denied.",
      );
    },
  });
}

/** The HTTPS origin `--gateway` names: a Tailscale name, an address, or an https:// URL. */
export function gatewayOrigin(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https:\/\//i.test(raw)) {
    throw new CliError(
      `--gateway must be the gateway's Tailscale name or an https:// address, not ${raw}.`,
      EXIT_USER_ERROR,
    );
  }
  const url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new CliError(
      `--gateway must be just the gateway's address, not ${raw}.`,
      EXIT_USER_ERROR,
    );
  }
  return url.origin;
}

/** POST JSON to the gateway at `origin` without a credential; joining is how one is obtained. */
function joinTransport(origin: string): JoinTransport {
  return {
    async post(path, body) {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        // An answer that is not JSON reads as an error below.
      }
      return { status: res.status, json };
    },
  };
}

async function confirm(question: string): Promise<boolean> {
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({ message: question });
  return !prompts.isCancel(answer) && answer === true;
}

const joinCommand = defineCommand({
  meta: {
    name: "join",
    description:
      "On a collector's machine: join the gateway on your Tailscale network, without a pairing code",
  },
  args: {
    gateway: {
      type: "string",
      description: "The gateway's Tailscale name or address (default: found on your tailnet)",
    },
    "device-name": {
      type: "string",
      description: "The gateway's device name on Tailscale, when not the default (omnesis)",
    },
    name: {
      type: "string",
      description: "This collector's name (default: this machine's hostname)",
    },
    save: {
      type: "string",
      description: "Where to save the collector's token (default: <config>/collector-token)",
    },
    yes: { type: "boolean", description: "Join without asking for confirmation" },
  },
  async run({ args }) {
    requireFlag();
    let origin: string;
    if (typeof args.gateway === "string" && args.gateway.trim()) {
      origin = gatewayOrigin(args.gateway.trim());
    } else {
      const tailnet = await readLocalTailnet(
        typeof args["device-name"] === "string"
          ? args["device-name"]
          : DEFAULT_TAILSCALE_DEVICE_NAME,
      );
      if (!tailnet) {
        throw new CliError(
          "Tailscale isn't installed or isn't answering on this machine. Install Tailscale and sign in, or pair this collector with a pairing code.",
          EXIT_USER_ERROR,
        );
      }
      if (!tailnet.running) {
        throw new CliError(
          "Tailscale isn't connected on this machine. Connect it, then try again.",
          EXIT_USER_ERROR,
        );
      }
      // Only a device signed in to this machine's own Tailscale account is
      // taken on trust; anyone on a shared tailnet can name a device "omnesis".
      const found = tailnet.candidates.find((c) => c.sameOwner && c.online);
      if (!found) {
        const others = tailnet.candidates.filter((c) => c.online).map((c) => c.dnsName);
        throw new CliError(
          others.length > 0
            ? `No gateway of your own was found on your Tailscale network. ${others.join(", ")} belong${others.length === 1 ? "s" : ""} to someone else or to a tag; if you mean to join one, pass --gateway <its Tailscale name>.`
            : "No Omnesis gateway was found on your Tailscale network. Check that the gateway's Tailscale device is on, or pass --gateway <its Tailscale name>.",
          EXIT_USER_ERROR,
        );
      }
      origin = `https://${found.dnsName}`;
    }

    const configDir = process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
    // A Tailscale certificate is trusted as it is; a tailnet without HTTPS
    // certificates serves the gateway's own, which is confirmed here as on
    // any first connection.
    await ensureGatewayTrust({ gatewayUrl: origin, configDir });
    const health = await fetch(`${origin}/health`)
      .then((r) => r.json() as Promise<{ status?: string; tailscaleEmbed?: boolean }>)
      .catch(() => null);
    if (health?.status !== "ok" || health.tailscaleEmbed !== true) {
      throw new CliError(
        `${origin} doesn't answer as an Omnesis gateway with its own Tailscale device.`,
        EXIT_FAILURE,
      );
    }

    if (!args.yes && !(await confirm(`Join the gateway at ${origin} on your Tailscale network?`))) {
      throw new CliError("Cancelled.", EXIT_CANCELLED);
    }

    const name = redeemSuggestedName(typeof args.name === "string" ? args.name : undefined);
    const answer = await requestJoin({
      transport: joinTransport(origin),
      name,
      capabilities: {
        hostname: osHostname(),
        suggestedName: name,
        platform: process.platform,
        version: readPackageVersion(import.meta.url),
        installId: getOrCreateInstallId(configDir),
      },
      onWaiting: () =>
        console.log(
          "Waiting for approval. Approve this collector on your phone, or in the portal under Settings → Tailscale.",
        ),
    });
    if (answer.status !== "joined") throw new CliError(answer.error, EXIT_FAILURE);

    const savePath =
      typeof args.save === "string" ? args.save : pathJoin(configDir, "collector-token");
    writeSecretTextFileSync(savePath, `${answer.token}\n`, { configDir });
    recordRedeemedCollector(savePath, origin, {
      device: { ...answer.device, id: DeviceId(answer.device.id) },
      token: answer.token,
    });
    console.log(
      `Joined as ${c.bold}${answer.device.name}${c.reset}. Token written to ${savePath} (mode 0600).`,
    );
    console.log(`Start the collector with OMNESIS_GATEWAY_URL=${origin}`);
  },
});

export const tailscaleCommand = defineCommand({
  meta: { name: "tailscale", description: "The gateway's own Tailscale device" },
  subCommands: {
    status: statusCommand,
    on: onCommand,
    off: offCommand,
    "sign-in": signInCommand,
    "sign-out": signOutCommand,
    public: publicCommand,
    joining: joiningCommand,
    name: nameCommand,
    requests: requestsCommand,
    approve: decisionCommand(true),
    deny: decisionCommand(false),
    join: joinCommand,
  },
});
