// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Interactive setup wizard for provider OAuth credentials.
 *
 * Drives the user through the wizard steps declared on a provider's
 * `credentials` spec, collects field values, and POSTs them to the gateway.
 * Same flow whether invoked from `cli creds set <provider>` or auto-launched
 * by `cli add` when a required-credentials provider has none configured.
 */

import { hostname as osHostname } from "node:os";
import { spawn } from "node:child_process";
import {
  expandSpecTokens,
  publicBaseUrlFromAdminConfig,
  type SerializedProviderCredentialsSpec,
} from "@omnesis/core";
import { c, gatewayJson, withSpinner, GATEWAY_URL } from "./utils.js";

interface CredentialsEntry {
  fileKey: string;
  providerType: string;
  providerName: string;
  spec: SerializedProviderCredentialsSpec;
  configured: boolean;
}

interface CredentialsStatusResponse {
  deviceId: string;
  hostname: string;
  /** Page<CredentialsEntry> shape — `items` replaces the legacy `entries`. */
  items: CredentialsEntry[];
  pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
}

/** `GET /admin/config` envelope — only the field the wizard needs. */
interface AdminConfigResponse {
  config?: { gateway?: { publicBaseUrl?: string } };
}

/**
 * Fetch the per-provider credentials status from the gateway.
 * Returns the list of providers that declare a credentials spec, plus the
 * collector's hostname so callers can decide whether to auto-open URLs.
 */
export async function fetchCredentialsStatus(
  deviceId?: string,
): Promise<CredentialsStatusResponse> {
  const qs = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  return gatewayJson<CredentialsStatusResponse>(`/admin/credentials${qs}`);
}

/**
 * Resolve the gateway origin a `{gatewayOrigin}` token expands to in the CLI.
 * Prefers the configured `gateway.publicBaseUrl` (an operator may set an
 * externally-reachable URL that differs from where the CLI connects); otherwise
 * falls back to the origin of the gateway URL the CLI itself talks to — which
 * is the host the OAuth callback server runs on. Pure, so the expansion is unit
 * testable without a live gateway.
 *
 * Unlike the portal's `resolveGatewayOrigin` (which falls back to
 * `window.location.origin`), the CLI has no browser origin, so its fallback is
 * `GATEWAY_URL`. Returns "" only if that URL is unparseable.
 */
export function resolveWizardOrigin(config: AdminConfigResponse, gatewayUrl: string): string {
  const publicBaseUrl = publicBaseUrlFromAdminConfig(config);
  if (publicBaseUrl) return publicBaseUrl;
  try {
    return new URL(gatewayUrl).origin;
  } catch {
    return "";
  }
}

/**
 * Fetch the gateway origin for token expansion. Degrades to the CLI's own
 * gateway URL origin if `/admin/config` is unreachable, so the wizard still
 * renders a concrete redirect URL rather than the bare token.
 */
async function fetchWizardOrigin(): Promise<string> {
  let config: AdminConfigResponse = {};
  try {
    config = await gatewayJson<AdminConfigResponse>("/admin/config");
  } catch {
    /* config unreachable — fall back to the CLI's gateway URL origin */
  }
  return resolveWizardOrigin(config, GATEWAY_URL);
}

/**
 * Whether the CLI is running on the same host as the collector. Compares
 * `os.hostname()` here to the collector-reported hostname. When equal we
 * can safely auto-open browser tabs (the OAuth callback server runs on
 * this machine). When unequal we just print URLs.
 */
export function isSameHostAsCollector(collectorHostname?: string): boolean {
  if (!collectorHostname) return false;
  return collectorHostname === osHostname();
}

/** Spawn `open <url>` (macOS) / `xdg-open` (linux). Best-effort, never throws. */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* swallow — fall back to printing the URL */
    });
    child.unref();
  } catch {
    /* swallow */
  }
}

/**
 * Walk the user through a provider's setup steps and collect the fields it
 * declares. Returns the cleaned values, or `null` if the user cancelled.
 *
 * Collection is separated from saving because a per-account credential is not
 * saved here at all: it is handed to the auth flow, which stores it under the
 * account its probe resolves. Only a provider-wide credential has somewhere to
 * be written before authentication.
 */
export async function collectCredentialFields(
  entry: CredentialsEntry,
  ctx: { sameHost: boolean; perAccount?: boolean },
): Promise<Record<string, string> | null> {
  const prompts = await import("@clack/prompts");
  const { providerName, fileKey } = entry;

  // The spec is a shared descriptor that may carry `{gatewayOrigin}` tokens
  // (e.g. Enable Banking's redirect URL). Expand them to the gateway's real
  // origin up front so every step body, placeholder, and field default the CLI
  // renders below is a concrete, paste-ready value — matching what the portal
  // wizard shows.
  const origin = await fetchWizardOrigin();
  const spec = expandSpecTokens(entry.spec, origin);

  console.log(`\n${c.bold}${providerName} credentials setup${c.reset}\n`);
  console.log(spec.wizard.intro);
  console.log();
  console.log(`${c.dim}Why?${c.reset} ${spec.wizard.why}`);
  console.log();
  console.log(
    `${c.dim}Estimated time: ~${spec.wizard.estMinutes} minute${spec.wizard.estMinutes === 1 ? "" : "s"}.${c.reset}`,
  );
  console.log();

  const proceed = await prompts.confirm({
    message: "Ready to start?",
    initialValue: true,
  });
  if (prompts.isCancel(proceed) || proceed === false) {
    prompts.cancel("Cancelled — credentials not set up.");
    return null;
  }

  // Walk the steps sequentially. Each step waits for the user before
  // moving on so they can work through the platform's UI without losing
  // context.
  for (let i = 0; i < spec.wizard.steps.length; i++) {
    const step = spec.wizard.steps[i];
    const stepNum = `${i + 1}/${spec.wizard.steps.length}`;
    console.log(`\n${c.bold}[${stepNum}] ${step.title}${c.reset}\n`);
    console.log(step.body);

    if (step.kind === "open-url" && step.url) {
      console.log();
      console.log(`  ${c.cyan}${step.url}${c.reset}`);
      if (ctx.sameHost) {
        const open = await prompts.confirm({
          message: "Open this URL in your browser now?",
          initialValue: true,
        });
        if (prompts.isCancel(open)) {
          prompts.cancel("Cancelled.");
          return null;
        }
        if (open) openInBrowser(step.url);
      } else {
        console.log(
          `\n${c.dim}(CLI is on a different host than the collector — open the URL manually on whichever machine has a browser.)${c.reset}`,
        );
      }
    }

    // Don't gate the last step — we'll prompt for the field values next.
    if (i < spec.wizard.steps.length - 1) {
      const cont = await prompts.confirm({ message: "Done — continue?", initialValue: true });
      if (prompts.isCancel(cont) || cont === false) {
        prompts.cancel("Cancelled — credentials not set up.");
        return null;
      }
    }
  }

  console.log(`\n${c.bold}Paste the credentials you just created${c.reset}`);
  if (ctx.perAccount) {
    console.log(
      `${c.dim}They'll be stored under the account they turn out to belong to, once verified (mode 0600).${c.reset}\n`,
    );
  } else if (ctx.sameHost) {
    console.log(
      `${c.dim}They'll be saved to ~/.config/omnesis/${fileKey}-credentials.json (mode 0600).${c.reset}\n`,
    );
  } else {
    console.log(`${c.dim}They'll be saved to the collector's config dir (mode 0600).${c.reset}\n`);
  }

  const fields: Record<string, string> = {};
  for (const field of spec.fields) {
    const ask = field.secret ? prompts.password : prompts.text;
    // Pre-fill a (non-secret) field that ships an expanded default — e.g. the
    // redirect URL — so the user just confirms the exact value rather than
    // retyping it. Secrets are never seeded.
    const seeded = !field.secret && field.default ? { initialValue: field.default } : {};
    const value = await ask({
      message: field.label,
      placeholder: field.placeholder,
      ...seeded,
      validate: (raw) => {
        const v = (raw ?? "").toString().trim();
        if (!v) return `${field.label} is required`;
        if (field.pattern && !new RegExp(field.pattern).test(v)) {
          return field.patternHint ?? `${field.label} has invalid format`;
        }
        return undefined;
      },
    });
    if (prompts.isCancel(value)) {
      prompts.cancel("Cancelled — credentials not set up.");
      return null;
    }
    fields[field.name] = String(value).trim();
  }

  return fields;
}

/**
 * Collect a provider-wide credential and save it. Returns `true` on success,
 * `false` on cancel or error. Caller logs context-specific success messaging.
 *
 * Not for a `perAccount` spec — those have no provider-wide slot, and the
 * collector refuses the write. Use `collectCredentialFields` and pass the
 * result into the auth flow instead.
 */
export async function runCredentialsWizard(
  entry: CredentialsEntry,
  ctx: { deviceId: string; sameHost: boolean },
): Promise<boolean> {
  // Refuse before collecting anything. The collector rejects a provider-wide
  // write for a per-account spec, so walking the user through the explainer and
  // the paste prompt only to fail at the end costs them an API key they cannot
  // recover from the screen.
  if (entry.spec.perAccount) {
    console.error(
      `${c.yellow}${entry.providerName} credentials belong to a single account, not to the provider.${c.reset}\n` +
        `${c.dim}Connect an account with ${c.reset}omnesis sources add ${entry.providerType}${c.dim}, ` +
        `or replace a rotated key with ${c.reset}omnesis sources reauth <source-id>${c.dim}.${c.reset}`,
    );
    return false;
  }
  const fields = await collectCredentialFields(entry, ctx);
  if (!fields) return false;

  try {
    await withSpinner(`Saving ${entry.providerName} credentials`, () =>
      gatewayJson(`/admin/credentials/${encodeURIComponent(entry.fileKey)}`, {
        method: "POST",
        body: JSON.stringify({ deviceId: ctx.deviceId, fields }),
      }),
    );
  } catch (err) {
    console.error(
      `${c.red}Failed to save credentials: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    return false;
  }

  console.log(`\n${c.green}${entry.providerName} credentials saved.${c.reset}`);
  return true;
}

/**
 * Find the credentials entry for a given provider type or fileKey, or print
 * an error and return undefined.
 */
export function resolveCredentialsEntry(
  target: string,
  entries: CredentialsEntry[],
): CredentialsEntry | undefined {
  const found = entries.find((e) => e.fileKey === target || e.providerType === target);
  if (found) return found;
  console.error(
    `${c.red}No credentials provider matches: ${target}${c.reset}\n` +
      `${c.dim}Known: ${entries.map((e) => e.fileKey).join(", ")}${c.reset}`,
  );
  return undefined;
}
