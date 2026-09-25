// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a source's credential still works, and if not, what to do about it.
 *
 * The question used to be answered with a boolean, and a boolean has room for
 * exactly two of the situations that actually arise. Everything it could not
 * say grew its own channel: a consent deadline rode along on every sync result,
 * a withdrawn grant was recognised by matching substrings against an error
 * message, a platform unlinking a device arrived through a separate error
 * callback, and "the keyring is locked so I cannot tell" was indistinguishable
 * from "there is no credential". Four channels, one question.
 *
 * ## Named by remedy, not by cause
 *
 * Each state is named for what the operator would have to do, because that is
 * the only thing anyone downstream does with the answer. A lapsed consent and a
 * withdrawn grant are different events with the same remedy, and they are kept
 * apart only because the wording an operator should read differs. A grant that
 * is alive but too narrow is a third thing entirely — nothing has failed, and
 * re-authenticating without asking for more would change nothing.
 *
 * ## Answer from the credential, never from a request
 *
 * A state is read from what is stored: a token file exists, a session has not
 * passed its recorded expiry. It is not a health check. A provider that
 * answered by calling its upstream would turn every outage into a false
 * revocation, park every source under the account, and prompt the operator to
 * re-authenticate a credential that was never broken.
 *
 * Credentials that have genuinely stopped working are a sync concern: the sync
 * path throws, and the host records the state from that evidence.
 */

/** Nothing to do; the credential is good. */
export interface Connected {
  status: "connected";
  /** When the credential was established, if the provider knows. */
  since?: string;
  /**
   * When the grant lapses on its own, if the platform says so.
   *
   * Declared here rather than reported per sync so a host can warn before the
   * deadline instead of discovering it afterwards. A state that is `connected`
   * with a deadline in two days is still connected — whether that is worth
   * showing is the host's judgement, not the source's.
   */
  expiresAt?: string;
  /** What the grant actually covers, when the platform issues scopes. */
  scopes?: readonly string[];
}

/** Never connected. The remedy is to connect. */
export interface NeverConnected {
  status: "never-connected";
}

/** The grant lapsed on schedule. The remedy is to authenticate again. */
export interface Expired {
  status: "expired";
  at?: string;
}

/**
 * The grant was withdrawn — at the platform, by the operator, or by a policy.
 * The remedy is the same as expiry; the wording an operator should read is not.
 */
export interface Revoked {
  status: "revoked";
  at?: string;
  /** What the platform said, when it said anything useful. */
  detail?: string;
}

/**
 * The grant is alive but does not cover what the source needs.
 *
 * Distinct from a failure, because nothing has failed: authenticating again
 * without asking for the missing scopes would succeed and change nothing.
 */
export interface ScopeInsufficient {
  status: "scope-insufficient";
  missing: readonly string[];
}

/**
 * The platform severed this installation — a linked device removed, a session
 * ended from elsewhere. The remedy is to pair again, which is not the same
 * gesture as authenticating again.
 */
export interface Unlinked {
  status: "unlinked";
  detail?: string;
}

/**
 * The state cannot be read right now.
 *
 * A locked keyring, an unreadable file, a store on a volume that is not
 * mounted. This is emphatically not "no credential": treating it as one parks
 * every source under the account and asks the operator to re-authenticate
 * something that is fine.
 */
export interface UnknownConnection {
  status: "unknown";
  /** Why it could not be read, for a log and for an operator. */
  because: string;
}

export type ConnectionState =
  | Connected
  | NeverConnected
  | Expired
  | Revoked
  | ScopeInsufficient
  | Unlinked
  | UnknownConnection;

/**
 * Read an offline credential assessment without mistaking a storage failure
 * for an absent or revoked grant. Never wrap network requests or sync: their
 * failures must retain the normal retry/error path. Exception text is omitted
 * because it can contain secrets.
 */
export async function readConnectionState(
  read: () => ConnectionState | Promise<ConnectionState>,
): Promise<ConnectionState> {
  try {
    return await read();
  } catch {
    return {
      status: "unknown",
      because: "Stored credentials could not be read; check credential storage access.",
    };
  }
}

/** What an operator would have to do about a state. */
export type ConnectionRemedy =
  | "none"
  | "connect"
  | "authenticate-again"
  | "grant-more"
  | "pair-again"
  | "wait";

/**
 * The remedy a state calls for.
 *
 * The mapping lives here, once, so that a client rendering a banner, a command
 * line printing a hint and a push producer deciding whether to notify all agree
 * on what a state means. Two states share a remedy and stay separate anyway,
 * because what the operator should read differs.
 */
export function connectionRemedy(state: ConnectionState): ConnectionRemedy {
  switch (state.status) {
    case "connected":
      return "none";
    case "never-connected":
      return "connect";
    case "expired":
    case "revoked":
      return "authenticate-again";
    case "scope-insufficient":
      // Cleared only by a new authorization that asks for more. Nothing the
      // sync path observes can widen a grant, so a host that prompts on this
      // must stop prompting on its own schedule rather than waiting for a
      // state change to arrive.
      return "grant-more";
    case "unlinked":
      return "pair-again";
    case "unknown":
      // Nothing an operator can usefully do with "I could not read it". The
      // condition is transient by nature and clears on its own.
      return "wait";
  }
}

/**
 * Whether a state means the source cannot usefully sync at all.
 *
 * A switch rather than a list of the blocking arms, because the two differ in
 * what they do when someone adds a state. A list compiles unchanged and
 * classifies the new state as non-blocking, which is the dangerous default: a
 * source keeps ticking against a credential nobody can use, and the operator
 * sees an idle pill rather than a prompt.
 *
 * Note that this is not "does the operator need to do something" — two states
 * answer those questions differently, and both answers are deliberate. See
 * {@link connectionRemedy}.
 */
export function blocksSync(state: ConnectionState): boolean {
  switch (state.status) {
    case "never-connected":
    case "expired":
    case "revoked":
    case "unlinked":
      return true;
    case "connected":
      return false;
    case "scope-insufficient":
      // Something is missing, but what the grant does cover still works.
      // Stopping would cost the data it covers in order to signal the data it
      // does not, and nothing in the sync path can widen a grant anyway — only
      // a new authorization clears this, which is why it prompts without
      // stopping.
      return false;
    case "unknown":
      // A failure to read the credential, not a finding about it. Refusing to
      // sync would turn a locked keyring or an unmounted volume into an
      // outage, and it clears on its own.
      return false;
  }
}

/**
 * Whether a good credential is close enough to its deadline to say so.
 *
 * Derived, never stored. The lead time is the host's call — how early a warning
 * is useful depends on how hard re-authenticating is, which the source does not
 * know — so it is a parameter rather than a constant here.
 */
export function isExpiringWithin(
  state: ConnectionState,
  leadMs: number,
  now: Date = new Date(),
): boolean {
  if (state.status !== "connected" || !state.expiresAt) return false;
  const deadline = Date.parse(state.expiresAt);
  if (!Number.isFinite(deadline)) return false;
  const remaining = deadline - now.getTime();
  // A deadline already past is not "expiring": the credential is expired, and
  // saying otherwise would show a countdown that has already run out.
  return remaining > 0 && remaining <= leadMs;
}

/**
 * Read a state from the two facts most local sources have: whether a stored
 * credential is present, and when it lapses.
 *
 * A convenience for the common shape, not a requirement. A provider that knows
 * more — scopes, a revocation notice — constructs the state itself.
 */
export function stateFromStoredCredential(
  present: boolean,
  options: { expiresAt?: string; since?: string; now?: Date } = {},
): ConnectionState {
  if (!present) return { status: "never-connected" };
  const { expiresAt, since, now = new Date() } = options;
  const deadline = expiresAt === undefined ? undefined : Date.parse(expiresAt);
  const usable = deadline !== undefined && Number.isFinite(deadline);
  // An unparseable deadline is not treated as expiry: discarding a working
  // credential because its metadata is malformed is the more expensive
  // mistake, and a genuine failure still reaches the sync path with evidence.
  // It is dropped rather than carried, because a deadline nothing can compare
  // against is not a deadline — kept, it would render as a countdown that
  // never moves and warn nobody, ever.
  if (usable && deadline <= now.getTime()) return { status: "expired", at: expiresAt };
  return {
    status: "connected",
    ...(since ? { since } : {}),
    ...(usable ? { expiresAt } : {}),
  };
}
