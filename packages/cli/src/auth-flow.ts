// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createInterface, type Interface } from "node:readline";
import { isAuthErrorCode, type AuthErrorCode } from "@omnesis/core";
import { parseAuthCodeInput } from "./auth-code-input.js";
import { c, gatewayFetch, gatewayJson, buildCliFx, linkify, withSpinner } from "./utils.js";

/**
 * Outcome of a runAuthFlow call. `accountId` set on success.
 * `missingCredentials` carries the provider's fileKey/name when the auth
 * subprocess refused for lack of user-supplied OAuth credentials — callers
 * can then run the credentials wizard and retry without polluting the CLI
 * with raw error text.
 */
export interface AuthFlowOutcome {
  accountId?: string;
  missingCredentials?: { fileKey: string; providerName: string };
  errorMessage?: string;
}

/**
 * Optional knobs for a flow run, derived from the source's serialized
 * descriptor and the calling command's context.
 */
export interface AuthFlowOptions {
  /**
   * The descriptor's `acceptsAuthCode` capability: the provider's
   * authFlow consumes externally delivered codes via `receiveCode`. The
   * manual paste prompt is only armed when true — for any other flow a
   * pasted code would be buffered unread and strand it in `completing`.
   */
  acceptsAuthCode?: boolean;
  /**
   * Set when re-authenticating an existing account (`cli reauth`).
   * Forwarded on `POST /admin/auth-flows` so the provider's authFlow
   * receives it as `callbacks.accountId` and can reuse stored
   * per-account parameters.
   */
  accountId?: string;
  /**
   * Fields the user pasted for a `perAccount` credentials spec. Forwarded on
   * `POST /admin/auth-flows` so the provider probes with them and stores them
   * under the account it resolves — nothing is written before that succeeds.
   */
  credentials?: Record<string, string>;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled auth error code: ${String(x)}`);
}

/**
 * Decode an `AuthErrorCode` payload into the shape the caller cares about.
 * Adding a new code in `@omnesis/core/auth-error-codes.ts` will force this
 * `switch` to either handle the new case or call `assertNever` and refuse to
 * compile — that's the point. The previous string-compare on
 * `payload.code === "missing-credentials"` silently dropped any new codes
 * the producer side started emitting.
 */
function handleAuthErrorCode(
  code: AuthErrorCode,
  payload: Record<string, unknown>,
): { fileKey: string; providerName: string } | undefined {
  switch (code) {
    case "missing-credentials":
      if (typeof payload.fileKey === "string" && typeof payload.providerName === "string") {
        return { fileKey: payload.fileKey, providerName: payload.providerName };
      }
      return undefined;
    case "credential-persist-failed":
    case "user-cancelled":
    case "timeout":
    case "denied":
    case "challenge-expired":
    case "identity-mismatch":
    case "unsupported":
    case "unavailable":
    case "credential-rejected":
    case "insecure-connection":
    case "duplicate":
    case "local-conflict":
    case "unknown":
      // Terminal failures with nothing for a wizard to recover: the
      // message and remedy are all the operator gets, so `reportFailure`
      // prints them.
      return undefined;
    default:
      return assertNever(code);
  }
}

/**
 * Say why a flow failed. The one failure that is not printed is a missing
 * application credential the flow can name: the setup wizard that follows
 * is the answer to it. Every other code — a rejected password, an
 * unreachable server — has only its message and remedy to explain it.
 */
function reportFailure(
  payload: Record<string, unknown>,
  errorMessage: string,
): { fileKey: string; providerName: string } | undefined {
  const missing = isAuthErrorCode(payload.code)
    ? handleAuthErrorCode(payload.code, payload)
    : undefined;
  if (!missing) console.error(`${c.red}Auth error: ${errorMessage}${c.reset}`);
  printRemedy(payload);
  return missing;
}

/**
 * Report what went wrong without stopping the connection.
 *
 * A flow returns or it throws, and one step in one source can only be taken
 * once, in a window minutes wide. Reporting only the success leaves the
 * operator no reason to look again.
 */
function printNotices(payload: Record<string, unknown>): void {
  const notices = Array.isArray(payload.notices) ? payload.notices : [];
  for (const raw of notices) {
    const notice = raw as { title?: unknown; detail?: unknown };
    if (typeof notice.title !== "string") continue;
    console.error(`${c.yellow}${notice.title}${c.reset}`);
    if (typeof notice.detail === "string" && notice.detail.trim()) {
      console.error(`${c.dim}${notice.detail}${c.reset}`);
    }
  }
}

/**
 * Every challenge kind a terminal can draw.
 *
 * `widget` is absent, and its absence is the point: a hosted widget is a page
 * a client loads and renders, and there is no terminal equivalent. Before the
 * flow could be asked, a provider needing one detected the missing callback
 * and failed immediately with a sentence naming the portal. A session always
 * offers `ask`, so that guard had nothing to detect — and the failure it
 * prevented came back as a thirty-minute wait ending in "timed out".
 */
const CLI_RENDERS = ["redirect", "code", "qr", "fields", "wait"];

/**
 * Say what the operator can do about it, when the source said.
 *
 * A code says which class of thing went wrong and is what a client switches
 * on; the remedy is the sentence only the source can write. For a platform
 * with no account chooser, "sign out in your browser first" is not a nicety —
 * it is the whole recovery, and no code can carry it.
 */
function printRemedy(payload: Record<string, unknown>): void {
  if (typeof payload.remedy === "string" && payload.remedy.trim()) {
    console.error(`${c.dim}${payload.remedy}${c.reset}`);
  }
  if (typeof payload.retryAfterMs === "number" && payload.retryAfterMs > 0) {
    console.error(`${c.dim}Try again in ${describeWait(payload.retryAfterMs)}.${c.reset}`);
  }
}

/**
 * A wait an operator can act on.
 *
 * Rounded on purpose. What they need to decide is whether to sit here or come
 * back later, and a figure to the second invites them to believe it is exact
 * when it is the platform's own estimate.
 */
export function describeWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

/**
 * Drive an auth flow via the gateway. Starts the flow, then consumes the SSE
 * event stream until the terminal `complete` event arrives. Renders the
 * provider's URL / QR / device-code prompts to the user as they come in.
 *
 * Shared between `cli add <source>` (first-time pairing) and
 * `cli reauth <provider>` (token rotation only). Returns the resolved
 * accountId or `undefined` on error. For richer outcome introspection
 * (missing-credentials routing, etc.) call `runAuthFlowDetailed`.
 */
/**
 * Put one typed challenge to the operator, and send back what they say.
 *
 * Every branch renders a *kind*. The title and the instructions come from the
 * provider, which is the only party that knows what an operator is meant to do
 * with a pairing code or a consent screen — and the reason this function has
 * no branch that names a platform.
 */
async function renderChallenge(
  flowId: string,
  payload: Record<string, unknown>,
): Promise<{ wantsPastedCode: boolean }> {
  const challenge = payload.challenge as Record<string, unknown> | undefined;
  const challengeId = typeof payload.id === "string" ? payload.id : undefined;
  // A collector that predates the field says nothing; treat that as a question,
  // which every kind this function prompts for was before the field existed.
  const expectsAnswer = payload.expectsAnswer !== false;
  if (!challenge || !challengeId) return { wantsPastedCode: false };

  const title = typeof challenge.title === "string" ? challenge.title : "";
  if (title) console.log(`\n${c.bold}${title}${c.reset}`);
  if (typeof challenge.instructions === "string") {
    console.log(`${c.dim}${challenge.instructions}${c.reset}`);
  }

  const send = async (answer: Record<string, unknown>): Promise<void> => {
    const post = await gatewayFetch(`/admin/auth-flows/${encodeURIComponent(flowId)}/answer`, {
      method: "POST",
      body: JSON.stringify({ challengeId, answer }),
    });
    if (post.ok) return;
    // 409 means the flow moved on — typically because the operator finished
    // the same step somewhere else. Not an error worth alarming them about.
    if (post.status === 409) {
      console.log(`${c.dim}Already answered elsewhere.${c.reset}`);
      return;
    }
    const body = await post.text().catch(() => "");
    console.error(`${c.red}Could not send your answer: ${post.status} ${body}${c.reset}`);
  };

  switch (challenge.kind) {
    case "redirect": {
      const url = String(challenge.url ?? "");
      const fx = await buildCliFx();
      if (challenge.via === "loopback") {
        // Host knowledge, not the source's: where the redirect lands is a fact
        // about the machine running the flow, and this CLI may be on another
        // one. The provider's own words are already printed above.
        console.log(
          `${c.dim}This redirect lands on the machine running the collector. ` +
            `If that is not this one, open the URL there${
              expectsAnswer ? " — or open it here and paste the address you land on" : ""
            }.${c.reset}`,
        );
      }
      console.log(`\n  ${c.cyan}${linkify(url, url, fx)}${c.reset}\n`);
      return { wantsPastedCode: expectsAnswer };
    }
    case "qr": {
      const data = String(challenge.data ?? "");
      try {
        const qrTerminal = await import("qrcode-terminal");
        qrTerminal.default.generate(data, { small: true });
      } catch {
        /* rendering failed — the raw payload below is the fallback */
      }
      console.log(
        `\n${c.dim}Paste this into the app instead of scanning, if needed:${c.reset}\n${data}\n`,
      );
      return { wantsPastedCode: false };
    }
    case "code": {
      if (!expectsAnswer) return { wantsPastedCode: false };
      const prompts = await import("@clack/prompts");
      const answer = await prompts.text({ message: title || "Code" });
      if (prompts.isCancel(answer)) return { wantsPastedCode: false };
      await send({ code: String(answer).trim() });
      return { wantsPastedCode: false };
    }
    case "fields": {
      if (!expectsAnswer) return { wantsPastedCode: false };
      const prompts = await import("@clack/prompts");
      const fields = Array.isArray(challenge.fields) ? challenge.fields : [];
      const answer: Record<string, unknown> = {};
      for (const raw of fields) {
        const f = raw as Record<string, unknown>;
        const label = String(f.label ?? f.name);
        // A field carrying options is a choice, and typing one of them back by
        // hand is not answering a choice — it is guessing at the spelling of an
        // answer that was on the screen a moment ago.
        const options = Array.isArray(f.options)
          ? (f.options as Array<Record<string, unknown>>)
          : [];
        const value =
          options.length > 0
            ? await prompts.select({
                message: label,
                options: options.map((o) => ({
                  value: String(o.value),
                  label: String(o.label ?? o.value),
                })),
              })
            : f.type === "secret"
              ? await prompts.password({ message: label })
              : await prompts.text({
                  message: label,
                  placeholder: typeof f.placeholder === "string" ? f.placeholder : undefined,
                });
        if (prompts.isCancel(value)) return { wantsPastedCode: false };
        answer[String(f.name)] = value;
      }
      await send(answer);
      return { wantsPastedCode: false };
    }
    default:
      // A `wait` notice, or a kind this build does not render. The title and
      // instructions above are all there is to show, and there is nothing to
      // answer, so silence here is correct rather than a gap.
      return { wantsPastedCode: false };
  }
}

export async function runAuthFlow(
  ctx: { deviceId: string },
  sourceType: string,
  params: Record<string, string>,
  options: AuthFlowOptions = {},
): Promise<string | undefined> {
  const out = await runAuthFlowDetailed(ctx, sourceType, params, options);
  return out.accountId;
}

export async function runAuthFlowDetailed(
  ctx: { deviceId: string },
  sourceType: string,
  params: Record<string, string>,
  options: AuthFlowOptions = {},
): Promise<AuthFlowOutcome> {
  let started: { flowId?: string };
  try {
    started = await withSpinner("Starting auth flow", () =>
      gatewayJson<{ flowId: string }>(`/admin/auth-flows`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: ctx.deviceId,
          sourceType,
          params: Object.keys(params).length > 0 ? params : undefined,
          accountId: options.accountId,
          credentials: options.credentials,
          renders: CLI_RENDERS,
        }),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}Auth flow failed to start: ${msg}${c.reset}`);
    return { errorMessage: msg };
  }

  const flowId = started.flowId;
  if (!flowId) {
    console.error(`${c.red}Auth flow start did not return a flowId${c.reset}`);
    return { errorMessage: "missing flowId" };
  }

  // Subscribe to the SSE event stream.
  const res = await gatewayFetch(`/admin/auth-flows/${encodeURIComponent(flowId)}/events`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    console.error(`${c.red}Auth event stream failed: ${res.status} ${body}${c.reset}`);
    return { errorMessage: `event stream ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let resolvedAccountId: string | undefined;
  let errorMessage: string | undefined;
  let missingCredentials: { fileKey: string; providerName: string } | undefined;

  // ── Manual code paste, racing the SSE stream ──
  //
  // For URL-based flows whose provider consumes externally delivered
  // codes (descriptor `acceptsAuthCode`), the redirect may land somewhere
  // this CLI can't see (gateway on another host, provider that refuses
  // localhost). So alongside the SSE listener we offer a paste prompt:
  // the user drops in the full redirect URL (or just the code) and we
  // POST it to the gateway, which forwards it to the collector. Whichever
  // side finishes first wins — an external completion tears the prompt
  // down, and a paste that loses the race gets a wrong-state response the
  // gateway answers with 409, which we surface as info, not an error.
  // Flows without the capability never get the prompt: their subprocess
  // would buffer the code unread and the flow would hang in `completing`.
  let rl: Interface | null = null;
  let terminalSeen = false;
  // A typed challenge carries its own words and its own answer path, so the
  // legacy `url` / `qr` echo that follows it — sent for the benefit of a
  // gateway one version behind — is a duplicate here and is dropped.
  let typedChallengeSeen = false;
  let challengeWantsPastedCode = false;
  let promptGeneration = 0;
  let promptShown = false;
  let codeDelivered = false;

  const closePrompt = (): void => {
    if (rl) {
      rl.close();
      rl = null;
    }
  };

  const handlePaste = async (answer: string, generation: number): Promise<void> => {
    if (terminalSeen || generation !== promptGeneration) return;
    if (!answer.trim()) {
      startPastePrompt(); // bare Enter — re-arm
      return;
    }
    let code: string;
    try {
      code = parseAuthCodeInput(answer);
    } catch (err) {
      console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      startPastePrompt();
      return;
    }
    // A network-level fetch failure (gateway restart, transient blip) must
    // surface as an error line + re-armed prompt. `handlePaste` is invoked
    // fire-and-forget, so an uncaught rejection here would otherwise kill
    // the whole CLI process with a stack trace.
    let post: Awaited<ReturnType<typeof gatewayFetch>>;
    try {
      post = await gatewayFetch(`/admin/auth-flows/${encodeURIComponent(flowId)}/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    } catch (err) {
      if (terminalSeen || generation !== promptGeneration) return;
      console.error(
        `${c.red}Code delivery failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
      startPastePrompt();
      return;
    }
    if (terminalSeen || generation !== promptGeneration) return;
    if (post.ok) {
      codeDelivered = true;
      console.log(`${c.dim}Code delivered — completing…${c.reset}`);
      return; // terminal outcome arrives over the SSE stream
    }
    if (post.status === 409) {
      // Wrong state — the flow already advanced (typically: completed in
      // the browser while the paste was in flight). Informational only.
      console.log(`${c.dim}Flow already advanced — code not needed.${c.reset}`);
      return;
    }
    const bodyText = await post.text().catch(() => "");
    console.error(`${c.red}Code delivery failed: ${post.status} ${bodyText}${c.reset}`);
    startPastePrompt();
  };

  const startPastePrompt = (): void => {
    // The descriptor capability is how a provider on the older entry point
    // says it reads a pasted code. A typed challenge says so per challenge,
    // which is a better answer to the same question: the same provider may
    // ask for one on a first connect and not on a renewal.
    if (typedChallengeSeen ? !challengeWantsPastedCode : options.acceptsAuthCode !== true) return;
    if (rl || terminalSeen || !process.stdin.isTTY) return;
    promptShown = true;
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const generation = promptGeneration;
    rl.question(
      `${c.dim}Paste the full redirect URL or code (or finish in the browser): ${c.reset}`,
      (answer) => {
        if (generation !== promptGeneration) return;
        closePrompt();
        void handlePaste(answer, generation);
      },
    );
  };

  const onTerminal = (): void => {
    terminalSeen = true;
    if (promptShown && !codeDelivered && resolvedAccountId) {
      console.log(`${c.dim}Completed in browser.${c.reset}`);
    }
    closePrompt();
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE frames (separated by \n\n)
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (!frame.trim()) continue;

      let eventName = "message";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataLine);
      } catch {
        continue;
      }

      if (eventName === "snapshot") continue;
      if (eventName !== "auth") continue;

      const evType = payload.type as string | undefined;
      if (evType === "url") {
        const url = typeof payload.url === "string" ? payload.url : undefined;
        if (url && !typedChallengeSeen) {
          // On supporting terminals the URL becomes an OSC 8 hyperlink — one
          // cmd-click opens the provider consent page without copy-paste.
          const fx = await buildCliFx();
          console.log(
            `Open this URL in your browser:\n\n  ${c.cyan}${linkify(url, url, fx)}${c.reset}\n`,
          );
          startPastePrompt();
        }
      } else if (evType === "qr" && typeof payload.data === "string" && !typedChallengeSeen) {
        // The shape an older collector emits, kept so a mixed-version install
        // can still pair. A source on this build sends a `challenge`, which
        // carries its own instructions.
        try {
          const qrTerminal = await import("qrcode-terminal");
          qrTerminal.default.generate(String(payload.data), { small: true });
        } catch {
          /* rendering failed — the raw payload below is the fallback */
        }
        console.log(
          `\n${c.dim}Paste this into the app instead of scanning, if needed:${c.reset}\n${payload.data}\n`,
        );
      } else if (evType === "challenge") {
        typedChallengeSeen = true;
        promptGeneration += 1;
        closePrompt();
        challengeWantsPastedCode = false;
        const { wantsPastedCode } = await renderChallenge(flowId, payload);
        if (wantsPastedCode) {
          challengeWantsPastedCode = true;
          startPastePrompt();
        }
      } else if (evType === "complete") {
        if (payload.ok === false) {
          errorMessage = String(payload.error ?? "Unknown");
          missingCredentials = reportFailure(payload, errorMessage);
        } else if (typeof payload.accountId === "string") {
          resolvedAccountId = payload.accountId;
          printNotices(payload);
        }
        onTerminal();
      } else if (evType === "error") {
        errorMessage = String(payload.error ?? "Unknown");
        missingCredentials = reportFailure(payload, errorMessage);
        onTerminal();
      }
    }
  }

  // The gateway closes the SSE stream on the terminal event; make sure the
  // prompt is gone even if the stream ended without one (gateway restart).
  terminalSeen = true;
  closePrompt();

  if (resolvedAccountId) return { accountId: resolvedAccountId };
  if (missingCredentials) return { missingCredentials, errorMessage };
  if (errorMessage) return { errorMessage };
  console.error(`${c.red}Auth flow finished without an account ID${c.reset}`);
  return { errorMessage: "no account id" };
}
