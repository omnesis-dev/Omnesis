// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ACCOUNT_SESSION_SECONDS } from "./identity.js";
import { installAccountUI } from "./account-browser.js";
import { googleSignInMarkDataUrl } from "./google-sign-in-artwork.js";
import { bindingOrigin } from "./gateway-binding.js";
import { LoginAdmission } from "./admission.js";
import { RelayError } from "./tunnels.js";
import {
  accountCredentialsRequireSignIn,
  type AccountAuthentication,
  type GoogleAdmission,
} from "./account-authentication.js";
import { SignupDenied, type GatewaySignup } from "./gateway-signup.js";
import {
  NoAccount,
  type AccountAdmission,
  type PasskeyRegistrationAuthorization,
} from "./account-admission.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OmnesisAccounts } from "./omnesis-accounts.js";
import type { Passkeys } from "./passkeys.js";
import type { GatewayChoice } from "./gateway-directory.js";
import type { DesktopAccountBrowser } from "./desktop-account-browser.js";
import type { AccountBrowserBroker } from "./account-browser-broker.js";
import type { AccountOperationBroker } from "./operation-proof.js";
import type { PortalSignIn } from "./portal-sign-in.js";

const sessionCookie = "__Host-omnesis-account";
const browserCookie = "__Host-omnesis-account-browser";
const registrationBody = z
  .object({
    createAccount: z.boolean().default(false),
    label: z.string().trim().min(1).max(80).default("Passkey"),
  })
  .strict();
const completionBody = z
  .object({ ceremonyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), credential: z.unknown() })
  .strict();
const removeBody = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,2048}$/) }).strict();
const deleteBody = z.object({ accountId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const emptyBody = z.object({}).strict();
const intentBody = z.object({ intent: z.enum(["create", "existing"]) }).strict();
const handoffBody = z.object({ gatewayId: z.string().min(1).max(128) }).strict();
/** A sign-in method change that a Google confirmation may carry back to the account page. */
const credentialChanges = ["remove-passkey", "delete-account"] as const;
const googleContextSchema = z
  .object({
    linkSession: z.string().min(1).max(4096).optional(),
    operation: z.string().uuid().optional(),
    desktop: z.string().uuid().optional(),
    signup: z.string().uuid().optional(),
    endorse: z.string().uuid().optional(),
    portal: z.string().uuid().optional(),
    open: z.literal("portal").optional(),
    then: z.enum(credentialChanges).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.operation, value.desktop, value.signup, value.endorse, value.portal].filter(Boolean)
        .length <= 1,
  );
/**
 * `endorse` names a new passkey waiting for a sign-in to vouch for it. `portal` is the plain page's
 * own sign-in, kept for a gateway's portal. The others replace the page.
 */
const operationKinds = ["operation", "desktop", "signup", "endorse", "portal"] as const;
type OperationKind = (typeof operationKinds)[number];
interface OperationTarget {
  kind: OperationKind;
  id: string;
}
function contextTarget(value: z.infer<typeof googleContextSchema>): OperationTarget | undefined {
  const kind = operationKinds.find((candidate) => value[candidate]);
  return kind && { kind, id: value[kind]! };
}
type GoogleContext = z.infer<typeof googleContextSchema>;
/** Returns to the plain account page, or to the one operation or front-door request it serves. */
const accountLocation = (value?: GoogleContext, failed?: "google" | "no-account") => {
  const query = new URLSearchParams(
      failed ? { failed } : value?.linkSession ? { linked: "google" } : {},
    ),
    target = value && contextTarget(value);
  // A portal sign-in happens on the plain page, so it keeps what that page was asked to do.
  const plain = !target || target.kind === "portal";
  if (target) query.set(target.kind, target.id);
  if (plain && value?.then && !failed) query.set("then", value.then);
  else if (plain && value?.open) query.set("open", value.open);
  return "/_relay/account" + (query.size ? `?${query}` : "");
};

/** Cookie and HTTP boundaries wrap account services; no account session grants gateway data access. */
export class AccountWeb {
  private readonly origin: string;
  constructor(
    private readonly options: {
      origin: string;
      accounts: OmnesisAccounts;
      authentication: AccountAuthentication;
      passkeys: Passkeys;
      choices(account: string): GatewayChoice[];
      deleteAccount(account: string, version: number): void;
      googleAvailable: boolean;
      admission?: LoginAdmission;
      browser?: AccountBrowserBroker;
      desktop?: DesktopAccountBrowser;
      signup?: GatewaySignup;
      portal?: PortalSignIn;
      signupAdmission?(operation: string | undefined, cookie: string): AccountAdmission | undefined;
    },
  ) {
    this.origin = bindingOrigin(options.origin).origin;
    this.admission = options.admission ?? new LoginAdmission();
  }

  async googleContext(req: IncomingMessage): Promise<{ context?: string; nonce?: string }> {
    const query = new URL(req.url!, this.origin).searchParams;
    if (query.getAll("link").length > 1 || (query.has("link") && query.get("link") !== "1"))
      throw new RelayError(400, "Invalid account linking request");
    const target = this.target(req);
    if (target && query.has("link")) throw new RelayError(400, "Finish this sign-in first");
    const nonce =
      target && this.broker(target.kind).googleProofNonce(target.id, req.headers.cookie ?? "");
    let linkSession: string | undefined;
    if (query.has("link")) {
      linkSession = cookie(req, sessionCookie);
      if (!linkSession) throw new RelayError(401, "Sign in before linking Google");
      await this.options.authentication.authenticate(linkSession, true);
    }
    // Only the plain account page may be asked to open the gateway; anything else is dropped.
    const plain = !target && !linkSession,
      open =
        (plain || target?.kind === "portal") && query.getAll("open").join("\n") === "portal"
          ? ("portal" as const)
          : undefined;
    // A confirmation names the change to resume; the page still needs a fresh session to make it.
    const then = plain
      ? credentialChanges.find((change) => query.getAll("then").join("\n") === change)
      : undefined;
    return {
      context:
        linkSession || target || open || then
          ? JSON.stringify({
              linkSession,
              ...(then ? { then } : { open }),
              ...(target ? { [target.kind]: target.id } : {}),
            })
          : undefined,
      nonce,
    };
  }

  async completeGoogle(
    idToken: string,
    nonce: string,
    context: string | undefined,
    request: IncomingMessage,
  ): Promise<{ cookie?: string; location: string }> {
    const value =
      context === undefined ? undefined : parse(googleContextSchema, JSON.parse(context));
    const target = value && contextTarget(value),
      cookieHeader = request.headers.cookie ?? "",
      broker = target && this.broker(target.kind);
    let session;
    try {
      session = await this.options.authentication.googleSignIn(
        idToken,
        nonce,
        value?.linkSession,
        target && this.googleAdmission(target, cookieHeader),
      );
    } catch (error) {
      // The refusal is on the operation, so the page can show the person what to send the operator.
      if (error instanceof SignupDenied) return { location: accountLocation(value) };
      // Signing in never creates an account, so the page says how to create one.
      if (error instanceof NoAccount) return { location: accountLocation(value, "no-account") };
      throw error;
    }
    if (target)
      broker!.recordProof(target.id, cookieHeader, {
        type: "google",
        accountId: session.accountId,
        idToken,
        nonce,
      });
    return { cookie: accountCookie(session.token), location: accountLocation(value) };
  }

  /** A failed sign-in returns to its operation, because its launch ticket can't be used again. */
  googleFailure(context: string | undefined): string {
    const value =
      context === undefined ? undefined : googleContextSchema.safeParse(JSON.parse(context));
    return accountLocation(value?.success ? value.data : undefined, "google");
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url!, this.origin).pathname;
    if (path !== "/_relay/account" && !path.startsWith("/_relay/account/")) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader(
      "permissions-policy",
      "publickey-credentials-create=(self), publickey-credentials-get=(self)",
    );
    if (req.method === "GET" && path === "/_relay/account") {
      if (!cookie(req, browserCookie))
        appendCookie(
          res,
          `${browserCookie}=${randomBytes(32).toString("base64url")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        );
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return true;
    }
    if (req.method === "GET" && path === "/_relay/account/script.js") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(`(${installAccountUI.toString()})();`);
      return true;
    }
    if (req.method === "GET" && path === "/_relay/account/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(style);
      return true;
    }
    if (req.method === "GET" && path === "/_relay/account/google-mark") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from(googleSignInMarkDataUrl.split(",")[1]!, "base64"));
      return true;
    }
    if (req.method === "GET" && path === "/_relay/account/api/session") {
      const target = this.target(req);
      const pending =
        target && target.kind !== "endorse" && target.kind !== "portal"
          ? this.broker(target.kind).describe(target.id, req.headers.cookie ?? "")
          : undefined;
      const handoff = target?.kind === "portal" ? this.portalHandoff(target.id, req) : undefined;
      const token = cookie(req, sessionCookie);
      let session;
      if (token) {
        try {
          session = await this.options.authentication.authenticate(token);
        } catch (error) {
          if (!(error instanceof RelayError && error.status === 401)) throw error;
          appendCookie(res, accountCookie("", true));
        }
      }
      if (!session)
        return respond(res, {
          authenticated: false,
          googleAvailable: this.options.googleAvailable,
          canCreateAccount: Boolean(this.creationAdmission(req)),
          ...(pending ? { pending } : {}),
          ...(handoff ? { handoff } : {}),
        });
      return respond(res, {
        authenticated: true,
        // Deleting names the account the page showed, so another account's sign-in deletes nothing.
        accountId: session.accountId,
        credentialsRequireSignIn: accountCredentialsRequireSignIn(session.authTime),
        googleAvailable: this.options.googleAvailable,
        credentials: this.options.accounts.list(session.accountId),
        gateways: this.options.choices(session.accountId),
        ...(pending ? { pending } : {}),
        ...(handoff ? { handoff } : {}),
      });
    }
    if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
    if (req.headers.origin !== this.origin || req.headers["sec-fetch-site"] === "cross-site")
      throw new RelayError(403, "Same-origin account request required");
    if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      throw new RelayError(415, "JSON account request required");
    return this.admission
      .run(() => this.post(req, res, path), req)
      .catch((error: unknown) => {
        req.resume();
        throw error;
      });
  }

  private readonly admission: LoginAdmission;

  private target(req: IncomingMessage): OperationTarget | undefined {
    const query = new URL(req.url!, this.origin).searchParams,
      kinds = operationKinds.filter((kind) => query.has(kind));
    if (kinds.length === 0) return undefined;
    const kind = kinds[0]!,
      parsed = z.string().uuid().safeParse(query.get(kind));
    if (kinds.length > 1 || query.getAll(kind).length !== 1 || !parsed.success)
      throw new RelayError(400, "Invalid account browser operation");
    return { kind, id: parsed.data };
  }

  private broker(kind: OperationKind): AccountOperationBroker {
    const broker = {
      operation: this.options.browser,
      desktop: this.options.desktop,
      signup: this.options.signup,
      endorse: this.options.passkeys.endorsements,
      portal: this.options.portal,
    }[kind];
    if (!broker) throw new RelayError(503, "Account browser is unavailable");
    return broker;
  }

  private portal(): PortalSignIn {
    return this.broker("portal") as PortalSignIn;
  }

  private signup(): GatewaySignup {
    return this.broker("signup") as GatewaySignup;
  }

  /** A portal sign-in that is gone only means the gateway asks for its own sign-in. */
  private portalHandoff(id: string, req: IncomingMessage): { ready: boolean } | undefined {
    try {
      return this.options.portal?.describe(id, req.headers.cookie ?? "");
    } catch (error) {
      if (error instanceof RelayError) return undefined;
      throw error;
    }
  }

  private googleAdmission(
    target: OperationTarget,
    cookieHeader: string,
  ): GoogleAdmission | undefined {
    if (target.kind === "signup")
      return (google) => this.signup().authorizeGoogle(target.id, cookieHeader, google);
    return target.kind === "operation"
      ? this.options.signupAdmission?.(target.id, cookieHeader)
      : undefined;
  }

  private requireAdmission(req: IncomingMessage): AccountAdmission {
    const admission = this.creationAdmission(req);
    if (!admission) throw new RelayError(403, "Start account setup from your gateway");
    return admission;
  }

  private creationAdmission(req: IncomingMessage): AccountAdmission | undefined {
    const target = this.target(req),
      cookieHeader = req.headers.cookie ?? "";
    if (target?.kind === "desktop" || target?.kind === "endorse") return undefined;
    const admission =
      target?.kind === "signup"
        ? this.signup().creationAdmission(target.id, cookieHeader)
        : this.options.signupAdmission?.(
            target?.kind === "portal" ? undefined : target?.id,
            cookieHeader,
          );
    return admission && this.options.accounts.canAdmitGateway(admission.gatewayId)
      ? admission
      : undefined;
  }

  private async post(req: IncomingMessage, res: ServerResponse, path: string): Promise<true> {
    const cookieHeader = req.headers.cookie ?? "";
    const body = await jsonBody(req);
    if (path === "/_relay/account/api/continue") {
      parse(emptyBody, body);
      const target = this.target(req),
        token = cookie(req, sessionCookie);
      if (!target) throw new RelayError(400, "Account browser operation required");
      if (!token) throw new RelayError(401, "Sign in before continuing");
      const account = await this.options.authentication.authenticate(token, true);
      const result = await this.broker(target.kind).confirm(target.id, cookieHeader, account);
      appendCookie(res, result.cookie);
      return respond(res, { location: result.location });
    }
    if (path === "/_relay/account/api/intent") {
      const { intent } = parse(intentBody, body),
        target = this.target(req),
        broker = target && this.broker(target.kind);
      if (!broker?.setIntent) throw new RelayError(400, "Nothing here can create an account");
      broker.setIntent(target!.id, cookieHeader, intent);
      return respond(res, { ok: true });
    }
    if (path === "/_relay/account/api/logout") {
      parse(emptyBody, body);
      const token = cookie(req, sessionCookie);
      if (token) await this.options.authentication.logout(token);
      appendCookie(res, accountCookie("", true));
      return respond(res, { ok: true });
    }
    const browser = cookie(req, browserCookie);
    if (!browser || !/^[A-Za-z0-9_-]{43}$/.test(browser))
      throw new RelayError(400, "Open the sign-in page before continuing");
    const target = this.target(req);
    if (path === "/_relay/account/api/portal/start") {
      if (target) throw new RelayError(400, "Invalid account browser operation");
      return respond(res, this.portal().start(body, cookieHeader));
    }
    if (path === "/_relay/account/api/portal/handoff") {
      const value = parse(handoffBody, body),
        token = cookie(req, sessionCookie);
      if (target?.kind !== "portal") throw new RelayError(400, "Portal sign-in required");
      if (!token) throw new RelayError(401, "Sign in before continuing");
      const account = await this.options.authentication.authenticate(token);
      return respond(
        res,
        await this.portal().handoff(target.id, cookieHeader, account, value.gatewayId),
      );
    }
    if (path === "/_relay/account/api/passkeys/register/options") {
      const value = parse(registrationBody, body);
      const token = cookie(req, sessionCookie);
      const account = token ? await this.options.authentication.authenticate(token) : undefined;
      if (!account && !value.createAccount)
        throw new RelayError(401, "Sign in or explicitly create an account");
      if (account && value.createAccount)
        throw new RelayError(409, "Add a passkey to the signed-in account");
      // On an operation a new passkey is only ever the sign-in that creates the account.
      if (account && target) throw new RelayError(409, "Finish this sign-in first");
      const authorization: PasskeyRegistrationAuthorization = account
        ? { kind: "account-session", sessionId: account.sessionId }
        : { kind: "gateway-owner", admission: this.requireAdmission(req) };
      return respond(
        res,
        await this.options.passkeys.beginRegistration(
          browser,
          account,
          value.label,
          authorization,
          target && this.broker(target.kind).proofCommitment(target.id, cookieHeader),
        ),
      );
    }
    if (path === "/_relay/account/api/passkeys/register/complete") {
      const value = parse(completionBody, body);
      const account = await this.options.passkeys.finishRegistration(
        value.ceremonyId,
        browser,
        value.credential,
      );
      // A passkey for an existing account is stored once a sign-in vouches for it.
      if ("endorse" in account) return respond(res, { endorse: account.endorse });
      if (target)
        this.broker(target.kind).recordProof(target.id, cookieHeader, {
          type: "passkey-registration",
          accountId: account.accountId,
          challenge: account.challenge,
          credential: account.credential,
        });
      const session = await this.options.authentication.issuePasskeySession(account);
      appendCookie(res, accountCookie(session.token));
      return respond(res, { ok: true });
    }
    if (path === "/_relay/account/api/passkeys/authenticate/options") {
      parse(emptyBody, body);
      return respond(
        res,
        await this.options.passkeys.beginAuthentication(
          browser,
          target && this.broker(target.kind).proofCommitment(target.id, cookieHeader),
          target?.kind === "endorse"
            ? this.options.passkeys.endorsements.endorsers(target.id, cookieHeader)
            : undefined,
        ),
      );
    }
    if (path === "/_relay/account/api/passkeys/countersign/options") {
      parse(emptyBody, body);
      if (target?.kind !== "endorse") throw new RelayError(400, "No passkey is being added");
      return respond(
        res,
        await this.options.passkeys.beginCountersignature(browser, target.id, cookieHeader),
      );
    }
    if (path === "/_relay/account/api/passkeys/countersign/complete") {
      const value = parse(completionBody, body);
      if (target?.kind !== "endorse") throw new RelayError(400, "No passkey is being added");
      await this.options.passkeys.finishCountersignature(
        value.ceremonyId,
        browser,
        target.id,
        cookieHeader,
        value.credential,
      );
      return respond(res, { ok: true });
    }
    if (
      path === "/_relay/account/api/passkeys/register/confirm" ||
      path === "/_relay/account/api/passkeys/register/cancel"
    ) {
      parse(emptyBody, body);
      if (target?.kind !== "endorse") throw new RelayError(400, "No passkey is being added");
      const endorsements = this.options.passkeys.endorsements;
      if (path.endsWith("/cancel")) {
        endorsements.cancel(target.id, cookieHeader);
        return respond(res, { ok: true });
      }
      const token = cookie(req, sessionCookie);
      if (!token) throw new RelayError(401, "Sign in to manage passkeys");
      const account = await this.options.authentication.authenticate(token);
      return respond(res, endorsements.complete(target.id, cookieHeader, account));
    }
    if (path === "/_relay/account/api/passkeys/authenticate/complete") {
      const value = parse(completionBody, body);
      const account = await this.options.passkeys.finishAuthentication(
        value.ceremonyId,
        browser,
        value.credential,
      );
      if (target) {
        if (
          target.kind === "signup" &&
          !(await this.signup().authorizeAccount(target.id, cookieHeader, account.accountId))
        )
          return respond(res, { ok: true });
        this.broker(target.kind).recordProof(target.id, cookieHeader, {
          type: "passkey",
          accountId: account.accountId,
          challenge: account.challenge,
          credential: account.credential,
          credentialPublicKey: account.credentialPublicKey,
        });
      }
      const session = await this.options.authentication.issuePasskeySession(account);
      appendCookie(res, accountCookie(session.token));
      return respond(res, { ok: true });
    }
    if (path === "/_relay/account/api/passkeys/remove") {
      const value = parse(removeBody, body),
        token = cookie(req, sessionCookie);
      if (!token) throw new RelayError(401, "Sign in to manage passkeys");
      const account = await this.options.authentication.authenticate(token, true);
      this.options.accounts.removePasskey(
        account.accountId,
        value.id,
        this.options.googleAvailable ? ["google"] : [],
        account.version,
      );
      appendCookie(res, accountCookie("", true));
      return respond(res, { ok: true });
    }
    if (path === "/_relay/account/api/delete") {
      const value = parse(deleteBody, body),
        token = cookie(req, sessionCookie);
      if (!token) throw new RelayError(401, "Sign in to delete your account");
      const account = await this.options.authentication.authenticate(token, true);
      if (value.accountId !== account.accountId)
        throw new RelayError(409, "Signed in to a different Omnesis account");
      this.options.deleteAccount(account.accountId, account.version);
      appendCookie(res, accountCookie("", true));
      return respond(res, { ok: true });
    }
    throw new RelayError(404, "Account operation not found");
  }
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`))
    .map((value) => value.slice(name.length + 1));
  if (values.length > 1) throw new RelayError(400, "Ambiguous account cookie");
  return values[0];
}
function accountCookie(token: string, clear = false): string {
  return `${sessionCookie}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : ACCOUNT_SESSION_SECONDS}`;
}
function appendCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("set-cookie");
  res.setHeader("set-cookie", [
    ...(existing === undefined
      ? []
      : Array.isArray(existing)
        ? existing.map(String)
        : [String(existing)]),
    value,
  ]);
}
function respond(res: ServerResponse, value: unknown): true {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
  return true;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new RelayError(400, "Invalid account request");
  return value.data;
}
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > 65_536) throw new RelayError(413, "Account request too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelayError(400, "Invalid account JSON");
  }
}
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omnesis account</title><link rel="stylesheet" href="/_relay/account/style.css"><script type="module" src="/_relay/account/script.js"></script></head><body><main>${brand}<p id="account-error" role="alert"></p><div id="account-root" aria-live="polite"><p>Loading…</p></div></main></body></html>`;
const style = `:root{color-scheme:light dark;--bg:#fff;--fg:#15171b;--muted:#5c636e;--line:#e6e8ec;--soft:#f3f4f6;--primary:#15171b;--on-primary:#fff;--focus:#3f5bd9;--alert:#b3261e;--mark:#1f6feb;--shadow:0 8px 28px rgba(21,23,27,.14);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}@media(prefers-color-scheme:dark){:root{--bg:#0e1013;--fg:#eceef2;--muted:#9aa1ad;--line:#262a31;--soft:#181b20;--primary:#eceef2;--on-primary:#0e1013;--focus:#93a6ff;--alert:#f2a59d;--mark:#58a6ff;--shadow:0 8px 28px rgba(0,0,0,.5)}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}main{--top:clamp(2rem,7vh,4rem);position:relative;max-width:28rem;margin:0 auto;padding:var(--top) 1rem 4rem}main.wide{max-width:calc(768px + 2rem)}.brand{display:flex;align-items:center;justify-content:center;gap:.625rem;min-height:2.75rem;margin:0 0 3rem;font-size:1.5rem;line-height:1;font-weight:600;letter-spacing:-.015em;color:var(--fg)}.brand-mark{flex:none;width:2rem;height:2rem}.brand-mark path{fill:var(--mark)}h1{margin:0 0 .75rem;font-size:1.75rem;line-height:1.2;font-weight:600;letter-spacing:-.015em}h1:focus{outline:none}h2{margin:0 0 .5rem;font-size:1.25rem;line-height:1.3;font-weight:700;letter-spacing:-.01em}section{margin-top:3.5rem}section>p{max-width:40rem}h3{margin:0 0 .5rem;font-size:1rem;font-weight:600}p{margin:0 0 1rem;color:var(--muted)}a{color:inherit}#account-error{margin:0;color:var(--alert)}#account-error:not(:empty){margin-bottom:1.5rem}.pending-host{margin-bottom:1.5rem;color:var(--fg);font-weight:500;overflow-wrap:anywhere}.code{margin:0 0 .75rem;color:var(--fg);font:500 1.5rem/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;overflow-wrap:anywhere}.code.long{font-size:.875rem;letter-spacing:0}button{font:inherit;font-weight:500;min-height:3rem;display:flex;align-items:center;justify-content:center;gap:.75rem;width:100%;margin:.75rem 0 0;padding:.75rem 1rem;border:1px solid var(--primary);border-radius:.5rem;background:var(--primary);color:var(--on-primary);cursor:pointer;transition:opacity .15s}button:hover{opacity:.86}button:disabled{opacity:.45;cursor:wait}button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}button.secondary:hover{opacity:1;border-color:var(--muted)}.actions{margin:2rem 0}.note{margin-top:1.5rem;font-size:.875rem}label{display:block;margin:2rem 0 .5rem;font-size:.875rem;font-weight:600}input{font:inherit;width:100%;min-height:3rem;padding:.625rem .875rem;border:1px solid var(--line);border-radius:.5rem;background:transparent;color:var(--fg)}form button{margin-top:1rem}.code-input{font:500 1.25rem/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase}.code-input::placeholder{color:var(--line)}.gateway,.credential{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:3.5rem;padding:.875rem 0;color:inherit;text-decoration:none}.gateway+.gateway,.credential+.credential{border-top:1px solid var(--line)}.row-text{display:flex;flex-direction:column;flex:1;min-width:0}.row-title{font-weight:600;line-height:1.4;overflow-wrap:anywhere}.row-meta{color:var(--muted);font-size:.875rem;line-height:1.45}.gateway .row-meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gateway::after{content:"";flex:none;width:.5rem;height:.5rem;margin-right:.25rem;border:solid var(--muted);border-width:2px 2px 0 0;transform:rotate(45deg)}.gateway:hover .row-title{text-decoration:underline}.credential button{flex:none;width:auto;min-height:2.75rem;margin:0;padding:.25rem .875rem;font-size:.875rem}.badge{display:inline-block;margin-left:.25rem;padding:0 .5rem;border-radius:1rem;background:var(--primary);color:var(--on-primary);font-size:.75rem;font-weight:600;line-height:1.5;vertical-align:.1em}.status{margin:1rem 0;padding:.75rem 1rem;border-radius:.5rem;background:var(--soft);color:var(--fg);font-size:.9375rem;line-height:1.45}.status:empty{display:none}.confirm{margin-top:1rem;padding:1.25rem;border:1px solid var(--line);border-radius:.75rem}.confirm p{margin-bottom:.5rem;font-size:.9375rem}.list-actions{display:flex;flex-wrap:wrap;gap:0 1.75rem;margin-top:.25rem}button.quiet{width:auto;min-height:2.75rem;margin:0;padding:.25rem 0;border:0;background:none;color:var(--focus);font-size:.9375rem;gap:.5rem}button.quiet:hover{opacity:1;text-decoration:underline}button.quiet img{width:1rem;height:1rem}.add::before{content:"";flex:none;width:.75rem;height:.75rem;background:linear-gradient(currentColor,currentColor) center/100% 2px no-repeat,linear-gradient(currentColor,currentColor) center/2px 100% no-repeat}.more{position:absolute;top:var(--top);right:1rem}button.more-button{width:2.75rem;min-height:2.75rem;margin:0 -.75rem 0 0;padding:0;gap:.1875rem;border:0;border-radius:50%;background:none;color:var(--fg)}button.more-button:hover,.more-button[aria-expanded=true]{opacity:1;background:var(--soft)}.more-button span{width:.3125rem;height:.3125rem;border-radius:50%;background:currentColor}.more-list{position:absolute;z-index:1;top:calc(100% + .25rem);right:-.75rem;min-width:12rem;padding:.375rem;border:1px solid var(--line);border-radius:.75rem;background:var(--bg);box-shadow:var(--shadow)}.more-list[hidden]{display:none}.more-list button{justify-content:flex-start;min-height:2.75rem;margin:0;padding:.5rem .75rem;border:0;border-radius:.5rem;background:none;color:var(--fg);font-weight:400;white-space:nowrap}.more-list button:hover{opacity:1;background:var(--soft)}.more-list button.danger{background:none;color:var(--alert)}.more-list button.danger:hover{background:var(--soft)}.delete-account{margin-top:1.5rem}.delete-account h2{margin-top:2.5rem}.delete-account ul{max-width:40rem;margin:0 0 1.5rem;padding-left:1.25rem;color:var(--muted);line-height:1.5}.delete-account li{margin-bottom:.5rem}button.danger{background:var(--alert);border-color:var(--alert);color:var(--bg)}.gateway:focus-visible,button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}@media(min-width:561px){.confirm button,.delete-account button{max-width:22rem}}@media(max-width:560px){main{--top:1.5rem}.brand{margin-bottom:2.25rem}section{margin-top:3rem}}`;
