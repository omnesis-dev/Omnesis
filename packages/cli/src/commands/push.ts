// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  gatewayJson,
  pathInput,
  withSpinner,
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_ERROR,
  EXIT_PARTIAL,
  EXIT_USER_ERROR,
} from "../utils.js";
import { ensureAppIdPushCapability, writeFirebaseLocalPushProperties } from "./push-setup.js";

/**
 * `omnesis push` — configure and exercise direct APNs/FCM notification delivery.
 *
 *   omnesis push status   show credentials and per-phone transport state
 *   omnesis push setup    guided APNs or FCM credential setup
 *   omnesis push test     send a test notification to every paired phone
 *
 * The `.p8` auth key itself is generated in the Apple Developer portal (Keys →
 * new key with APNs enabled); the wizard collects its path + the surrounding
 * ids, has the gateway copy the key into its config dir (so the managed path —
 * not a stray download location — is what gets persisted), and writes
 * `gateway.apns` via the normal config path. Writing the config hot-swaps the
 * gateway's APNs client, so `setup` → `test` works without a restart.
 */

interface PushStatus {
  configured: { apns: boolean; fcm: boolean; relay?: boolean };
  settings: {
    apns: {
      keyPath: string;
      keyId: string;
      teamId: string;
      bundleId: string;
      environment: "sandbox" | "production";
    } | null;
    fcm: { serviceAccountPath: string; appId?: string | null; projectId: string | null } | null;
    relay?: { enabled: boolean; url: string };
  };
  devices: {
    total: number;
    directApns: number;
    directFcm: number;
    /** @deprecated Rich carrier delivery has been removed; always zero. */
    legacyApns?: number;
    /** @deprecated Rich carrier delivery has been removed; always zero. */
    legacyFcm?: number;
    relay: number;
    /** Phones whose owners approved the content-blind relay on that device. */
    relayConsented?: number;
    unavailable: number;
    deliveryHealth?: Array<{
      id: string;
      name: string;
      platform: "ios" | "android";
      transport?: "direct-apns" | "direct-fcm" | "relay" | "socket" | null;
      available?: boolean;
      /** The app-bound plan; absent from a gateway that predates it. */
      plan?: PushPlanSummary | null;
      /** Why a phone the plan can serve still has no transport: the registration it has to redo. */
      unavailableReason?: string;
      status:
        | "healthy"
        | "not-determined"
        | "permission-denied"
        | "scheduled-summary"
        | "alerts-disabled"
        | null;
      updatedAt: number | null;
      queue?: {
        pending: number;
        leased: number;
        delivered: number;
        superseded: number;
        expired: number;
        lastClaimedAt: number | null;
        lastDeliveredAt: number | null;
        wake?: {
          pending: number;
          leased: number;
          sent: number;
          terminal: number;
          exhausted: number;
          attempts: number;
          lastAttemptAt: number | null;
          lastSuccessAt: number | null;
          lastOutcome: "pending" | "leased" | "sent" | "terminal" | "exhausted" | null;
          lastError: string | null;
          lastTransport: string | null;
        };
      };
    }>;
  };
}

interface ExecResult {
  status: "ok" | "exit-non-zero" | "skipped" | "spawn-error" | "timeout";
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
  attempted?: number;
  delivered?: number;
}

type PushStatusDevice = NonNullable<PushStatus["devices"]["deliveryHealth"]>[number];

const TEN_CHAR = /^[A-Z0-9]{10}$/i;

type PushPlanSummary =
  | { transport: "direct-apns" | "direct-fcm" | "relay" }
  | {
      transport: "unavailable";
      reasonCode?: "relay-disabled" | "relay-url-unavailable" | "no-direct-credential";
      reason: string;
    };

/**
 * Why a paired phone has no push transport, and what fixes it, kept apart
 * per state: relay consent is the phone's to give; an unsupported app
 * identity needs direct credentials or the official app, and no relay URL
 * change authorizes it; an unavailable relay endpoint is the gateway's
 * configuration; a plan the gateway can serve with no transport is a
 * registration the app has to redo.
 */
export function pushUnavailableLine(phone: {
  id: string;
  name: string;
  plan?: PushPlanSummary | null;
  unavailableReason?: string;
}): string {
  const stale = `if this pairing is stale, run \`omnesis devices revoke ${phone.id}\``;
  const plan = phone.plan;
  if (plan?.transport === "unavailable") {
    // The reason can carry the app id the phone declared; it must not steer the terminal.
    const reason = plan.reason.replace(
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
      " ",
    );
    switch (plan.reasonCode) {
      case "relay-disabled":
        return `${phone.name} (${phone.id}): relay notifications are not approved on this phone — open the Omnesis app on it and approve them when asked; ${stale}.`;
      case "no-direct-credential":
        return `${phone.name} (${phone.id}): ${reason} — a self-built app needs your own APNs or FCM credentials (\`omnesis push setup\`), or install the official app; changing the relay URL does not authorize it.`;
      case "relay-url-unavailable":
        return `${phone.name} (${phone.id}): ${reason} — check \`gateway.pushRelay.url\` (\`omnesis config get /gateway/pushRelay/url\`).`;
      default:
        return `${phone.name} (${phone.id}): ${reason}.`;
    }
  }
  if (phone.unavailableReason) {
    return `${phone.name} (${phone.id}): push registration is broken (${phone.unavailableReason}) — open the app to refresh its registration; ${stale}.`;
  }
  return `${phone.name} (${phone.id}): push transport unavailable — open the app to refresh registration; ${stale}.`;
}

const pushStatusCommand = defineCommand({
  meta: { name: "status", description: "Show push credentials and per-device transports" },
  async run() {
    const status = await withSpinner("Loading push status", () =>
      gatewayJson<PushStatus>("/admin/push/status"),
    );
    console.log(`\n${c.bold}Push notifications${c.reset}\n`);
    const apnsDot = status.configured.apns ? `${c.green}●${c.reset}` : `${c.red}○${c.reset}`;
    const fcmDot = status.configured.fcm ? `${c.green}●${c.reset}` : `${c.red}○${c.reset}`;
    console.log(`  ${apnsDot} APNs ${status.configured.apns ? "configured" : "not configured"}`);
    if (status.settings.apns) {
      const s = status.settings.apns;
      console.log(`     ${c.dim}keyId:${c.reset}       ${s.keyId}`);
      console.log(`     ${c.dim}teamId:${c.reset}      ${s.teamId}`);
      console.log(`     ${c.dim}bundleId:${c.reset}    ${s.bundleId}`);
      console.log(`     ${c.dim}environment:${c.reset} ${s.environment}`);
      console.log(`     ${c.dim}keyPath:${c.reset}     ${s.keyPath}`);
    }
    console.log(`  ${fcmDot} FCM ${status.configured.fcm ? "configured" : "not configured"}`);
    if (status.settings.fcm) {
      console.log(
        `     ${c.dim}packageId:${c.reset}    ${status.settings.fcm.appId ?? "not configured"}`,
      );
      console.log(
        `     ${c.dim}projectId:${c.reset}    ${status.settings.fcm.projectId ?? "from service account"}`,
      );
      console.log(`     ${c.dim}keyPath:${c.reset}      ${status.settings.fcm.serviceAccountPath}`);
    }
    if (status.settings.relay) {
      const approved = status.devices.relayConsented;
      const relayEnabled =
        approved === undefined
          ? (status.configured.relay ?? status.settings.relay.enabled)
          : approved > 0;
      const relayDot = relayEnabled ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
      console.log(
        approved === undefined
          ? `  ${relayDot} Relay ${relayEnabled ? "enabled" : "disabled"}`
          : `  ${relayDot} ${relayApprovalLabel(approved)}`,
      );
      console.log(`     ${c.dim}endpoint:${c.reset}     ${status.settings.relay.url}`);
    }
    console.log(`\n  ${formatPushDeviceSummary(status.devices)}`);
    for (const phone of status.devices.deliveryHealth ?? []) {
      if (phone.queue) {
        console.log(`  ${phone.name} queue: ${formatDeliveryQueue(phone.queue)}`);
      }
      if (phone.available === false) {
        console.log(`  ${c.yellow}⚠${c.reset} ${pushUnavailableLine(phone)}`);
      } else if (phone.plan?.transport === "unavailable") {
        // Reachable over its socket right now, and nothing else: the plan's
        // gap is what an operator has to fix before the app is closed.
        console.log(
          `  ${c.yellow}⚠${c.reset} reachable over its socket only — ${pushUnavailableLine(phone)}`,
        );
      }
      if (phone.status !== "healthy") {
        const state = phone.status
          ? deliveryHealthLabel(phone.status)
          : "not reported — open the app";
        console.log(`  ${c.yellow}⚠${c.reset} ${phone.name}: ${state}`);
      }
    }
    console.log();
    console.log(
      `${c.dim}Run \`omnesis push setup\` to configure direct credentials or \`omnesis push test\` to exercise registered phones.${c.reset}`,
    );
  },
});

const pushTestCommand = defineCommand({
  meta: { name: "test", description: "Send a test notification to paired phones" },
  args: {
    device: {
      type: "string",
      description: "Target one paired phone by name or id",
    },
  },
  async run(ctx) {
    const target = typeof ctx.args.device === "string" ? ctx.args.device.trim() : undefined;
    let deviceId: string | undefined;
    if (target !== undefined) {
      const status = await withSpinner("Loading paired phones", () =>
        gatewayJson<PushStatus>("/admin/push/status"),
      );
      deviceId = resolvePushTestDevice(status.devices.deliveryHealth ?? [], target).id;
    }
    const path = deviceId
      ? `/admin/push/test?deviceId=${encodeURIComponent(deviceId)}`
      : "/admin/push/test";
    const { result } = await withSpinner("Sending test push", () =>
      gatewayJson<{ result: ExecResult }>(path, { method: "POST" }),
    );
    printPushResult(result);
    if (result.status === "ok") return;
    if (isPartialPushResult(result)) throw new CliError("", EXIT_PARTIAL);
    throw new CliError("", EXIT_FAILURE);
  },
});

const pushSetupCommand = defineCommand({
  meta: { name: "setup", description: "Guided setup for direct APNs or FCM credentials" },
  async run() {
    const prompts = await import("@clack/prompts");

    const platform = await prompts.select({
      message: "Platform to configure",
      options: [
        { value: "ios", label: "iOS", hint: "APNs .p8 credential" },
        { value: "android", label: "Android", hint: "Firebase service account" },
      ],
    });
    if (prompts.isCancel(platform)) return cancel(prompts);
    if (platform === "android") return setupFcm(prompts);

    prompts.intro(`${c.bold}APNs setup${c.reset}`);
    prompts.note(
      [
        "iOS push needs an APNs auth key from your Apple Developer account:",
        "",
        "  1. Apple Developer → Certificates, Identifiers & Profiles → Keys",
        "  2. Create a Key with the Apple Push Notifications service (APNs) enabled",
        "  3. Download the .p8 file (you can only download it once) and note its",
        "     Key ID. Your Team ID is shown top-right in the portal.",
        "",
        "The .p8 is copied into the gateway's config dir and referenced from",
        "there. The key and your app's bundle id must belong to the same Apple",
        "Developer team.",
      ].join("\n"),
      "Before you start",
    );

    const keyPath = await pathInput({
      message: "Path to the APNs .p8 auth key",
      placeholder: "~/.config/omnesis/AuthKey_XXXXXXXXXX.p8",
      validate: (v) => {
        const expanded = expandHome(v.trim());
        if (!expanded) return "Path is required";
        if (!existsSync(expanded)) return "No file at that path";
        if (!expanded.endsWith(".p8")) return "Expected a .p8 file";
        return undefined;
      },
    });
    if (typeof keyPath === "symbol") return cancel(prompts);

    const keyId = await prompts.text({
      message: "Key ID (10 chars, shown next to the key in the portal)",
      validate: (v) =>
        TEN_CHAR.test((v ?? "").trim()) ? undefined : "Expected a 10-character key id",
    });
    if (prompts.isCancel(keyId)) return cancel(prompts);

    const teamId = await prompts.text({
      message: "Team ID (10 chars, top-right in the Apple Developer portal)",
      validate: (v) =>
        TEN_CHAR.test((v ?? "").trim()) ? undefined : "Expected a 10-character team id",
    });
    if (prompts.isCancel(teamId)) return cancel(prompts);

    const bundleId = await prompts.text({
      message: "App bundle id (the iOS app's bundle identifier)",
      placeholder: "dev.omnesis.ios",
      validate: (v) => ((v ?? "").trim().length > 0 ? undefined : "Bundle id is required"),
    });
    if (prompts.isCancel(bundleId)) return cancel(prompts);

    prompts.note(
      [
        "The wizard verifies that this App ID has Push Notifications enabled.",
        "Use an App Store Connect API key that can manage Certificates,",
        "Identifiers & Profiles. This is separate from the APNs auth key above.",
      ].join("\n"),
      "App ID capability check",
    );
    const ascKeyPath = await pathInput({
      message: "Path to the App Store Connect API .p8 key",
      placeholder: "~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8",
      validate: (v) => {
        const expanded = expandHome(v.trim());
        if (!expanded || !existsSync(expanded)) return "No file at that path";
        if (!expanded.endsWith(".p8")) return "Expected a .p8 file";
        return undefined;
      },
    });
    if (typeof ascKeyPath === "symbol") return cancel(prompts);
    const ascKeyId = await prompts.text({
      message: "App Store Connect API key ID",
      validate: (v) =>
        TEN_CHAR.test((v ?? "").trim()) ? undefined : "Expected a 10-character key id",
    });
    if (prompts.isCancel(ascKeyId)) return cancel(prompts);
    const ascIssuerId = await prompts.text({
      message: "App Store Connect issuer ID",
      placeholder: "00000000-0000-0000-0000-000000000000",
      validate: (v) =>
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test((v ?? "").trim())
          ? undefined
          : "Expected an issuer UUID",
    });
    if (prompts.isCancel(ascIssuerId)) return cancel(prompts);

    const environment = await prompts.select({
      message: "APNs environment",
      options: [
        { value: "sandbox", label: "sandbox", hint: "Debug builds run from Xcode" },
        { value: "production", label: "production", hint: "TestFlight / App Store builds" },
      ],
      initialValue: "production",
    });
    if (prompts.isCancel(environment)) return cancel(prompts);

    const apns = {
      keyPath: expandHome((keyPath as string).trim()),
      keyId: (keyId as string).trim(),
      teamId: (teamId as string).trim(),
      bundleId: (bundleId as string).trim(),
      environment: environment as "sandbox" | "production",
    };

    const confirmed = await prompts.confirm({
      message: "Verify/enable the App ID capability and save this APNs config?",
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || !confirmed) return cancel(prompts);

    let capabilityResult: "already-enabled" | "enabled";
    try {
      capabilityResult = await withSpinner("Verifying App ID push capability", () =>
        ensureAppIdPushCapability({
          bundleId: (bundleId as string).trim(),
          credentials: {
            keyId: (ascKeyId as string).trim(),
            issuerId: (ascIssuerId as string).trim(),
            privateKeyPath: expandHome((ascKeyPath as string).trim()),
          },
        }),
      );
    } catch (error) {
      prompts.cancel(
        `Could not verify the App ID push capability: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new CliError("", EXIT_FAILURE);
    }

    // Copy the .p8 into the gateway's config dir so the key lives alongside
    // the config that references it — a stray download (e.g. in /tmp) can't
    // silently break push later. The gateway returns the managed path, which
    // is what we persist as keyPath.
    try {
      const imported = await withSpinner("Importing key into the config dir", () =>
        gatewayJson<{ path: string }>("/admin/push/import-credential", {
          method: "POST",
          body: JSON.stringify({ platform: "ios", sourcePath: apns.keyPath }),
        }),
      );
      apns.keyPath = imported.path;
    } catch (err) {
      prompts.cancel(
        `Could not import the .p8: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new CliError("", EXIT_FAILURE);
    }

    // Deep-merged into the live config; the gateway hot-swaps its APNs client
    // on this write, so no restart is needed.
    const res = await withSpinner("Saving config", () =>
      gatewayFetch("/admin/config", {
        method: "PATCH",
        body: JSON.stringify({ gateway: { apns } }),
      }),
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      prompts.cancel(`Gateway ${res.status} saving config: ${body}`);
      throw new CliError("", EXIT_FAILURE);
    }

    prompts.outro(
      `${c.green}APNs configured.${c.reset} App ID push capability ${capabilityResult === "enabled" ? "enabled — regenerate the provisioning profile before building" : "verified"}. Key stored at ${apns.keyPath}.`,
    );

    const sendNow = await prompts.confirm({
      message: "Send a test push to your paired iPhone(s) now?",
      initialValue: true,
    });
    if (!prompts.isCancel(sendNow) && sendNow) {
      const { result } = await withSpinner("Sending test push", () =>
        gatewayJson<{ result: ExecResult }>("/admin/push/test", { method: "POST" }),
      );
      printPushResult(result);
    }
  },
});

async function setupFcm(prompts: typeof import("@clack/prompts")): Promise<void> {
  prompts.intro(`${c.bold}FCM setup${c.reset}`);
  prompts.note(
    [
      "Android direct push needs a Firebase service-account JSON file with",
      "permission to send Firebase Cloud Messaging messages.",
      "",
      "The Android app must be built with the matching Firebase application,",
      "API key, project id, and sender id values.",
    ].join("\n"),
    "Before you start",
  );
  const sourcePath = await pathInput({
    message: "Path to the Firebase service-account JSON file",
    placeholder: "~/.config/omnesis/firebase-service-account.json",
    validate: (value) => {
      const expanded = expandHome(value.trim());
      if (!expanded) return "Path is required";
      if (!existsSync(expanded)) return "No file at that path";
      if (!expanded.endsWith(".json")) return "Expected a .json file";
      return undefined;
    },
  });
  if (typeof sourcePath === "symbol") return cancel(prompts);
  const appId = await prompts.text({
    message: "Android package id for this build",
    placeholder: "dev.example.omnesis",
    validate: (value) =>
      /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test((value ?? "").trim())
        ? undefined
        : "Expected an Android package id such as dev.example.omnesis",
  });
  if (prompts.isCancel(appId)) return cancel(prompts);
  const firebaseApplicationId = await prompts.text({
    message: "Firebase application ID (mobilesdk_app_id)",
    placeholder: "1:123456789:android:abcdef",
    validate: (value) => ((value ?? "").trim() ? undefined : "Firebase application ID is required"),
  });
  if (prompts.isCancel(firebaseApplicationId)) return cancel(prompts);
  const apiKey = await prompts.text({
    message: "Firebase API key (current_key)",
    validate: (value) => ((value ?? "").trim() ? undefined : "Firebase API key is required"),
  });
  if (prompts.isCancel(apiKey)) return cancel(prompts);
  const projectId = await prompts.text({
    message: "Firebase project id",
    validate: (value) => ((value ?? "").trim() ? undefined : "Project id is required"),
  });
  if (prompts.isCancel(projectId)) return cancel(prompts);
  const senderId = await prompts.text({
    message: "Firebase sender ID (project_number)",
    validate: (value) =>
      /^\d+$/.test((value ?? "").trim()) ? undefined : "Expected a numeric sender ID",
  });
  if (prompts.isCancel(senderId)) return cancel(prompts);
  const defaultAndroidDir = existsSync(join(process.cwd(), "android", "app", "build.gradle.kts"))
    ? join(process.cwd(), "android")
    : process.cwd();
  const androidProjectDir = await prompts.text({
    message: "Android project directory",
    initialValue: defaultAndroidDir,
    validate: (value) =>
      existsSync(join(expandHome((value ?? "").trim()), "app", "build.gradle.kts"))
        ? undefined
        : "Expected the directory containing app/build.gradle.kts",
  });
  if (prompts.isCancel(androidProjectDir)) return cancel(prompts);
  const confirmed = await prompts.confirm({
    message: "Save this FCM config to gateway.fcm?",
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || !confirmed) return cancel(prompts);
  const imported = await withSpinner("Importing service account", () =>
    gatewayJson<{ path: string }>("/admin/push/import-credential", {
      method: "POST",
      body: JSON.stringify({ platform: "android", sourcePath: expandHome(sourcePath.trim()) }),
    }),
  );
  const response = await withSpinner("Saving config", () =>
    gatewayFetch("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({
        gateway: {
          fcm: {
            serviceAccountPath: imported.path,
            appId: appId.trim(),
            projectId: projectId.trim(),
          },
        },
      }),
    }),
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    prompts.cancel(`Gateway ${response.status} saving config: ${body}`);
    throw new CliError("", EXIT_FAILURE);
  }
  const propertiesPath = resolve(
    expandHome((androidProjectDir as string).trim()),
    "local.push.properties",
  );
  try {
    await writeFirebaseLocalPushProperties(propertiesPath, {
      packageId: appId.trim(),
      applicationId: (firebaseApplicationId as string).trim(),
      apiKey: (apiKey as string).trim(),
      projectId: projectId.trim(),
      senderId: (senderId as string).trim(),
    });
  } catch (error) {
    prompts.cancel(
      `FCM was configured, but ${propertiesPath} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new CliError("", EXIT_FAILURE);
  }
  prompts.outro(
    `${c.green}FCM configured.${c.reset} Wrote ${propertiesPath} for ${appId.trim()}. Rebuild and open the Android app to register this gateway.`,
  );
}

export const pushCommand = defineCommand({
  meta: { name: "push", description: "Configure and test phone push notifications" },
  subCommands: {
    status: pushStatusCommand,
    setup: pushSetupCommand,
    test: pushTestCommand,
  },
  // Default to `status` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(pushStatusCommand, { rawArgs: [] });
    }
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~")) return (process.env.HOME ?? "") + p.slice(1);
  return p;
}

export function deliveryHealthLabel(
  status: NonNullable<NonNullable<PushStatus["devices"]["deliveryHealth"]>[number]["status"]>,
): string {
  switch (status) {
    case "scheduled-summary":
      return "iOS Scheduled Summary is batching notifications";
    case "permission-denied":
      return "notification permission is denied";
    case "not-determined":
      return "notification permission has not been decided";
    case "alerts-disabled":
      return "notification alerts are disabled";
    case "healthy":
      return "healthy";
  }
}

/** Per-device relay authorization replaces the legacy gateway-wide switch. */
export function relayApprovalLabel(approved: number): string {
  return `Relay approved on ${approved} phone${approved === 1 ? "" : "s"}`;
}

export function formatPushDeviceSummary(devices: PushStatus["devices"]): string {
  return (
    `${devices.total} paired phone(s): ${devices.directApns} direct APNs, ` +
    `${devices.directFcm} direct FCM, ${devices.relay} relay, ${devices.unavailable} unavailable.`
  );
}

export function formatDeliveryQueue(
  queue: NonNullable<NonNullable<PushStatus["devices"]["deliveryHealth"]>[number]["queue"]>,
): string {
  const timestamp = (value: number | null): string =>
    value === null ? "never" : new Date(value).toISOString();
  const fields = [
    `pending=${queue.pending}`,
    `leased=${queue.leased}`,
    `delivered=${queue.delivered}`,
    `superseded=${queue.superseded}`,
    `expired=${queue.expired}`,
    `last claimed=${timestamp(queue.lastClaimedAt)}`,
    `last delivered=${timestamp(queue.lastDeliveredAt)}`,
  ];
  if (queue.wake) {
    fields.push(
      `wake pending=${queue.wake.pending}`,
      `wake leased=${queue.wake.leased}`,
      `wake sent=${queue.wake.sent}`,
      `wake terminal=${queue.wake.terminal}`,
      `wake exhausted=${queue.wake.exhausted}`,
      `wake attempts=${queue.wake.attempts}`,
      `last wake outcome=${queue.wake.lastOutcome ?? "never"}`,
      `last wake attempt=${timestamp(queue.wake.lastAttemptAt)}`,
      `last wake success=${timestamp(queue.wake.lastSuccessAt)}`,
      `last wake transport=${queue.wake.lastTransport ?? "never"}`,
      `last wake error=${queue.wake.lastError ?? "none"}`,
    );
  }
  return fields.join(", ");
}

export function resolvePushTestDevice(
  devices: readonly PushStatusDevice[],
  target: string,
): PushStatusDevice {
  const idMatch = devices.find((device) => device.id === target);
  if (idMatch) return requirePushTargetingSupport(idMatch);
  const nameMatches = devices.filter((device) => device.name === target);
  if (nameMatches.length === 1) return requirePushTargetingSupport(nameMatches[0]!);
  if (nameMatches.length > 1) {
    throw new CliError(
      `${c.red}More than one phone is named '${target}'. Run \`omnesis push status\` and use its device id.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  throw new CliError(
    `${c.red}No paired phone matching '${target}'. Run \`omnesis push status\` to see phones.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

function requirePushTargetingSupport(device: PushStatusDevice): PushStatusDevice {
  // A gateway that does not expose per-device transports may ignore the
  // targeting query and broadcast instead. Fail closed before sending.
  if (device.transport === undefined) {
    throw new CliError(
      `${c.red}This gateway does not support targeted push tests. Update the gateway first.${c.reset}`,
      EXIT_GATEWAY_ERROR,
    );
  }
  return device;
}

function cancel(prompts: typeof import("@clack/prompts")): never {
  prompts.cancel("Cancelled.");
  throw new CliError("", EXIT_CANCELLED);
}

function printPushResult(result: ExecResult): void {
  if (isPartialPushResult(result)) {
    console.log(
      `\n${c.yellow}Partial success. ${result.stdoutTail || `Wake accepted by ${result.delivered}/${result.attempted} device(s).`}${c.reset}` +
        (result.stderrTail ? `\n${c.dim}${result.stderrTail}${c.reset}` : "") +
        (result.error ? `\n${c.dim}${result.error}${c.reset}` : ""),
    );
    return;
  }
  switch (result.status) {
    case "ok":
      console.log(`\n${c.green}✓ ${result.stdoutTail || "Test push delivered."}${c.reset}`);
      break;
    case "skipped":
      console.log(
        `\n${c.yellow}No devices to notify.${c.reset} ${c.dim}${result.error ?? "Open the Omnesis app on a paired iPhone and allow notifications."}${c.reset}`,
      );
      break;
    case "spawn-error":
      console.log(
        `\n${c.red}Push is not ready: ${result.error ?? "configuration error"}${c.reset}\n${c.dim}Run \`omnesis push setup\`.${c.reset}`,
      );
      break;
    default:
      console.log(
        `\n${c.red}Test push failed (${result.status}).${c.reset}` +
          (result.stderrTail ? `\n${c.dim}${result.stderrTail}${c.reset}` : "") +
          (result.error ? `\n${c.dim}${result.error}${c.reset}` : ""),
      );
  }
}

export function isPartialPushResult(result: ExecResult): boolean {
  return (
    typeof result.attempted === "number" &&
    typeof result.delivered === "number" &&
    result.delivered > 0 &&
    result.delivered < result.attempted
  );
}
