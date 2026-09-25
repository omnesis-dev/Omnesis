// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Connecting an account: what the operator is asked, and how the answer comes
 * back.
 *
 * The old shape was a single long-lived call handed a bag of optional
 * callbacks — one to publish a URL, one to publish a QR code, one to publish a
 * widget configuration, and two injected promises to receive an answer. What a
 * flow could ask was therefore whatever the bag happened to contain, which had
 * three consequences worth naming.
 *
 * Nothing could be asked twice, or in sequence. A provider that needs a country
 * before it can name a bank had to smuggle those two questions in as *source
 * settings*, collected on a form that has nothing to do with authentication and
 * stored afterwards as though they configured the source.
 *
 * Nothing carried its own words. A QR code is just a string, so the instruction
 * telling the operator what to do with it was written into the shared client —
 * which is how a portal component came to contain the name of one particular
 * messaging app.
 *
 * And nothing distinguished a challenge that expects an answer from one that
 * does not. A browser redirect caught on the loopback interface is answered by
 * the provider's own listener; the same redirect caught by the gateway is
 * answered by the host handing back a code. Both went through the same
 * callback, so which one a provider meant was a matter of reading its body.
 *
 * ## Two primitives
 *
 * `show` puts something in front of the operator and returns. `ask` puts
 * something in front of the operator and waits for the typed answer that
 * challenge produces. Everything else is a challenge kind, and every challenge
 * carries the words that go with it.
 *
 * The flow itself is still a single resident call. That is not an oversight: a
 * QR pairing holds an open socket that tells the provider when the code was
 * scanned, and a loopback redirect holds an HTTP listener. A step machine that
 * returned between steps could hold neither.
 */

import { object, toSourceParams, type ConfigField, type ConfigSchema } from "./config-schema.js";
import type { ConnectionState } from "./connection-state.js";
import type { ProviderHost } from "./source-host.js";

/**
 * Why the flow is running.
 *
 * One code path for all three, which is what stops a re-authentication from
 * being a subtly different flow that gets tested less. A provider that must
 * behave differently branches on this rather than on whether an account id
 * happened to be supplied.
 */
export type AuthReason =
  /** No account yet. */
  | "connect"
  /** An account exists and its credential needs renewing. */
  | "reauthenticate"
  /** An account exists and its credential is fine; something else changes. */
  | "reconfigure";

interface ChallengeCommon {
  /**
   * A short imperative title, in the source's own words.
   *
   * Carried on the challenge rather than looked up by the client, because a
   * client that composed this sentence would need a branch per source, and
   * that branch is exactly what source encapsulation forbids.
   */
  title: string;
  /** One or two sentences telling the operator what to do. */
  instructions?: string;
}

/** Send the operator to a URL and let an authorization happen there. */
export interface RedirectChallenge extends ChallengeCommon {
  kind: "redirect";
  url: string;
  /**
   * Where the browser lands when the authorization completes.
   *
   * `loopback` — on a listener the provider runs on the machine executing the
   * flow. That machine is often not the one holding the operator's browser,
   * so a client shows this challenge with the warning that says so.
   *
   * `gateway` — on the host's own callback route, which works from any
   * browser that can reach the gateway.
   *
   * `elsewhere` — nowhere this host can see. The provider's own page runs the
   * whole exchange and reports the outcome through a channel of its own, so
   * the operator's browser can be on any machine and no redirect comes back.
   *
   * This says nothing about how the answer comes back: that is `show` versus
   * `ask`. A provider that runs a loopback listener and *also* accepts a
   * pasted redirect URL asks, and races its own listener against the answer —
   * which is what every OAuth provider in this tree does, because a browser
   * on another machine has no other way through.
   */
  via: "loopback" | "gateway" | "elsewhere";
  /** When the authorization URL stops being valid, if it does. */
  expiresAt?: string;
}

/** Ask the operator to bring back a code from somewhere else. */
export interface CodeChallenge extends ChallengeCommon {
  kind: "code";
  /** A serialisable shape check a client can apply before sending. */
  pattern?: string;
  /** What to say when {@link pattern} does not match. */
  patternHint?: string;
}

/** Show a code to be scanned by an app on another device. */
export interface QrChallenge extends ChallengeCommon {
  kind: "qr";
  /** The payload to encode, not an image: the client decides how to render. */
  data: string;
  /**
   * When this code stops working, for platforms that rotate them.
   *
   * A client can use it to show the operator that a fresh code is coming
   * rather than leaving a dead one on screen.
   */
  expiresAt?: string;
}

/**
 * Collect values from the operator.
 *
 * The schema is the same declaration a source uses for its settings, so a
 * client that can render one can render the other, and a value is validated
 * the same way in both places. This is what a multi-step flow is made of: ask
 * for a country, then use the answer to build the next challenge.
 */
export interface FieldsChallenge extends ChallengeCommon {
  kind: "fields";
  schema: ConfigSchema;
  /**
   * Values to start the form with.
   *
   * Its own field rather than folded into the schema, because a prefill is a
   * fact about this particular attempt — the account being re-authenticated,
   * what the operator typed a moment ago — and not about what the source
   * accepts.
   */
  prefill?: Record<string, string>;
}

/** Hand off to a third party's own embedded flow. */
export interface WidgetChallenge extends ChallengeCommon {
  kind: "widget";
  /** Which renderer the client should load, named by the provider. */
  renderer: string;
  /** What that renderer needs; opaque to everything in between. */
  payload: Record<string, string>;
}

/**
 * Say what is happening while the operator waits.
 *
 * Not a question. It exists because a flow that goes quiet for thirty seconds
 * while it exchanges tokens is indistinguishable from one that has hung.
 */
export interface WaitNotice extends ChallengeCommon {
  kind: "wait";
}

/** The kinds a challenge can take, as a value a client can enumerate. */
export const AUTH_CHALLENGE_KINDS = ["redirect", "code", "qr", "fields", "widget", "wait"] as const;

export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];

/**
 * What a client that has not said anything is assumed to render.
 *
 * Only the URL and QR events have a legacy transport. Typed questions need
 * an explicit declaration; otherwise asking one leaves an older client
 * waiting for a form it cannot display.
 */
export const DEFAULT_CLIENT_RENDERS: readonly AuthChallengeKind[] = ["redirect", "qr"];

export type AuthChallenge =
  | RedirectChallenge
  | CodeChallenge
  | QrChallenge
  | FieldsChallenge
  | WidgetChallenge
  | WaitNotice;

/**
 * A challenge the operator answers through the host.
 *
 * A redirect qualifies whatever it lands on. Where it lands decides what a
 * client warns about; whether an answer may come back is decided by the
 * provider calling `ask` rather than `show`.
 */
export type AskableChallenge =
  | RedirectChallenge
  | CodeChallenge
  | FieldsChallenge
  | WidgetChallenge;

/** A challenge that expects nothing back through the session. */
export type ShowableChallenge = RedirectChallenge | QrChallenge | WaitNotice;

/** What the operator's answer to a given challenge looks like. */
export type AuthAnswer<C extends AskableChallenge> = C extends { kind: "redirect" }
  ? { code: string; state?: string }
  : C extends { kind: "code" }
    ? { code: string }
    : C extends { kind: "fields" }
      ? Record<string, string>
      : C extends { kind: "widget" }
        ? { token: string; metadata?: Record<string, unknown> }
        : never;

/** The account a flow connected, and the state it left the credential in. */
export interface ConnectedAccount {
  accountId: string;
  /**
   * Reported rather than re-derived, so the host does not have to go and ask a
   * question the flow has just answered — and so a deadline the platform
   * mentioned only during the exchange is not lost.
   */
  state: ConnectionState;
}

/**
 * Something that went wrong without stopping the connection.
 *
 * A flow has exactly two shapes to report in: it returns, or it throws. That
 * leaves nowhere for the case where the account is connected and something the
 * operator would want to know did not happen — and at least one source has a
 * step that can only be taken once, in a window minutes wide, whose failure
 * costs every record older than a few months until the next re-authorization.
 * Today it logs a warning nobody reads and reports success.
 */
export interface AuthNotice {
  /** One sentence naming what did not happen. */
  title: string;
  /** What it costs, and what the operator could do about it. */
  detail?: string;
}

export interface AuthResult {
  accounts: ConnectedAccount[];
  /**
   * What went wrong without stopping this. Shown beside the success, because
   * an operator told only "connected" has no reason to look again.
   */
  notices?: AuthNotice[];
}

/** Why a flow ended without connecting anything. */
export type AuthFailureCode =
  /** The operator stopped it. */
  | "cancelled"
  /** The operator was asked and said no. */
  | "denied"
  /** A challenge went stale before it was answered. */
  | "challenge-expired"
  /** It authenticated, but as a different account than the one being renewed. */
  | "identity-mismatch"
  /** The application-level credential this provider needs is not configured. */
  | "missing-credentials"
  /** It authenticated, and then the credential could not be stored. */
  | "credential-persist-failed"
  /** The platform will not do this here — wrong OS, missing dependency. */
  | "unsupported"
  /** The platform could not be reached; trying again later may work. */
  | "unavailable"
  /**
   * The credential the operator supplied is not usable, whoever refused it.
   *
   * A wrong password or a revoked key, where the platform refused. A key
   * carrying permissions the source will not hold, an account whose plan does
   * not include the API, a value that is not the shape the platform issues —
   * where the platform would have accepted it and Omnesis did not. Both are
   * one code because a client does the same thing with them: it asks again.
   *
   * Not `denied`, which is a person being asked and saying no, and not
   * `missing-credentials`, which is having nothing to present at all.
   * Retryable, because the retry is the operator supplying a different one.
   */
  | "credential-rejected"
  /**
   * The transport could not be trusted: an expired or self-signed
   * certificate, a name it does not cover. Kept apart from `unavailable`
   * because it will not clear by waiting.
   */
  | "insecure-connection"
  /**
   * The credential leads to data already connected under another account.
   *
   * Nothing refused it. Omnesis declined, because connecting the same
   * records twice would have two sources overwriting each other.
   */
  | "duplicate"
  /**
   * Something on this machine is in the way — the loopback port a redirect
   * has to land on is taken. Local, so not `unavailable`; fixable, so not
   * `unsupported`.
   */
  | "local-conflict"
  /**
   * Nobody answered in time.
   *
   * Distinct from `challenge-expired`, which is the thing shown going stale:
   * here the authorization is still good and the flow stopped waiting.
   */
  | "timeout"
  /** Anything else. */
  | "unknown";

/**
 * A flow that ended without connecting anything.
 *
 * Typed because the alternative is what it replaces: a message string, matched
 * downstream against a list of substrings to decide whether the operator
 * should be asked to try again. `unavailable` and `denied` are the pair that
 * list kept confusing, and they are opposites — one clears on its own, and one
 * never will.
 */
export class AuthFailure extends Error {
  readonly code: AuthFailureCode;
  /** What the operator could do about it, when there is something. */
  readonly remedy?: string;
  /**
   * How long to wait before trying again, when the platform said.
   *
   * `unavailable` tells an operator to come back; this tells them when, and
   * the difference between "try again" and "try again in six hours" is whether
   * they spend the afternoon retrying. Two platforms state it — one on a
   * `Retry-After` header, one as a fixed cap after a bank refuses — and
   * without somewhere to put it both were rounded to the same shrug.
   */
  readonly retryAfterMs?: number;

  constructor(
    code: AuthFailureCode,
    message: string,
    options?: { remedy?: string; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "AuthFailure";
    this.code = code;
    this.remedy = options?.remedy;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** Whether trying the same flow again could plausibly succeed. */
export function isRetryable(code: AuthFailureCode): boolean {
  // `denied` is not retryable by the same flow: repeating the identical
  // request to someone who just refused it is how a prompt becomes a loop.
  // The three added here are retryable for three different reasons: the
  // operator supplies a different credential, frees the port, or simply comes
  // back — and each was previously either `unknown` (never retry) or
  // `unavailable` (retry forever, which for an untrusted certificate is the
  // same circle by a different route).
  switch (code) {
    case "unavailable":
    case "challenge-expired":
    case "cancelled":
    case "credential-rejected":
    case "local-conflict":
    case "timeout":
      return true;
    default:
      return false;
  }
}

/**
 * The operator's side of a flow, and the services the flow runs with.
 *
 * Handed to the provider rather than assembled by it, so a provider cannot
 * reach a channel the host did not offer, and so a test can drive a whole
 * multi-step flow by scripting the answers.
 */
export interface AuthSession {
  readonly reason: AuthReason;
  /** Identifies this attempt; a provider embeds it in a redirect's state. */
  readonly flowId: string;
  /** The account being renewed or reconfigured, when there is one. */
  readonly accountId?: string;
  /**
   * The origin a gateway-caught redirect would return to.
   *
   * Absent when the host has none, which is what a provider checks before
   * offering `via: "gateway"`.
   */
  readonly publicBaseUrl?: string;
  /** Logger, clock and the account's own directory. */
  readonly host: ProviderHost;

  /**
   * Values the host already collected before the flow started.
   *
   * The older model collected a provider's credential fields on a wizard and
   * its source parameters on a form, both before anything ran, and handed them
   * in. A flow that can ask does not need that — but a client one version
   * behind still does it, and refusing to look would mean asking the operator
   * for the same token twice, or not at all.
   *
   * So a provider reads this first and asks only for what is missing. It is a
   * bridge, not a channel: when the supported-client floor passes the release
   * that made asking possible, this goes and every value is asked for.
   */
  readonly supplied: Readonly<Record<string, string>>;

  /**
   * Whether the client waiting on this flow can draw this kind of challenge.
   *
   * The contract has no negotiation elsewhere, and one kind needs it: a widget
   * names a renderer the client must already have. A provider that emitted one
   * to a client without it did not fail — it waited, for thirty minutes, and
   * then reported a timeout. The older shape caught this by the absence of a
   * callback; a session always has `ask`, so the guard had to become a
   * question the provider can ask instead.
   *
   * A provider that needs a kind and cannot have it should say so at once,
   * with `unsupported` and a remedy naming a client that can.
   */
  canShow(kind: AuthChallengeKind): boolean;

  /** Put something in front of the operator and carry on. */
  show(challenge: ShowableChallenge): void;

  /** Put something in front of the operator and wait for their answer. */
  ask<C extends AskableChallenge>(challenge: C): Promise<AuthAnswer<C>>;
}

// ─── Crossing a wire ────────────────────────────────────────────────────────

/**
 * A challenge as it reaches a client.
 *
 * Same information, no functions. The authoring form of a field challenge
 * carries a schema, which is a parser and therefore cannot be serialised; what
 * a client needs from it is the form to render, which is data. Keeping the two
 * types apart lets a provider declare the ergonomic one and lets every client —
 * including the ones written in another language — decode the other.
 */
export type WireChallenge =
  | RedirectChallenge
  | CodeChallenge
  | QrChallenge
  | WidgetChallenge
  | WaitNotice
  | {
      kind: "fields";
      title: string;
      instructions?: string;
      /** The same form shape a source's settings produce. */
      fields: ReturnType<typeof toSourceParams>;
      prefill?: Record<string, string>;
    };

/** Reduce a challenge to what can cross a wire. */
export function toWireChallenge(challenge: AuthChallenge): WireChallenge {
  if (challenge.kind !== "fields") return challenge;
  const { schema, ...rest } = challenge;
  // No probe: a challenge is rendered by clients, and a validator is a
  // function. What the host can check, it checks when the answer comes back.
  return { ...rest, fields: toSourceParams(schema, undefined, { includeAdvanced: true }) };
}

/**
 * Check an answer against the schema the challenge was built from.
 *
 * Run on the host, because the schema lives there. A client may have applied
 * the serialisable constraints already; this is the boundary that decides.
 */
export function parseFieldsAnswer(
  challenge: FieldsChallenge,
  answer: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] } {
  const parsed = challenge.schema.parse(answer);
  if (parsed.ok) return { ok: true, value: parsed.value as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)),
  };
}

/**
 * The fields of a credentials spec, as a challenge a flow can ask.
 *
 * Those fields were always a question put to the operator; what differed was
 * who asked. A client collected them before the flow started and handed them
 * in, which meant they could only ever be asked once, before anything was
 * known — so a token that turned out to be wrong ended the flow instead of
 * being asked for again, and a flow that needed a second secret only after
 * seeing the first could not have one.
 *
 * A secret field stays a secret field: the schema marks it, so a client masks
 * it and the host keeps it out of logs.
 */
export function credentialsChallenge(
  spec: {
    fields: ReadonlyArray<{
      name: string;
      label: string;
      placeholder?: string;
      default?: string;
      secret?: boolean;
      required?: boolean;
      pattern?: string;
      patternHint?: string;
    }>;
  },
  copy: { title: string; instructions?: string },
): FieldsChallenge {
  const fields: Record<string, ConfigField> = {};
  for (const f of spec.fields) {
    const common = {
      label: f.label,
      required: f.required ?? true,
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
    };
    const shape = {
      ...(f.pattern ? { pattern: f.pattern } : {}),
      ...(f.patternHint ? { patternHint: f.patternHint } : {}),
    };
    // Written as two branches rather than one object with a computed `kind`,
    // because the union is discriminated on that field: a `"string" | "secret"`
    // kind describes no member of it.
    fields[f.name] = f.secret
      ? { ...common, ...shape, kind: "secret" }
      : { ...common, ...shape, kind: "string" };
  }
  return { kind: "fields", ...copy, schema: object(fields) };
}
