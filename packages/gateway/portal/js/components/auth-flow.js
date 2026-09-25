// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Reusable OAuth/QR/device-code auth flow primitives — shared by
// AddSourceModal (initial connect) and ReauthBanner (provider-level
// re-authentication when a refresh token expires).
//
// `useAuthFlow` owns the SSE subscription lifecycle; the caller plugs in
// onAccount / onError / onMissingCredentials callbacks for the parts that
// differ per surface. `AuthStep` renders whatever the flow currently
// surfaces (URL / device code / QR / spinner); for URL flows whose
// descriptor declares `acceptsAuthCode` it also offers a paste input that
// delivers a manually copied redirect URL / code to
// `POST /admin/auth-flows/:id/code` (completion still arrives over SSE).
//
// The SSE event → state transition is `reduceAuthEvent`, kept pure so it
// can be unit-tested without spinning up a fake EventSource.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import {
  answerAuthChallenge,
  cancelAuthFlow,
  startAuthFlow,
  submitAuthFlowCode,
  submitAuthFlowWidgetResult,
} from "../api.js";
import { getWidgetRenderer } from "./widget-renderers.js";

/**
 * Pure reducer for SSE `auth` events. Splits the state update from the
 * side effect so the hook can run setState immediately and the caller
 * can act on the side effect after closing the stream. Exported for
 * tests.
 *
 * Returns `{ next, sideEffect }` where `sideEffect` is one of:
 *   - `null`                                        — non-terminal event
 *   - `{ kind: "account", accountId }`              — flow completed OK
 *   - `{ kind: "missingCredentials", fileKey, providerName }`
 *                                                    — auth subprocess
 *                                                      needs creds wizard
 *   - `{ kind: "error", message }`                  — flow failed
 */
export function reduceAuthEvent(prev, payload, flowId) {
  const isMissingCreds =
    (payload?.type === "complete" || payload?.type === "error") &&
    payload?.code === "missing-credentials" &&
    typeof payload?.fileKey === "string" &&
    typeof payload?.providerName === "string";

  const next = { ...(prev || {}), flowId };
  let sideEffect = null;

  if (payload?.type === "url") {
    if (payload.url) next.url = payload.url;
  } else if (payload?.type === "qr") {
    next.qr = typeof payload.data === "string" ? payload.data : "";
  } else if (payload?.type === "challenge") {
    // A typed challenge from a source that declares `authenticate`. Carried
    // whole and rendered from its own `kind` and its own words: this surface
    // never learns which platform produced it, which is what keeps a
    // provider's instructions out of shared code.
    if (payload.challenge && typeof payload.challenge === "object" && payload.id) {
      // A notice is not a question. It says what is happening while something
      // else is asked, so it updates the status line and leaves whatever the
      // operator is answering exactly where it is — erasing that would take
      // the form off screen and make the answer they then cannot send arrive
      // for a question the flow is no longer on.
      if (payload.challenge.kind === "wait") {
        next.status = payload.challenge.title;
      } else {
        // A collector that predates the field says nothing; treat that as a
        // question, which is what every challenge kind this client renders an
        // input for was before the field existed.
        next.challenge = {
          id: payload.id,
          expectsAnswer: payload.expectsAnswer !== false,
          ...payload.challenge,
        };
      }
    }
  } else if (payload?.type === "widget") {
    // Hosted-widget config (`link-widget` AuthType). Carry the opaque
    // source-declared `kind` + its string-keyed payload so the surface can
    // render it generically via the widget-renderer registry — never
    // branching on a source name (source-encapsulation).
    if (typeof payload.kind === "string" && payload.payload && typeof payload.payload === "object") {
      next.widget = { kind: payload.kind, payload: payload.payload };
    }
  } else if (payload?.type === "complete") {
    next.done = true;
    if (payload.ok === false) {
      next.error = isMissingCreds ? null : String(payload.error || "Authentication failed");
    } else if (typeof payload.accountId === "string") {
      next.accountId = payload.accountId;
      // Some platforms say how long the grant lasts once, while it is being
      // established, and never again. Showing it here is the only moment the
      // operator learns it from the act that produced it.
      const state = payload.accountStates?.[payload.accountId];
      if (typeof state?.expiresAt === "string") next.accountExpiresAt = state.expiresAt;
      // Things that went wrong without stopping it. Shown beside the success:
      // an operator told only "connected" has no reason to look again, and one
      // of these can only be retried by authorising all over again.
      if (Array.isArray(payload.notices) && payload.notices.length > 0) {
        next.notices = payload.notices;
      }
    }
  } else if (payload?.type === "error") {
    next.done = true;
    next.error = isMissingCreds ? null : String(payload.error || "Authentication error");
  }

  // What the operator can do about it. The code says which class of thing went
  // wrong; this is the sentence only the source can write, and for a platform
  // with no account chooser it is the whole recovery.
  if (payload?.type === "complete" || payload?.type === "error") {
    if (typeof payload.remedy === "string" && payload.remedy.trim()) next.remedy = payload.remedy;
    if (typeof payload.retryAfterMs === "number" && payload.retryAfterMs > 0) {
      next.retryAfterMs = payload.retryAfterMs;
    }
  }

  if (payload?.type === "complete" || payload?.type === "error") {
    if (isMissingCreds) {
      sideEffect = {
        kind: "missingCredentials",
        fileKey: payload.fileKey,
        providerName: payload.providerName,
      };
    } else if (
      payload.type === "complete" &&
      payload.ok !== false &&
      typeof payload.accountId === "string"
    ) {
      sideEffect = { kind: "account", accountId: payload.accountId };
    } else {
      const message =
        payload.type === "error"
          ? String(payload.error || "Authentication error")
          : String(payload.error || "Authentication failed");
      sideEffect = { kind: "error", message };
    }
  }

  return { next, sideEffect };
}

/**
 * Drive a single auth flow against `POST /admin/auth-flows` and the SSE
 * stream at `/admin/auth-flows/:id/events`. The hook owns the EventSource;
 * cleanup runs on unmount and on cancel.
 *
 * Callbacks:
 *   - onAccount(accountId)  → flow completed with a resolved account
 *   - onError(message)      → flow failed (non-missing-creds)
 *   - onMissingCredentials({ fileKey, providerName })
 *                           → auth subprocess refused for missing
 *                              provider credentials. The caller typically
 *                              opens a credentials wizard.
 */
export function useAuthFlow({ deviceId, onAccount, onError, onMissingCredentials }) {
  // null      → idle (no flow started)
  // { starting: true } → POST in flight
  // { flowId, url?, qr?, done?, error?, accountId? }
  const [authState, setAuthState] = useState(null);
  const esRef = useRef(null);
  // The flowId most recently surfaced by the gateway. Used by `start()`
  // to cancel any previous flow before kicking off a new one, even if
  // the stale `authState` closure isn't visible to the new call.
  const flowIdRef = useRef(null);

  // Hold the latest callbacks in a ref so the long-lived SSE event handler
  // always invokes the freshest version. Without this, the handler would
  // capture the callbacks from the render that called `start()` and miss
  // any subsequent props update.
  const cbRef = useRef({ onAccount, onError, onMissingCredentials });
  cbRef.current = { onAccount, onError, onMissingCredentials };

  useEffect(() => () => {
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
  }, []);

  function closeStream() {
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
  }

  async function start({
    sourceType,
    params,
    accountId,
    credentials,
    deviceId: callTimeDeviceId,
  }) {
    const resolvedDeviceId = callTimeDeviceId ?? deviceId;
    // If a previous flow is still live on the gateway (user re-clicked
    // "Reauthenticate" before the first attempt resolved), tear it down
    // before starting a new one — otherwise the orphan flow keeps
    // running and could even complete in the background.
    const prevFlowId = flowIdRef.current;
    if (prevFlowId) {
      try { await cancelAuthFlow(prevFlowId); } catch { /* ignore */ }
      flowIdRef.current = null;
    }
    closeStream();
    setAuthState({ starting: true });

    let flowId;
    try {
      const res = await startAuthFlow({
        deviceId: resolvedDeviceId,
        sourceType,
        params: params && Object.keys(params).length ? params : undefined,
        accountId,
        credentials,
      });
      flowId = res.flowId;
      flowIdRef.current = flowId;
      setAuthState({ flowId });
    } catch (e) {
      const message = String(e?.message || e);
      setAuthState({ error: message, done: true });
      cbRef.current.onError?.(message);
      return;
    }

    // EventSource forwards our cookie automatically (same-origin).
    const es = new EventSource(`/admin/auth-flows/${encodeURIComponent(flowId)}/events`);
    esRef.current = es;
    // Track whether any auth payload has arrived; without this the
    // onerror branch below can't tell "stream broken before anything
    // happened" from "stream closed cleanly after the complete event".
    let receivedAuthEvent = false;

    es.addEventListener("auth", (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      receivedAuthEvent = true;

      const { sideEffect } = (() => {
        let captured;
        setAuthState((prev) => {
          const result = reduceAuthEvent(prev, payload, flowId);
          captured = result;
          return result.next;
        });
        return captured;
      })();

      if (sideEffect) {
        closeStream();
        flowIdRef.current = null;
        if (sideEffect.kind === "missingCredentials") {
          cbRef.current.onMissingCredentials?.({
            fileKey: sideEffect.fileKey,
            providerName: sideEffect.providerName,
          });
        } else if (sideEffect.kind === "account") {
          cbRef.current.onAccount?.(sideEffect.accountId);
        } else if (sideEffect.kind === "error") {
          cbRef.current.onError?.(sideEffect.message);
        }
      }
    });

    es.onerror = () => {
      // Browsers fire `error` on transient hiccups too (auto-reconnect
      // attempts). Only treat the stream as broken when it's
      // permanently CLOSED AND no auth event landed — otherwise the
      // `auth` handler is the source of truth for terminal state.
      if (es.readyState !== EventSource.CLOSED) return;
      if (receivedAuthEvent) return;
      const message = "Lost connection to the gateway before the auth flow started";
      setAuthState((prev) =>
        prev?.done ? prev : { ...(prev || {}), flowId, error: message, done: true },
      );
      flowIdRef.current = null;
      cbRef.current.onError?.(message);
    };
  }

  async function cancel() {
    // Read the in-flight flowId from the ref (the state closure can be
    // stale if start() was called multiple times in quick succession).
    const flowId = flowIdRef.current;
    if (flowId) {
      try { await cancelAuthFlow(flowId); } catch { /* ignore */ }
    }
    flowIdRef.current = null;
    closeStream();
    setAuthState(null);
  }

  function reset() {
    flowIdRef.current = null;
    closeStream();
    setAuthState(null);
  }

  return { authState, start, cancel, reset };
}

/**
 * Heuristic: is the portal being viewed on the same machine as the
 * collector? OAuth callbacks redirect to `localhost:<port>` which only
 * resolves to the collector if the user's browser is on the same host.
 * If the portal is served over a hostname or IP (e.g. `my-server.local`,
 * `192.168.x.x`) the user is almost certainly on a different device and
 * the OAuth redirect will land on a machine with nothing listening on
 * that port.
 *
 * Returns true only when the hostname is loopback.
 */
/**
 * A date the operator can read, from an instant the platform stated.
 *
 * Deliberately the day and not the minute: a consent deadline months out is
 * something to plan around, and a timestamp to the second invites the reader
 * to believe it is exact.
 */
/**
 * A wait an operator can act on.
 *
 * Rounded on purpose: what they need to decide is whether to sit here or come
 * back later, and a figure to the second invites them to believe it is exact
 * when it is the platform's own estimate.
 */
function describeWait(ms) {
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 1) return "a minute";
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

function formatDay(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function isBrowserProbablyOnCollectorHost() {
  const h = (typeof window !== "undefined" && window.location?.hostname) || "";
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * Whether an authorization URL sends the provider's redirect back to a
 * loopback address — the case where the sign-in only completes in a browser on
 * the collector's own machine. A provider that redirects to the gateway's
 * public URL, or one whose sign-in page is hosted by the provider and needs no
 * redirect at all, is fine from any browser and must not be warned about.
 */
export function redirectsToLoopback(authUrl) {
  if (!authUrl) return false;
  let redirect;
  try {
    redirect = new URL(authUrl).searchParams.get("redirect_uri");
    if (!redirect) return false;
    const host = new URL(redirect).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function copyToClipboard(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

/**
 * Parse user-pasted input from an OAuth redirect into a decoded
 * authorization code. Mirrors the CLI's parseAuthCodeInput
 * (packages/cli/src/auth-code-input.ts) — keep the two in sync.
 *
 * Accepted shapes:
 *   - a full redirect URL — either the provider's redirect or the
 *     gateway's `/oauth/callback?state=…&code=…` shape. The code is read
 *     from the `code` query parameter; `URL.searchParams` already
 *     percent-decodes it.
 *   - a bare code — percent-decoded iff it contains `%` (a code copied
 *     out of a URL bar may still be encoded; an already-decoded code
 *     containing no `%` passes through verbatim).
 *
 * Pure — no I/O. Throws with a user-readable message on anything else.
 * Exported for tests.
 */
export function parseAuthCodeInput(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty input — paste the full redirect URL or the authorization code.");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(
        "That looks like a URL but could not be parsed — paste the full redirect URL including its query string.",
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error(
        "No `code` query parameter in that URL — paste the full redirect URL including its query string.",
      );
    }
    return code;
  }

  if (/\s/.test(trimmed)) {
    throw new Error(
      "That doesn't look like an authorization code — paste the full URL from the address bar, or just the code.",
    );
  }

  if (trimmed.includes("%")) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      throw new Error(
        "Code looks percent-encoded but could not be decoded — paste the raw code or the full redirect URL.",
      );
    }
  }

  return trimmed;
}

/**
 * Whether the auth surface should offer the manual code-paste form.
 * Gated on the descriptor's `acceptsAuthCode` capability: only providers
 * whose authFlow consumes externally delivered codes via `receiveCode`
 * can complete a pasted code. Offering the form to a provider that runs
 * its own local callback listener would latch the flow to `completing`
 * while the code sits unread — the flow then hangs until its timeout.
 * Pure; exported for tests.
 */
export function offersAuthCodePaste(descriptor, state) {
  return descriptor?.acceptsAuthCode === true && !!state?.url && !!state?.flowId;
}

/**
 * Manual code delivery for OAuth flows whose redirect can't reach the
 * collector (e.g. an HTTPS redirect target with nothing listening — the
 * browser shows a dead page and the user copies the URL from the address
 * bar). Posts the parsed code to the gateway, which forwards it to the
 * collector; the flow then completes through the normal SSE `complete`
 * event, so a successful POST just keeps waiting. A 409 means the flow
 * already advanced (typically: the redirect landed after all) — shown as
 * an informational notice, not an error.
 */
function AuthCodePasteForm({ flowId }) {
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | submitting | submitted
  const [notice, setNotice] = useState(null); // { kind: "error" | "info", message } | null

  async function submit(e) {
    e.preventDefault();
    if (phase !== "idle" || !value.trim()) return;
    let code;
    try {
      code = parseAuthCodeInput(value);
    } catch (err) {
      setNotice({ kind: "error", message: String(err?.message || err) });
      return;
    }
    setPhase("submitting");
    setNotice(null);
    try {
      await submitAuthFlowCode(flowId, code);
      setPhase("submitted");
      setNotice({ kind: "info", message: "Code submitted — finishing sign-in…" });
    } catch (err) {
      if (err?.status === 409) {
        setPhase("submitted");
        setNotice({
          kind: "info",
          message: "This flow already received a code or completed — no need to submit again.",
        });
      } else {
        setPhase("idle");
        setNotice({ kind: "error", message: String(err?.message || err) });
      }
    }
  }

  return html`
    <div class="add-source-auth-label">Or paste the redirect URL / code:</div>
    <form class="add-source-auth-code-form" onSubmit=${submit}>
      <input
        type="text"
        placeholder="https://…?code=… — or just the code"
        value=${value}
        disabled=${phase !== "idle"}
        onInput=${(e) => {
          setValue(e.target.value);
          if (notice?.kind === "error") setNotice(null);
        }}
      />
      <button class="btn-tiny" type="submit" disabled=${phase !== "idle" || !value.trim()}>
        ${phase === "submitting" ? "Submitting…" : "Submit code"}
      </button>
    </form>
    ${notice && (notice.kind === "error"
      ? html`<span class="add-source-field-error">${notice.message}</span>`
      : html`<span class="add-source-auth-code-status">${notice.message}</span>`)}
  `;
}

/**
 * Hosted-widget surface for the `link-widget` AuthType. Opens the registered
 * renderer for the flow's `{ kind, payload }` and posts EACH result the widget
 * yields to `POST /admin/auth-flows/:id/widget-result` (the endpoint is not
 * single-use — a widget may yield several results in one session). Completion still
 * arrives over the flow's SSE `complete` event, so a successful POST just keeps
 * the surface waiting. Renders generically: it resolves the renderer by the
 * opaque `kind` and never names a source.
 */
export function WidgetStep({ flowId, widget, onCancel }) {
  // idle | opening | awaiting (widget open, results may stream) | error
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  // Count of results posted so far, so the surface can show that results are
  // arriving.
  const [delivered, setDelivered] = useState(0);

  const renderer = getWidgetRenderer(widget?.kind);

  useEffect(() => {
    if (!renderer || !flowId) return undefined;
    let cleanup = () => {};
    let cancelled = false;
    setPhase("opening");
    (async () => {
      const teardown = await renderer({
        payload: widget.payload,
        onResult: (token, metadata) => {
          if (cancelled || typeof token !== "string" || !token) return;
          setPhase("awaiting");
          // Fire-and-forget per institution; a 409 (flow no longer awaiting)
          // is benign — the session resolved between results.
          submitAuthFlowWidgetResult(flowId, token, metadata)
            .then(() => setDelivered((n) => n + 1))
            .catch((e) => {
              if (e?.status !== 409) setError(String(e?.message || e));
            });
        },
        onExit: (message) => {
          if (cancelled) return;
          // A user-initiated dismiss with no error just cancels the flow.
          if (message) {
            setError(message);
            setPhase("error");
          } else {
            onCancel?.();
          }
        },
        onError: (message) => {
          if (cancelled) return;
          setError(message);
          setPhase("error");
        },
      });
      cleanup = teardown || (() => {});
      if (cancelled) {
        cleanup();
        return;
      }
      // Advance to "awaiting" only from "opening" — a synchronous onError /
      // onExit during renderer init has already moved us to a terminal phase,
      // and must not be clobbered back to the waiting surface.
      setPhase((p) => (p === "opening" ? "awaiting" : p));
    })();
    return () => {
      cancelled = true;
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, widget?.kind]);

  if (!renderer) {
    return html`
      <div class="add-source-form">
        <div class="sources-banner-v2 error">
          This client can't render the <code>${widget?.kind || "unknown"}</code> sign-in widget. Update Omnesis or use a client that supports it.
        </div>
        <div class="add-source-actions">
          <button class="btn-tiny" onClick=${onCancel}>back</button>
        </div>
      </div>
    `;
  }

  if (phase === "error") {
    return html`
      <div class="add-source-form">
        <div class="sources-banner-v2 error">${error || "The sign-in widget failed."}</div>
        <div class="add-source-actions">
          <button class="btn-tiny" onClick=${onCancel}>back</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="add-source-form">
      <div class="add-source-loading">
        ${delivered > 0
          ? `Connected ${delivered} institution${delivered === 1 ? "" : "s"}. Finishing…`
          : "Complete sign-in in the widget…"}
      </div>
      <div class="add-source-actions">
        <button class="btn-tiny danger" onClick=${onCancel}>Cancel</button>
      </div>
    </div>
  `;
}

/**
 * Renders the live auth flow surface. `state` is whatever
 * `useAuthFlow` currently has. `descriptor` is used for the title text
 * and to decide whether to warn about the OAuth callback host. `onCancel`
 * lets the caller dismiss the flow (the hook's cancel() handles the
 * gateway-side teardown).
 */
/**
 * One typed challenge, whatever it is.
 *
 * Every branch below renders a *kind*, never a source. The title and the
 * instructions come from the provider, which is the only party that knows what
 * an operator is supposed to do with a pairing code or a consent screen.
 */
export function ChallengeStep({ flowId, challenge, status, collectorName, onCancel }) {
  const [values, setValues] = useState(challenge.prefill ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function send(answer) {
    setBusy(true);
    setError(null);
    try {
      await answerAuthChallenge(flowId, challenge.id, answer);
    } catch (e) {
      setError(String(e?.message || e));
      setBusy(false);
    }
  }

  return html`
    <div class="add-source-form">
      <div class="add-source-auth-card">
        <div class="add-source-auth-label">${challenge.title}</div>
        ${challenge.instructions && html`<p class="add-source-qr-note">${challenge.instructions}</p>`}

        ${challenge.kind === "redirect" && html`
          ${challenge.via === "loopback" && !isBrowserProbablyOnCollectorHost() && html`
            <div class="add-source-host-warning">
              <strong>Complete sign-in on the collector's machine.</strong>
              <p>
                This sign-in redirects to a listener on the machine running the
                collector${collectorName ? html` (<code>${collectorName}</code>)` : ""}, which this
                browser is probably not on. Open the URL there — or complete it here and paste the
                address you land on below.
              </p>
            </div>
          `}
          <div class="add-source-auth-url-row">
            <a href=${challenge.url} target="_blank" rel="noreferrer">${challenge.url}</a>
            <button class="btn-tiny" onClick=${() => copyToClipboard(challenge.url)}>copy</button>
            <button class="btn-tiny" onClick=${() => window.open(challenge.url, "_blank", "noreferrer")}>open</button>
          </div>
          ${challenge.expectsAnswer && html`<${AuthCodePasteForm} flowId=${flowId} />`}
        `}

        ${challenge.kind === "qr" && html`
          <${QrCanvas} payload=${challenge.data} />
          <details class="add-source-qr-details">
            <summary>Trouble scanning? Show raw payload</summary>
            <pre class="add-source-qr-payload">${challenge.data}</pre>
            <button class="btn-tiny" onClick=${() => copyToClipboard(challenge.data)}>copy payload</button>
          </details>
        `}

        ${challenge.kind === "code" && html`
          <div class="add-source-auth-url-row">
            <input
              type="text"
              value=${values.code ?? ""}
              onInput=${(e) => setValues({ code: e.target.value })}
            />
            <button
              class="btn-primary"
              disabled=${busy || !(values.code ?? "").trim()}
              onClick=${() => send({ code: (values.code ?? "").trim() })}
            >submit</button>
          </div>
        `}

        ${challenge.kind === "fields" && html`
          ${(challenge.fields ?? []).map((f) => html`
            <div class="form-group" key=${f.name}>
              <label>${f.label}${f.required ? html`<span class="add-source-req"> *</span>` : null}</label>
              ${f.options?.length
                ? html`
                    <select
                      value=${values[f.name] ?? ""}
                      onChange=${(e) => setValues({ ...values, [f.name]: e.target.value })}
                    >
                      <option value="" disabled>${f.placeholder || "Choose one"}</option>
                      ${f.options.map(
                        (o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`,
                      )}
                    </select>
                  `
                : html`
                    <input
                      type=${f.type === "secret" ? "password" : "text"}
                      placeholder=${f.placeholder || ""}
                      value=${values[f.name] ?? ""}
                      onInput=${(e) => setValues({ ...values, [f.name]: e.target.value })}
                    />
                  `}
              ${f.help && html`<span class="form-hint">${f.help}</span>`}
            </div>
          `)}
          <button class="btn-primary" disabled=${busy} onClick=${() => send(values)}>continue</button>
        `}

        ${status && html`<p class="add-source-qr-note">${status}</p>`}
        ${error && html`<div class="sources-banner-v2 error">${error}</div>`}
      </div>

      <div class="add-source-actions">
        <button class="btn-tiny danger" onClick=${onCancel}>Cancel</button>
      </div>
    </div>
  `;
}

export function AuthStep({ descriptor, state, collectorName, onCancel }) {
  if (!state || state.starting) {
    return html`<div class="add-source-loading">Starting authentication flow…</div>`;
  }
  if (state.error) {
    return html`
      <div class="add-source-form">
        <div class="sources-banner-v2 error">
          ${state.error}
          ${state.remedy && html`<div class="form-hint">${state.remedy}</div>`}
          ${state.retryAfterMs &&
          html`<div class="form-hint">Try again in ${describeWait(state.retryAfterMs)}.</div>`}
        </div>
        <div class="add-source-actions">
          <button class="btn-tiny" onClick=${onCancel}>back</button>
        </div>
      </div>
    `;
  }
  if (state.done && state.accountId) {
    return html`<div class="add-source-loading">
      Authenticated as ${state.accountId}. Continuing…
      ${state.accountExpiresAt &&
      html`<div class="form-hint">Access lasts until ${formatDay(state.accountExpiresAt)}.</div>`}
      ${(state.notices ?? []).map(
        (n) => html`<div class="sources-banner-v2 warning" key=${n.title}>
          <strong>${n.title}</strong>${n.detail ? html` ${n.detail}` : null}
        </div>`,
      )}
    </div>`;
  }
  // A typed challenge: rendered from its own kind and its own words, with no
  // branch anywhere in this file that knows which platform is asking.
  if (state.challenge?.kind === "widget" && state.flowId) {
    // A hosted widget has a renderer registry and an answer route of its own;
    // the challenge only had to say which renderer and with what.
    return html`<${WidgetStep}
      flowId=${state.flowId}
      widget=${{ kind: state.challenge.renderer, payload: state.challenge.payload }}
      onCancel=${onCancel}
    />`;
  }
  if (state.challenge && state.flowId) {
    // Keyed on the challenge id so a new question gets a new instance. Without
    // it the same component is reused, and its `busy` flag — which a
    // successful answer never clears, because the flow moves on rather than
    // coming back — leaves the next question's submit button disabled forever.
    return html`<${ChallengeStep}
      key=${state.challenge.id}
      flowId=${state.flowId}
      challenge=${state.challenge}
      status=${state.status}
      collectorName=${collectorName}
      onCancel=${onCancel}
    />`;
  }
  // Hosted-widget flow (`link-widget`): render generically from the
  // source-declared `{ kind, payload }` via the widget-renderer registry.
  if (state.widget && state.flowId) {
    return html`<${WidgetStep} flowId=${state.flowId} widget=${state.widget} onCancel=${onCancel} />`;
  }
  const hasUrl = !!state.url;
  const hasQr = !!state.qr;
  // Only a sign-in whose redirect lands on the collector's loopback needs the
  // "open on collector host" warning. Providers that redirect to the gateway's
  // public URL, and provider-hosted sign-in pages that need no redirect, work
  // from any browser.
  const showHostWarning =
    hasUrl && redirectsToLoopback(state.url) && !isBrowserProbablyOnCollectorHost();

  return html`
    <div class="add-source-form">
      <p class="add-source-step-hint">
        ${descriptor.authType === "qr"
          ? `Pair ${descriptor.name} — scan the code below with your phone.`
          : `Complete ${descriptor.provider.name} sign-in to continue.`}
      </p>

      ${showHostWarning && html`
        <div class="add-source-host-warning">
          <strong>Complete sign-in on the collector's machine.</strong>
          <p>
            After you approve, ${descriptor.provider.name} redirects to <code>localhost</code>,
            which only reaches the machine running the collector${collectorName ? html` (<code>${collectorName}</code>)` : ""}.
            You're fine if this browser is on that machine — just continue. If it isn't, the
            redirect won't land: open the URL in a browser on the collector host instead.
          </p>
        </div>
      `}

      ${hasUrl && html`
        <div class="add-source-auth-card">
          <div class="add-source-auth-label">Open this URL in your browser</div>
          <div class="add-source-auth-url-row">
            <a href=${state.url} target="_blank" rel="noreferrer">${state.url}</a>
            <button class="btn-tiny" onClick=${() => copyToClipboard(state.url)}>copy</button>
            <button class="btn-tiny" onClick=${() => window.open(state.url, "_blank", "noreferrer")}>open</button>
          </div>
          ${offersAuthCodePaste(descriptor, state) && html`<${AuthCodePasteForm} flowId=${state.flowId} />`}
        </div>
      `}

      ${hasQr && html`
        <div class="add-source-auth-card">
          <div class="add-source-auth-label">Scan this code with ${descriptor.provider.name}</div>
          <p class="add-source-qr-note">
            Open ${descriptor.provider.name} on your phone and use its linked-devices setting.
          </p>
          <${QrCanvas} payload=${state.qr} />
          <details class="add-source-qr-details">
            <summary>Trouble scanning? Show raw payload</summary>
            <pre class="add-source-qr-payload">${state.qr}</pre>
            <button class="btn-tiny" onClick=${() => copyToClipboard(state.qr)}>copy payload</button>
          </details>
        </div>
      `}

      ${!hasUrl && !hasQr && html`
        <div class="add-source-loading">Waiting for provider instructions…</div>
      `}

      <div class="add-source-actions">
        <button class="btn-tiny danger" onClick=${onCancel}>Cancel</button>
      </div>
    </div>
  `;
}

/**
 * Renders a pairing payload into a canvas.
 *
 * Error-correction level L, because a pairing payload can run to several
 * hundred bytes and a denser code does not scan reliably from a phone camera
 * at this size. A shorter payload loses nothing by it.
 */
export function QrCanvas({ payload }) {
  const canvasRef = useRef(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!payload || !canvasRef.current) return;
    // The canvas can't read CSS variables, so the QR colours are chosen from
    // the active theme: conventional dark-modules-on-white in light mode, and
    // an inverted light-on-dark code that sits on the dark page otherwise.
    // Redraw on a theme flip so a paired-but-still-open dialog stays legible.
    const draw = () => {
      if (!canvasRef.current) return;
      setErr(null);
      const isLight = document.documentElement.dataset.theme === "light";
      QRCode.toCanvas(canvasRef.current, payload, {
        width: 260,
        margin: 2,
        errorCorrectionLevel: "L",
        color: isLight
          ? { dark: "#1a1a1a", light: "#ffffff" }
          : { dark: "#f2f2f2", light: "#1a1a1a" },
      }).catch((e) => setErr(String(e?.message || e)));
    };
    draw();
    window.addEventListener("omnesis:themechange", draw);
    return () => window.removeEventListener("omnesis:themechange", draw);
  }, [payload]);

  if (err) {
    return html`<div class="add-source-qr-error">Could not render QR: ${err}</div>`;
  }
  return html`<canvas class="add-source-qr-canvas" ref=${canvasRef}></canvas>`;
}
