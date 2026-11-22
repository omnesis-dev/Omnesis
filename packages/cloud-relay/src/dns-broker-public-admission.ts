// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  brokerChallengeSchema,
  brokerRequestSchema,
  sha256Hex,
  type BrokerChallenge,
  type BrokerRequest,
} from "./dns-broker-contract.js";
import { BrokerTickets, brokerNetworkBucket } from "./dns-broker-tickets.js";
import {
  BrokerAdmissionBudget,
  PublicAdmissionError,
  type PublicAdmissionLimits,
} from "./dns-broker-admission-budget.js";
import type { BrokerStore } from "./dns-broker-core.js";
import type { BrokerZoneCapacity } from "./dns-broker-zone.js";

const ENROLL_PURPOSE = "omnesis-dns-enrollment-v1";
const OPERATION_PURPOSE = "omnesis-dns-operation-v1";
export const DNS_TURNSTILE_ACTION = "gateway-enrollment";
/**
 * The fragment a gateway's portal adds when it opens this page in its connect window: once the
 * check passes, the page goes back to the portal's own page it came from, from where the portal
 * sends the window on to the account's sign-in, and it says it is going on rather than asking
 * to go back. The portal cuts that window off from its own tab first, so this page has no way to
 * reach the portal; going back in its own history is all it does. Without the fragment (a link
 * the CLI printed, or one opened by hand) the page says the gateway or terminal goes on by itself.
 */
export const OPENED_BY_PORTAL = "#opened-by-portal";
/**
 * How long a page the portal opened waits to have gone back before it says it is done and closes
 * itself, as a window opened by script may.
 */
export const PORTAL_HANDOFF_MS = 30_000;
const enrollSchema = z
  .object({
    request: brokerRequestSchema,
    network: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
const operationSchema = z
  .object({
    request: brokerRequestSchema,
    challenge: brokerChallengeSchema.omit({ ticket: true }),
  })
  .strict();
const usedSchema = z.array(z.object({ id: z.string().uuid(), expiresAt: z.number() })).max(32);

export interface DnsBrowserVerification {
  url: string;
  expiresAt: number;
}
export class BrowserVerificationRequired extends PublicAdmissionError {
  constructor(readonly verification: DnsBrowserVerification) {
    super(428, "browser-verification-required");
  }
}

export interface TurnstileVerification {
  token: string;
  cData: string;
  hostname: string;
  now: number;
}

/** The production verifier uses only Cloudflare's fixed endpoint, with a bounded response. */
export function turnstileVerifier(secret: string, transport?: typeof fetch) {
  if (!secret || secret.length > 2048) throw new Error("A Turnstile secret is required");
  const send = transport ?? ((input, init) => fetch(input, init));
  return async (input: TurnstileVerification): Promise<boolean> => {
    const response = await send("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: input.token }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const result = z
      .object({
        success: z.literal(true),
        hostname: z.string(),
        action: z.string(),
        cdata: z.string(),
        challenge_ts: z.string(),
      })
      .safeParse(await boundedAdmissionJson(response));
    if (!result.success) return false;
    const createdAt = Date.parse(result.data.challenge_ts);
    return (
      result.data.hostname === input.hostname &&
      result.data.action === DNS_TURNSTILE_ACTION &&
      result.data.cdata === input.cData &&
      Number.isFinite(createdAt) &&
      createdAt <= input.now + 30_000 &&
      createdAt > input.now - 300_000
    );
  };
}

export async function boundedAdmissionJson(
  input: Request | Response,
  limit = 16_384,
): Promise<unknown> {
  const reader = input.body?.getReader();
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PublicAdmissionError(408, "request-timeout"));
      void reader?.cancel().catch(() => {});
    }, 5000);
  });
  try {
    for (;;) {
      const part = await Promise.race([reader?.read(), deadline]);
      if (!part || part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader!.cancel();
        throw new PublicAdmissionError(413, "request-too-large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    try {
      return JSON.parse(text + decoder.decode());
    } catch {
      throw new PublicAdmissionError(400, "invalid-json");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Independent, automatically verified admission; the relay cannot issue or approve tickets. */
export class DnsPublicAdmission {
  private readonly tickets: BrokerTickets;
  private readonly origin: string;
  private readonly now: () => number;
  readonly budget: BrokerAdmissionBudget;
  constructor(
    private readonly options: {
      origin: string;
      secret: string;
      siteKey: string;
      store: BrokerStore;
      capacity(signal: AbortSignal): Promise<BrokerZoneCapacity>;
      verify(input: TurnstileVerification): Promise<boolean>;
      limits?: Partial<PublicAdmissionLimits>;
      renewalSlots?: number;
      now?: () => number;
    },
  ) {
    this.origin = new URL(options.origin).origin;
    this.now = options.now ?? Date.now;
    this.tickets = new BrokerTickets(options.secret);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(options.siteKey))
      throw new Error("A Turnstile site key is required");
    this.budget = new BrokerAdmissionBudget({ ...options, now: this.now });
  }

  async verification(
    request: BrokerRequest,
    clientAddress: string | undefined,
  ): Promise<DnsBrowserVerification> {
    if (!clientAddress) throw new PublicAdmissionError(403, "client-address-required");
    const network = await this.tickets.fingerprint("network", brokerNetworkBucket(clientAddress));
    const expiresAt = this.now() + 600_000;
    const ticket = await this.tickets.seal(this.purpose(ENROLL_PURPOSE), {
      request,
      network,
      expiresAt,
    });
    const url = new URL("/_dns/v2/enroll", this.origin);
    url.searchParams.set("ticket", ticket);
    return { url: url.href, expiresAt };
  }

  private async enrollment(ticket: string) {
    try {
      const value = await this.tickets.open(this.purpose(ENROLL_PURPOSE), ticket, enrollSchema);
      if (
        value.expiresAt <= this.now() ||
        value.expiresAt > this.now() + 600_000 ||
        value.request.operation.type !== "claim"
      )
        throw new Error("Expired enrollment");
      return value;
    } catch {
      throw new PublicAdmissionError(401, "verification-expired");
    }
  }

  private purpose(kind: string): string {
    return JSON.stringify([kind, this.origin]);
  }

  async ownerBucket(request: BrokerRequest): Promise<string> {
    return this.tickets.fingerprint("owner", request.ownerPublicKey);
  }

  async operation(request: BrokerRequest, challenge: BrokerChallenge): Promise<BrokerChallenge> {
    return {
      ...challenge,
      ticket: await this.tickets.seal(this.purpose(OPERATION_PURPOSE), { request, challenge }),
    };
  }

  async readOperation(
    ticket: string,
  ): Promise<{ request: BrokerRequest; challenge: BrokerChallenge }> {
    try {
      const value = await this.tickets.open(
        this.purpose(OPERATION_PURPOSE),
        ticket,
        operationSchema,
      );
      if (value.challenge.expiresAt <= this.now()) throw new Error("Expired operation");
      return value;
    } catch {
      throw new PublicAdmissionError(401, "challenge-unknown");
    }
  }

  /** Serialized with the operation, so simultaneous replays can never both execute. */
  async consume(request: BrokerRequest, challenge: BrokerChallenge): Promise<void> {
    const key = `used:${request.hostname}`;
    const value = await this.options.store.get(key);
    const used = (value === undefined ? [] : usedSchema.parse(value)).filter(
      (row) => row.expiresAt > this.now(),
    );
    if (used.some((row) => row.id === challenge.challengeId))
      throw new PublicAdmissionError(401, "challenge-unknown");
    if (used.length >= 32) throw new PublicAdmissionError(429, "name-operation-rate");
    used.push({ id: challenge.challengeId, expiresAt: challenge.expiresAt });
    await this.options.store.put(key, used);
  }

  async expireUsed(): Promise<number | undefined> {
    let next: number | undefined;
    for (const [key, raw] of await this.options.store.list("used:")) {
      const rows = usedSchema.parse(raw).filter((row) => row.expiresAt > this.now());
      if (!rows.length) await this.options.store.delete(key);
      else {
        if (rows.length !== usedSchema.parse(raw).length) await this.options.store.put(key, rows);
        for (const row of rows) next = Math.min(next ?? row.expiresAt, row.expiresAt);
      }
    }
    return next;
  }

  async verifyBrowser(request: Request) {
    if (request.headers.get("origin") !== this.origin)
      throw new PublicAdmissionError(403, "origin-refused");
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new PublicAdmissionError(415, "json-required");
    const input = z
      .object({ ticket: z.string().max(8192), token: z.string().min(1).max(2048) })
      .strict()
      .parse(await boundedAdmissionJson(request));
    const enrollment = await this.enrollment(input.ticket);
    const cData = await this.cData(enrollment.request);
    let accepted: boolean;
    try {
      accepted = await this.options.verify({
        token: input.token,
        cData,
        hostname: new URL(this.origin).hostname,
        now: this.now(),
      });
    } catch {
      throw new PublicAdmissionError(503, "verification-unavailable");
    }
    if (!accepted) throw new PublicAdmissionError(403, "verification-refused");
    return enrollment;
  }

  private cData(request: BrokerRequest): Promise<string> {
    return sha256Hex(
      JSON.stringify([
        "omnesis-dns-owner-v1",
        request.hostname,
        request.gatewayId,
        request.ownerPublicKey,
      ]),
    );
  }

  async page(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ticket = url.searchParams.get("ticket") ?? "";
    if (ticket.length > 8192 || [...url.searchParams.keys()].some((key) => key !== "ticket"))
      throw new PublicAdmissionError(400, "invalid-request");
    const value = await this.enrollment(ticket);
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const data = JSON.stringify({
      ticket,
      siteKey: this.options.siteKey,
      cData: await this.cData(value.request),
    }).replaceAll("<", "\\u003c");
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verify gateway setup · Omnesis</title>
<style nonce="${nonce}">body{font:17px system-ui,sans-serif;color:#20303d;background:#f5f7fa;margin:0}main{max-width:460px;margin:12vh auto;padding:32px;background:white;border-radius:16px}h1{font-size:25px}p{line-height:1.55}#message{min-height:50px}button{padding:9px 16px}</style>
<main><h1>Verify this gateway setup</h1><p>This automatic security check protects space for everyone's gateway. Cloudflare may ask you to confirm you are human.</p><div id="widget"></div><p id="message" role="status">Checking your browser…</p><button id="retry" type="button" hidden>Try again</button><noscript>JavaScript is needed for this security check.</noscript></main>
<script nonce="${nonce}">
const setup=${data};
const message=document.querySelector('#message');
const retry=document.querySelector('#retry');
const unavailable=()=>{message.textContent='The security check is unavailable. Reload this page to try again.';retry.hidden=false};
const openedByPortal=location.hash==='${OPENED_BY_PORTAL}';
const done='Done. You can close this tab. Your gateway or terminal continues on its own.';
retry.addEventListener('click',()=>location.reload());
const sdkTimeout=setTimeout(unavailable,20000);
window.addEventListener('error',event=>{if(event.target?.id==='turnstile-sdk'){clearTimeout(sdkTimeout);unavailable()}},true);
window.omnesisDnsCheck=()=>{
  clearTimeout(sdkTimeout);retry.hidden=true;message.textContent='Checking your browser…';
  try {
    turnstile.render('#widget',{
      sitekey:setup.siteKey,action:'${DNS_TURNSTILE_ACTION}',cData:setup.cData,
      callback:async token=>{
        message.textContent='Finishing verification…';retry.hidden=true;
        try{
          const reply=await fetch('/_dns/v2/enroll/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:setup.ticket,token})});
          const result=await reply.json();
          if(!reply.ok){
            message.textContent=result.error==='dns-capacity'?'Gateway capacity is full. Existing gateways stay connected. Try again later.':result.error==='dns-allocation-rate'?'Too many gateways were created recently. Wait before trying again.':'Verification could not finish. Reload this page to try again.';
            retry.hidden=false;return;
          }
          document.querySelector('#widget').hidden=true;
          if(!openedByPortal){message.textContent=done;return}
          message.textContent='Verified. Taking you to your Omnesis account…';
          history.back();
          setTimeout(()=>{message.textContent=done;window.close()},${PORTAL_HANDOFF_MS});
        }catch{message.textContent='Verification could not finish. Reload this page to try again.';retry.hidden=false}
      },
      'error-callback':unavailable
    });
  } catch { unavailable(); }
};
</script>
<script id="turnstile-sdk" nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=omnesisDnsCheck&amp;render=explicit" async defer></script></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'nonce-${nonce}'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      },
    });
  }
}
