// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The operator's side of a connect flow, built for one run.
 *
 * Extracted from `auth-subprocess.ts` for the reason its emitters and its error
 * classifier were: that script runs a flow and calls `process.exit` at module
 * load, so nothing inside it can be imported by a test. This is the object a
 * provider is handed and the one place the contract's own rules live — what a
 * client may be asked to draw, how many times a rejected answer is asked again,
 * which secrets are added to the redaction set before they reach a provider,
 * and what a wait that ends without an answer becomes. Every one of those was
 * covered only at the ends of the path before this file existed.
 */

import { join } from "node:path";
import { safePathSegment } from "@omnesis/types";
import {
  AuthFailure,
  DEFAULT_CLIENT_RENDERS,
  parseFieldsAnswer,
  toWireChallenge,
  type AuthSession,
} from "@omnesis/source-sdk";
import { AnswerUnavailable } from "./auth-subprocess-stdin.js";
import type { Logger } from "@omnesis/core";
import type { StdinReceiver } from "./auth-subprocess-stdin.js";
import type { AuthSubprocessEvent } from "./auth-subprocess-protocol.js";

/** Everything one run of a flow needs, supplied rather than read from a module. */
export interface SessionInputs {
  /** The gateway flow this run belongs to; empty when there is none. */
  flowId: string;
  /** The account being renewed, when this is a re-authentication. */
  reauthAccountId?: string;
  /** The gateway's externally reachable origin, when it has one. */
  publicBaseUrl?: string;
  /** Where this install keeps its state. */
  configDir: string;
  /** The provider's own directory name under {@link SessionInputs.configDir}. */
  providerDir: string;
  /** What an older client collected before the flow started. */
  supplied: Readonly<Record<string, string>>;
  /** The challenge kinds the client driving this flow can draw, if it said. */
  declaredRenders?: readonly string[];
  /** Values that must never appear in anything this flow reports upward. */
  secretValues: string[];
  /** Where a challenge goes and where an answer comes back. */
  receiver: StdinReceiver;
  /** Puts one protocol line on the wire. */
  emit: (event: AuthSubprocessEvent) => void;
  /** The provider's logger, already redacting. */
  log: Logger;
}

/**
 * Put anything the schema marked secret into the redaction set.
 *
 * Before it reaches the provider, because a provider that echoes its input
 * into an error message would otherwise put the token on the flow record —
 * which the admin listing returns to every caller.
 */
function rememberSecrets(
  challenge: { schema: { fields: Record<string, { kind: string }> } },
  value: Record<string, unknown>,
  secretValues: string[],
): void {
  for (const [key, field] of Object.entries(challenge.schema.fields)) {
    if (field.kind !== "secret") continue;
    const supplied = value[key];
    if (typeof supplied === "string" && supplied.length > 0) secretValues.push(supplied);
  }
}

/**
 * Check the small fixed shapes the non-field challenges answer with.
 *
 * `fields` is checked against its own schema; these four have a shape the
 * contract fixes, and nothing else validated them — so the typed answer a
 * provider is promised was, until here, whatever a client happened to send.
 */
function coerceAnswer(
  challenge: { kind: string },
  answer: Record<string, unknown>,
): Record<string, unknown> {
  const str = (key: string): string => {
    const value = answer[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new AuthFailure("unknown", `Answer to a ${challenge.kind} challenge has no ${key}`);
    }
    return value;
  };
  switch (challenge.kind) {
    case "redirect":
      return {
        code: str("code"),
        ...(typeof answer.state === "string" ? { state: answer.state } : {}),
      };
    case "code":
      return { code: str("code") };
    case "widget":
      return {
        token: str("token"),
        ...(answer.metadata && typeof answer.metadata === "object"
          ? { metadata: answer.metadata }
          : {}),
      };
    default:
      return answer;
  }
}

/**
 * The operator's side of a flow, as the provider sees it.
 *
 * Every challenge leaves as one event and every answer arrives addressed by the
 * id that event carried, so a flow can ask more than once and an answer that
 * arrives late resolves the wait it belongs to rather than the next one.
 */
export function makeSession(inputs: SessionInputs): AuthSession {
  const {
    flowId,
    reauthAccountId,
    publicBaseUrl,
    configDir,
    providerDir,
    supplied,
    secretValues,
    receiver: stdinReceiver,
    emit: emitEvent,
    log: sessionLog,
  } = inputs;
  const clientRenders = new Set<string>(inputs.declaredRenders ?? DEFAULT_CLIENT_RENDERS);
  const requireRenderer = (kind: string): void => {
    if (!clientRenders.has(kind)) {
      throw new AuthFailure("unsupported", `This client cannot display a ${kind} challenge`, {
        remedy: "Use an updated client that supports this connection method.",
      });
    }
  };
  let issued = 0;
  const nextId = () => `c${++issued}`;
  return {
    // A re-auth names the account it is renewing; anything else is a first
    // connection. Reconfiguration has no separate trigger yet, so it is not
    // synthesised here — a reason the host cannot distinguish would be worse
    // than one it does not offer.
    reason: reauthAccountId ? "reauthenticate" : "connect",
    flowId,
    accountId: reauthAccountId,
    // Withheld without a flow id. Its presence is what a provider checks
    // before offering a redirect the host catches, and the host routes that
    // callback by the flow id it carries as `state`. Offering the origin
    // without one produces an authorize URL the gateway rejects after the
    // operator has already consented — the worst moment to find out.
    publicBaseUrl: flowId ? publicBaseUrl : undefined,
    // Whatever a client of the older shape collected up front: the credential
    // fields from its wizard, and the source parameters from its form.
    supplied,
    host: {
      log: sessionLog,
      now: () => new Date(),
      // A re-authentication knows which account it is renewing and gets that
      // account's own directory. A first connection does not yet know — the
      // account id is what the flow is about to resolve — and is given the
      // provider's directory rather than the config root, which is what a
      // provider writing staging state would otherwise scatter across.
      stateDir: reauthAccountId
        ? join(configDir, safePathSegment(providerDir), safePathSegment(reauthAccountId))
        : join(configDir, safePathSegment(providerDir)),
      configDir,
    },
    canShow(kind) {
      return clientRenders.has(kind);
    },
    show(challenge) {
      // Progress notices need no operator action. A legacy client can finish
      // an OAuth exchange even when it cannot display its final status text.
      if (challenge.kind === "wait" && !clientRenders.has("wait")) {
        sessionLog.info(challenge.title);
        return;
      }
      requireRenderer(challenge.kind);
      emitEvent({
        type: "challenge",
        id: nextId(),
        challenge: toWireChallenge(challenge),
        expectsAnswer: false,
      });
      // Also in the older shape, for a gateway one version behind this
      // collector. It has no branch for a challenge, so it would store
      // nothing and fan out an event its clients ignore — the operator
      // watching a spinner until the flow expires. A duplicate a newer
      // gateway ignores is the cheaper of the two mistakes.
      if (challenge.kind === "qr") emitEvent({ type: "qr", data: challenge.data });
      if (challenge.kind === "redirect") emitEvent({ type: "url", url: challenge.url });
    },
    async ask(challenge) {
      requireRenderer(challenge.kind);
      // Every wait below goes through this. A provider choosing a failure code
      // should not have to know that the channel it is waiting on rejects with
      // prose, and a provider that decided by matching that prose would be the
      // thing the typed vocabulary was written to delete.
      const waitFor = async <T>(receive: () => Promise<T>): Promise<T> => {
        try {
          return await receive();
        } catch (err) {
          if (err instanceof AnswerUnavailable) {
            switch (err.reason) {
              case "timed-out":
                throw new AuthFailure("timeout", err.message, {
                  remedy: "Start the connection again when you are ready to finish it.",
                });
              case "denied":
                // Someone was asked and said no. The opposite of a platform
                // that could not be reached, and not retryable by repeating
                // the identical request.
                throw new AuthFailure("denied", err.message);
              case "cancelled":
              case "closed":
                throw new AuthFailure("cancelled", err.message);
            }
          }
          throw err;
        }
      };
      // A field challenge that comes back wrong is asked again rather than
      // ending the flow. The operator mistyped one character of a token; the
      // alternative is that they start over, and are told only "unknown".
      // Bounded, because a client sending the same rejected answer forever is
      // a client, not an operator.
      if (challenge.kind === "fields") {
        let issues: string[] = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          const asked =
            attempt === 0
              ? challenge
              : {
                  ...challenge,
                  instructions: [challenge.instructions, issues.join("; ")]
                    .filter(Boolean)
                    .join(" — "),
                };
          const id = nextId();
          emitEvent({
            type: "challenge",
            id,
            challenge: toWireChallenge(asked),
            expectsAnswer: true,
          });
          const raw = await waitFor(() => stdinReceiver.receiveAnswer(id));
          const parsed = parseFieldsAnswer(challenge, { ...raw });
          if (parsed.ok) {
            rememberSecrets(challenge, parsed.value, secretValues);
            return parsed.value as never;
          }
          issues = parsed.issues;
        }
        throw new AuthFailure("credential-rejected", `Answer rejected: ${issues.join("; ")}`);
      }

      const id = nextId();
      emitEvent({
        type: "challenge",
        id,
        challenge: toWireChallenge(challenge),
        expectsAnswer: true,
      });
      // Also in the older shape, for a gateway one version behind. It has no
      // branch for a challenge, so an asked redirect would leave the operator
      // watching a spinner — and the older shape happens to work end to end
      // here, because the code it delivers arrives on the same receiver this
      // ask is waiting on. A client on this build drops the duplicate, and the
      // replay to a reconnecting one puts the challenge first so it can.
      if (challenge.kind === "redirect") emitEvent({ type: "url", url: challenge.url });
      // Two kinds already have a transport, and it is not this one. A
      // gateway-caught redirect's code arrives at `/oauth/callback` and a
      // widget's result at `/widget-result`, both of which resolve their own
      // receiver. Sending those answers through a third route as well would
      // mean two ways to answer one question, and a client picking the wrong
      // one would hang the flow with no error.
      const answer =
        challenge.kind === "redirect"
          ? { code: await waitFor(() => stdinReceiver.receiveCode()) }
          : challenge.kind === "widget"
            ? await waitFor(() => stdinReceiver.receiveWidgetResult())
            : await waitFor(() => stdinReceiver.receiveAnswer(id));
      // Every other kind returns a small, known shape. Checking it here keeps
      // the promise the answer type makes: a client is not the only thing that
      // can post one, and a provider reading `answer.code` should not have to
      // defend against it being a number.
      return coerceAnswer(challenge, { ...answer } as Record<string, unknown>) as never;
    },
  };
}
