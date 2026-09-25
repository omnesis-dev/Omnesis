// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Provider OAuth credentials — declarative spec + atomic file IO.
 *
 * Some providers (Google, Strava) cannot ship usable bundled OAuth credentials
 * and require the user to register their own client. Others (Notion, Outlook)
 * ship a public/registered client by default but still allow override.
 *
 * The spec on each provider declares which fields the user must paste, why
 * they need to, and the wizard steps to walk them through the platform's
 * developer console. Admin clients (CLI, portal) read this and render an
 * interactive wizard without importing provider code.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePathSegment } from "@omnesis/types";
import { DEFAULT_CONFIG_DIR } from "./utils.js";
import { createLogger } from "./logger.js";
import { readSecretTextFile, writeSecretJsonFile, type SecretFileOptions } from "./secret-file.js";
import type { AuthErrorCode } from "./auth-error-codes.js";

const log = createLogger("core:credentials");

/** A single field the user pastes (e.g. `client_id`, `client_secret`). */
export interface ProviderCredentialsField {
  /** JSON key — also the key on the credentials file (`client_id`, `client_secret`). */
  name: string;
  /** Human label rendered in CLI / portal. */
  label: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Default value (e.g. a template with {gatewayOrigin} that will be expanded at render time). */
  default?: string;
  /** Hide input + scrub from logs. Use for client_secret. */
  secret?: boolean;
  /** Whether the operator must supply this field. Defaults to true. */
  required?: boolean;
  /** Optional regex (anchored). Validated client-side before submitting. */
  pattern?: string;
  /** Hint shown on validation failure. */
  patternHint?: string;
}

/** One step in the wizard sequence. Sequential — each waits for the user. */
export interface ProviderCredentialsWizardStep {
  /** "instruction": text only. "open-url": offer to open the URL. */
  kind: "instruction" | "open-url";
  /** Title — short, imperative ("Create a Cloud project"). */
  title: string;
  /** Body — markdown, rendered as plain text in CLI. */
  body: string;
  /** Required when kind === "open-url". */
  url?: string;
}

export interface ProviderCredentialsSpec {
  /**
   * Stable key addressing this provider's credential storage on the collector
   * host. A shared credential (an OAuth client id/secret used by every account)
   * lives at `<configDir>/<fileKey>-credentials.json`; a `perAccount`
   * credential lives at `<configDir>/<fileKey>/<accountId>/credentials.json`.
   */
  fileKey: string;
  /**
   * `true` → no bundled fallback. The provider refuses to authenticate until
   * the user supplies their own creds.
   */
  required: boolean;
  /**
   * `true` → a public/registered client is bundled and works for everyone.
   * Users may override if they want their own. Mutually exclusive with
   * `required: true`.
   */
  publicClient?: boolean;
  /**
   * `true` → these fields ARE the per-account credential, not a client secret
   * shared across accounts. Two consequences for clients:
   *
   *   - Collect them on **every** add. An existing credential belongs to an
   *     account that is already configured, so `configured` is never a reason
   *     to skip the wizard — skipping it is what made a second account
   *     impossible, since the flow just re-validated the first account's key
   *     and resolved the same id.
   *   - Hand them to the auth flow rather than saving them first. The provider
   *     probes with them, derives the account id, and only then persists to
   *     that account's own path — so a failed add leaves nothing behind.
   *
   * Because nothing is written until the probe succeeds, and the pasted value
   * may be unrecoverable (an API key shown once at creation), a client MUST
   * retain what the user typed until the flow terminates successfully and
   * offer a retry on failure.
   */
  perAccount?: boolean;
  /** Pasted fields, in display order. */
  fields: ProviderCredentialsField[];
  /** Setup wizard. */
  wizard: {
    intro: string;
    why: string;
    estMinutes: number;
    steps: ProviderCredentialsWizardStep[];
  };
}

// ── Errors ─────────────────────────────────────────────────────────────

/**
 * Thrown by `loadProviderCredentials` when no credentials file exists for a
 * provider that requires user-supplied credentials. Admin clients (CLI / portal
 * via the auth subprocess) catch this and render the setup wizard instead of
 * propagating a generic auth error.
 */
export class MissingCredentialsError extends Error {
  readonly code: AuthErrorCode = "missing-credentials";
  constructor(
    public readonly fileKey: string,
    public readonly providerName: string,
  ) {
    super(
      `Missing OAuth credentials for ${providerName}: run \`cli creds set ${fileKey}\` to set them up.`,
    );
    this.name = "MissingCredentialsError";
  }

  /** Structured payload for IPC across the auth subprocess → gateway → admin client. */
  toJSON(): { code: AuthErrorCode; fileKey: string; providerName: string; message: string } {
    return {
      code: "missing-credentials",
      fileKey: this.fileKey,
      providerName: this.providerName,
      message: this.message,
    };
  }
}

/**
 * Thrown when a provider authenticated successfully but could not persist the
 * credential for the account it resolved.
 *
 * Distinct from a generic auth failure because the pasted value may be
 * unrecoverable — an API key a platform shows once at creation. Clients keep
 * what the user typed and offer a retry rather than telling them to go and
 * mint a new one.
 */
export class CredentialPersistError extends Error {
  readonly code: AuthErrorCode = "credential-persist-failed";
  constructor(
    public readonly fileKey: string,
    public readonly accountId: string,
    cause?: unknown,
  ) {
    super(
      `Authenticated ${fileKey} account ${accountId}, but could not store its credential: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "CredentialPersistError";
  }

  toJSON(): { code: AuthErrorCode; fileKey: string; accountId: string; message: string } {
    return {
      code: "credential-persist-failed",
      fileKey: this.fileKey,
      accountId: this.accountId,
      message: this.message,
    };
  }
}

// Both predicates check the fields they narrow to, not only the discriminating
// code. A second error vocabulary now shares these codes — a typed
// `AuthFailure` raised by a provider says `missing-credentials` too — and a
// predicate that claimed it on the code alone handed a caller an object whose
// `fileKey` was `undefined`, which reaches a client as a routable failure it
// then cannot route.

export function isCredentialPersistError(err: unknown): err is CredentialPersistError {
  const e = err as { code?: string; fileKey?: unknown; accountId?: unknown } | null;
  return (
    Boolean(e) &&
    e!.code === "credential-persist-failed" &&
    typeof e!.fileKey === "string" &&
    typeof e!.accountId === "string"
  );
}

export function isMissingCredentialsError(err: unknown): err is MissingCredentialsError {
  const e = err as { code?: string; fileKey?: unknown; providerName?: unknown } | null;
  return (
    Boolean(e) &&
    e!.code === "missing-credentials" &&
    typeof e!.fileKey === "string" &&
    typeof e!.providerName === "string"
  );
}

// ── File IO ────────────────────────────────────────────────────────────

/** Path of the credentials file for a given fileKey. */
export function providerCredentialsPath(fileKey: string, configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, `${fileKey}-credentials.json`);
}

/**
 * Read a credentials file. Returns `null` when the file is absent or
 * malformed (mirrors `loadManifest`'s degrade-and-warn pattern). Callers
 * decide whether `null` is fatal (Google, Strava throw
 * `MissingCredentialsError` to trigger the setup wizard) or means
 * "use the bundled public client" (Notion, Outlook).
 *
 * Pre-fix this threw raw `SyntaxError` on malformed JSON. The auth
 * subprocess surfaced that as a generic `failed` rather than the
 * actionable "credentials look corrupt — rerun the wizard?" — and a
 * power-loss-truncated creds file (or a half-pasted Cloud-Console
 * download) silently broke auth without a path forward. Returning
 * `null` on malformed feeds straight back into the wizard recovery
 * path that the caller already has wired up for absent files.
 */
export async function readProviderCredentials(
  fileKey: string,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<Record<string, string> | null> {
  const path = providerCredentialsPath(fileKey, configDir);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    const unwrapped = await readSecretTextFile(path, { ...opts, configDir });
    if (unwrapped === null) return null;
    raw = unwrapped;
  } catch (err) {
    log.warn(
      `failed to read credentials at ${path} (${err instanceof Error ? err.message : String(err)}); treating as missing`,
    );
    return null;
  }
  return parseCredentialFields(raw, path);
}

/**
 * Parse decrypted credential-file contents into string fields, or `null` when
 * the contents are unusable. Malformed contents degrade to "missing" so the
 * caller's existing wizard-recovery path can overwrite them, rather than
 * surfacing a raw `SyntaxError` the operator can do nothing with.
 */
function parseCredentialFields(raw: string, path: string): Record<string, string> | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    log.warn(
      `credentials at ${path} are not valid JSON; treating as missing — rerun the setup wizard to overwrite`,
    );
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    log.warn(
      `credentials at ${path} have unexpected shape (top-level value must be an object); treating as missing`,
    );
    return null;
  }
  // Tolerate Google's `{installed: {...}}` / `{web: {...}}` envelopes for
  // people pasting whatever the Cloud Console download gives them.
  const inner =
    typeof json.installed === "object" && json.installed
      ? (json.installed as Record<string, unknown>)
      : typeof json.web === "object" && json.web
        ? (json.web as Record<string, unknown>)
        : json;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inner)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Atomically write a credentials file with mode 0600. Writes to a
 * scratch file alongside the target, fsyncs it and the parent directory,
 * then renames — so a power loss after the rename can't resurrect a
 * stale or zero-byte creds file. See `atomic-write.ts` for the full
 * rationale.
 */
export async function writeProviderCredentials(
  fileKey: string,
  fields: Record<string, string>,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<void> {
  const path = providerCredentialsPath(fileKey, configDir);
  await writeSecretJsonFile(path, fields, { ...opts, configDir });
}

/** Remove the credentials file. No-op if absent. */
export async function clearProviderCredentials(fileKey: string, configDir?: string): Promise<void> {
  const path = providerCredentialsPath(fileKey, configDir);
  if (!existsSync(path)) return;
  await unlink(path);
}

/** Whether a credentials file currently exists. */
export function hasProviderCredentials(fileKey: string, configDir?: string): boolean {
  return existsSync(providerCredentialsPath(fileKey, configDir));
}

/**
 * Replace every occurrence of a secret value in `text` with `***`.
 *
 * Used on anything an auth flow reports outward — a provider's error message,
 * the subprocess's stderr tail — because a provider that echoes its input back
 * would otherwise put the pasted secret somewhere it is readable: the flow's
 * `errorMessage` is returned by `GET /admin/auth-flows` to every admin caller,
 * and the stderr tail is interpolated into a log line whenever a flow ends
 * without a terminal event.
 *
 * Substring replacement, deliberately: a value can appear inside a larger
 * string (a URL, a JSON blob, a stack frame), and short values are skipped
 * because redacting them would corrupt unrelated text without protecting
 * anything worth protecting.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Below this length a value carries too little entropy to be worth redacting,
 * and blanking it would mangle unrelated text that happens to contain it.
 */
const MIN_REDACTABLE_SECRET_LENGTH = 8;

// ── Per-account credential IO ──────────────────────────────────────────
//
// A `perAccount` spec's fields are the credential for ONE account, so they are
// stored under that account rather than in the provider-wide file. The
// directory doubles as the marker `discover()` scans, so a stored credential
// and a discoverable account are the same fact.

/** Directory under which every account's credential directory lives. */
function providerAccountsRoot(fileKey: string, configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, fileKey);
}

/** Directory holding one account's credential. */
function providerAccountDir(fileKey: string, accountId: string, configDir?: string): string {
  return join(providerAccountsRoot(fileKey, configDir), safePathSegment(accountId));
}

/** Path of one account's credential file. */
export function providerAccountCredentialsPath(
  fileKey: string,
  accountId: string,
  configDir?: string,
): string {
  return join(providerAccountDir(fileKey, accountId, configDir), "credentials.json");
}

/** Whether one account's credential is on disk. */
export function hasProviderAccountCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
): boolean {
  try {
    return existsSync(providerAccountCredentialsPath(fileKey, accountId, configDir));
  } catch {
    // `safePathSegment` throws on an id that can't be a path segment; such an
    // account can't have been stored in the first place.
    return false;
  }
}

/**
 * Account ids with a stored credential. This is what a `perAccount` provider's
 * `discover()` reads, so it must never throw: `safePathSegment` rejects rather
 * than sanitises, and one unusable directory name would otherwise take out the
 * whole provider's instantiation.
 */
export function listProviderAccountIds(fileKey: string, configDir?: string): string[] {
  const root = providerAccountsRoot(fileKey, configDir);
  if (!existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      if (existsSync(providerAccountCredentialsPath(fileKey, entry.name, configDir))) {
        ids.push(entry.name);
      }
    } catch {
      continue;
    }
  }
  return ids;
}

/**
 * Account directories present on disk, whether or not they hold a credential.
 *
 * An install predating per-account storage has directories that are empty
 * markers, so `listProviderAccountIds` (which requires a stored credential)
 * skips them. A provider's `discover()` still needs them, or the source
 * disappears before its credential can be adopted.
 */
export function listProviderAccountDirs(fileKey: string, configDir?: string): string[] {
  const root = providerAccountsRoot(fileKey, configDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Read one account's stored credential, or `null` when absent.
 *
 * Unlike `readProviderCredentials`, a failure to decrypt is re-thrown rather
 * than folded into `null`: a locked keyring means "can't read this right now",
 * and reporting that as "no credential" would send the caller to the paste
 * wizard for a credential the operator still owns.
 */
export async function readProviderAccountCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<Record<string, string> | null> {
  const path = providerAccountCredentialsPath(fileKey, accountId, configDir);
  if (!existsSync(path)) return null;
  const raw = await readSecretTextFile(path, { ...opts, configDir });
  if (raw === null) return null;
  return parseCredentialFields(raw, path);
}

/** Write one account's credential, owner-only, creating its directory. */
export async function writeProviderAccountCredentials(
  fileKey: string,
  accountId: string,
  fields: Record<string, string>,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<void> {
  const path = providerAccountCredentialsPath(fileKey, accountId, configDir);
  // The atomic writer creates missing parents at the default umask; create them
  // ourselves first so the account directory is owner-only like the file.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  await writeSecretJsonFile(path, fields, { ...opts, configDir });
}

/** Remove everything stored for one account. No-op when absent. */
export async function clearProviderAccountCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
): Promise<void> {
  await rm(providerAccountDir(fileKey, accountId, configDir), { recursive: true, force: true });
}

/**
 * Remove an account whose provider-wide file is a legacy account credential,
 * not a shared OAuth client secret. Host-created state directories are not
 * accounts in a migrated layout. In a legacy-only layout, however, empty
 * directories are the only account markers; retain the shared file while any
 * remain. Unknown filesystem or secret-store state must never justify deletion.
 */
export async function clearProviderAccountAndLegacyCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
): Promise<void> {
  const census = () => {
    let entries;
    try {
      entries = readdirSync(providerAccountsRoot(fileKey, configDir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { directories: 0, credentials: 0 };
      throw error;
    }
    let directories = 0;
    let credentials = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Cannot classify a symlinked account directory");
      if (!entry.isDirectory()) continue;
      directories++;
      try {
        const stat = lstatSync(providerAccountCredentialsPath(fileKey, entry.name, configDir));
        if (!stat.isFile()) throw new Error("Cannot classify an account credential path");
        credentials++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { directories, credentials };
  };
  const migrated = census().credentials > 0;
  await clearProviderAccountCredentials(fileKey, accountId, configDir);
  const remaining = census();
  if (migrated ? remaining.credentials > 0 : remaining.directories > 0) return;
  const legacyPath = providerCredentialsPath(fileKey, configDir);
  const raw = await readSecretTextFile(legacyPath, { configDir });
  // A malformed or unreadable credential is unknown, not proof of absence.
  const fields = raw === null ? null : parseCredentialFields(raw, legacyPath);
  if (fields && Object.keys(fields).length > 0) {
    await rm(legacyPath, { force: true });
  }
}

/**
 * Read one account's credential, adopting a pre-per-account shared file when
 * that is all an install has.
 *
 * Installs configured before per-account storage hold their only credential at
 * `<fileKey>-credentials.json`. The first read for an account copies it into
 * that account's own path and returns it, so the source keeps working and every
 * later read is per-account.
 *
 * Adoption re-encrypts rather than moving the file. A secret file's path is its
 * AES-GCM associated data (`secretFileScope`), so an envelope relocated on disk
 * fails authentication and reads as though the credential had vanished.
 *
 * A failed rewrite is not fatal: the fields are returned anyway and adoption is
 * retried on the next read, so a temporarily locked keyring degrades to "still
 * works, not yet migrated" instead of breaking the source.
 */
export async function loadOrAdoptProviderAccountCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<Record<string, string> | null> {
  const fields = await readProviderAccountOrLegacyCredentials(fileKey, accountId, configDir, opts);
  if (!fields || hasProviderAccountCredentials(fileKey, accountId, configDir)) return fields;
  try {
    await writeProviderAccountCredentials(fileKey, accountId, fields, configDir, opts);
    log.info(`Adopted shared ${fileKey} credentials into account ${accountId}`);
  } catch {
    log.warn(
      `Could not adopt shared ${fileKey} credentials into account ${accountId}; retrying on next read`,
    );
  }
  return fields;
}

/** Read an account's credential without adopting or rewriting legacy storage. */
export async function readProviderAccountOrLegacyCredentials(
  fileKey: string,
  accountId: string,
  configDir?: string,
  opts: SecretFileOptions = {},
): Promise<Record<string, string> | null> {
  const own = await readProviderAccountCredentials(fileKey, accountId, configDir, opts);
  if (own) return own;

  const legacyPath = providerCredentialsPath(fileKey, configDir);
  if (!existsSync(legacyPath)) return null;
  // Adopt only while the install has not migrated. Once some account holds its
  // own credential the shared file is a leftover, and handing it to a *different*
  // account would copy a live secret under a caller-supplied id and materialise
  // an account that was never connected.
  if (listProviderAccountIds(fileKey, configDir).length > 0) return null;
  const raw = await readSecretTextFile(legacyPath, { ...opts, configDir });
  if (raw === null) return null;
  const fields = parseCredentialFields(raw, legacyPath);
  if (!fields) return null;

  return fields;
}

// ── Spec serialization ─────────────────────────────────────────────────

/** JSON-safe projection — fields only, no functions. */
export interface SerializedProviderCredentialsSpec {
  fileKey: string;
  required: boolean;
  publicClient: boolean;
  /** See `ProviderCredentialsSpec.perAccount`. */
  perAccount?: boolean;
  fields: ProviderCredentialsField[];
  wizard: ProviderCredentialsSpec["wizard"];
}

export function serializeCredentialsSpec(
  spec: ProviderCredentialsSpec,
): SerializedProviderCredentialsSpec {
  return {
    fileKey: spec.fileKey,
    required: spec.required,
    publicClient: spec.publicClient ?? false,
    perAccount: spec.perAccount ?? false,
    fields: spec.fields,
    wizard: spec.wizard,
  };
}

/**
 * Validate a raw `fields` object against the spec — required-field
 * presence, type, pattern. Returns either a cleaned `Record<string,
 * string>` (trimmed values, only declared fields) or a result-shaped
 * error string the caller can wrap in its preferred error class
 * (`BadRequestError` for HTTP, `Error` for the WS path).
 *
 * Replaces two near-identical loops in
 * `gateway/src/http/routes/model-credentials.ts` and
 * `collector/src/source-ws-handlers.ts` (handleCredentialsSet).
 */
export function validateCredentialFields(
  fields: Record<string, unknown>,
  spec: { fields: ProviderCredentialsField[] },
): { ok: true; cleaned: Record<string, string> } | { ok: false; error: string } {
  const cleaned: Record<string, string> = {};
  for (const field of spec.fields) {
    const raw = fields[field.name];
    const absent =
      raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
    if (absent && field.required === false) continue;
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: false, error: `${field.label} (${field.name}) is required` };
    }
    const value = raw.trim();
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      return { ok: false, error: field.patternHint ?? `${field.label} has invalid format` };
    }
    cleaned[field.name] = value;
  }
  return { ok: true, cleaned };
}
