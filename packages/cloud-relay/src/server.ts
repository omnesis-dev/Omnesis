// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createLogger } from "@omnesis/core";
import { CloudRelayMetrics } from "./metrics.js";
import { gatewayIdSchema } from "./accounts.js";
import { SESSION_HEADER, relayOrigin, isLoopback, websocketUrl } from "./network.js";
import { acceptProxiedRequest, type CdnFront } from "./cdn-front.js";
import {
  verifyGatewayBinding,
  gatewayBindingSchema,
  bindingOrigin,
  gatewayBindingNonce,
} from "./gateway-binding.js";
import { verifyRoutingHostname } from "./hostname-proof.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { createTlsRouter } from "./tls-router.js";
import { LoginAdmission, type LoginLimits } from "./admission.js";
import { acceptProxyProtocol, type ProxyProtocolPeers } from "./proxy-protocol.js";
import {
  GatewayKeyAuthentication,
  keyBindingOwnerAccount,
  keyBindingOwnerPublicKey,
} from "./gateway-key-auth.js";
import { RelayWebLogin, type RelayWebLoginOptions } from "./relay-web-login.js";
import { RelayError, TunnelBroker, type TunnelLimits } from "./tunnels.js";
import { dnsChallengeValueSchema } from "./acme-dns.js";
import { accountId } from "./identity.js";
import { completeKeyEnrollment } from "./key-enrollment.js";
import { GatewayDirectory } from "./gateway-directory.js";
import { AccountServices, type AccountSignInConfiguration } from "./account-services.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { RelayRecovery } from "./relay-recovery.js";
import { assertRecoveryPolicyCurrent, type TrustedRecoveryPolicy } from "./recovery-verifier.js";
import {
  createGoogleBrowserRoutes,
  type GoogleBrowserServerConfiguration,
} from "./google-browser-server.js";
import type { Identity, IdentityProvider, RelaySessions } from "./identity.js";
import type { AcmeDnsChallenges } from "./acme-dns.js";
import type { RelayAccounts } from "./accounts.js";

export interface CloudRelayOptions {
  metrics?: CloudRelayMetrics;
  identity?: IdentityProvider;
  /** Trusted public control origin; incoming Host headers never choose proof recipients. */
  controlOrigin?: string;
  /** Explicit isolated development enrollment; requires an actual loopback listener and recipient. */
  allowLoopbackEnrollment?: boolean;
  /** Dedicated native desktop OAuth audience; web login tokens cannot attest gateway keys. */
  gatewayIdentity?: IdentityProvider;
  sessions: RelaySessions;
  accounts: RelayAccounts;
  limits?: TunnelLimits;
  loginLimits?: LoginLimits;
  tls?: { key: string; cert: string };
  relayDomain?: string;
  publicDataPort?: number;
  hostnameProof?: (hostname: string, account: string, gatewayId: string) => Promise<boolean>;
  webLogin?: Omit<RelayWebLoginOptions, "accountBrowser">;
  accountSignIn?: AccountSignInConfiguration;
  acmeDns?: AcmeDnsChallenges;
  recoveryPolicy?: TrustedRecoveryPolicy;
  googleBrowser?: GoogleBrowserServerConfiguration;
  /**
   * TCP front layers whose PROXY protocol header both listeners require and
   * read before anything else. Its client address feeds rate limits, logs and
   * gateway stream reports, never authorization.
   */
  proxyProtocolPeers?: ProxyProtocolPeers;
  /**
   * A TLS-terminating reverse proxy (a CDN) in front of this control listener.
   * Without it nothing here changes: no request header names a client.
   */
  cdn?: CdnFront;
}

/** A gateway sends this when it can follow the tunnel to another origin. */
export const TUNNEL_DIRECT_HEADER = "x-omnesis-tunnel-direct";
/** Longer than the proxy keeps an idle origin connection it may still reuse for a request. */
const PROXIED_KEEP_ALIVE_MS = 120_000;

const log = createLogger("cloud-relay:enrollment");

const loginSchema = z.object({ idToken: z.string().min(1).max(16_384) }).strict();

/** Callers supply explicit relay control credentials separately from gateway application auth. */
export function createCloudRelay(options: CloudRelayOptions): {
  server: Server;
  dataServer: ReturnType<typeof createTlsRouter>["server"];
  metrics(): string;
  close(): Promise<void>;
} {
  if (options.accountSignIn && !options.controlOrigin)
    throw new Error("Account sign-in requires the relay HTTPS control origin");
  const metrics = options.metrics ?? new CloudRelayMetrics();
  const cdn = options.cdn;
  const loginAdmission = LoginAdmission.fromLimits(options.loginLimits);
  const googleBrowser = options.googleBrowser
    ? createGoogleBrowserRoutes(
        options.googleBrowser,
        {
          origin: () => keyControlOrigin(),
          gatewayBinding: (account) => gatewayBinding(account),
          authenticate: (req) => authenticate(req),
        },
        loginAdmission,
      )
    : undefined;
  const broker = new TunnelBroker(options.limits, metrics);
  const recovery = options.recoveryPolicy
    ? new RelayRecovery(options.accounts, options.recoveryPolicy, {
        seal: (google, owner) => options.sessions.sealGoogleLink(keyControlOrigin(), google, owner),
        verify: (google, owner, seal) =>
          options.sessions.verifyGoogleLinkSeal(keyControlOrigin(), google, owner, seal),
      })
    : undefined;
  const resolveAccount = (account: string) =>
    recovery ? recovery.resolveAccount(account) : options.accounts.resolveAccount(account);
  const googleAccountForOwner = (owner: string) =>
    recovery
      ? recovery.googleAccountForOwner(owner)
      : options.accounts.googleAccountForOwner(owner);
  const issueSession = (identity: Identity) =>
    options.sessions.issue(
      options.recoveryPolicy
        ? {
            ...identity,
            expiresAt: Math.min(identity.expiresAt, options.recoveryPolicy.expiresAt),
          }
        : identity,
    );
  const gatewayBinding = (account: string) =>
    recovery ? recovery.binding(account) : options.accounts.gatewayBinding(account);
  const gatewayAccounts = (identity: string) =>
    recovery ? recovery.gatewayAccounts(identity) : options.accounts.gatewayAccounts(identity);
  const directory = new GatewayDirectory({
    accounts: gatewayAccounts,
    binding: gatewayBinding,
    name: (owner) => options.accounts.gatewayDisplayName(owner),
  });
  const linkedIdentity = (identity: string) =>
    gatewayAccounts(identity).some((owner) => owner !== identity);
  const router = createTlsRouter({
    metrics,
    accountForHostname: (host) =>
      recovery ? recovery.accountForHostname(host) : options.accounts.accountForHostname(host),
    open: (account, signal, client) => broker.open(account, signal, client),
    maxConnections: options.limits?.maxStreams,
    helloTimeoutMs: options.limits?.connectTimeoutMs,
  });
  const accountOwner = (account: string) => {
    const binding = gatewayBinding(account);
    if (!binding) return undefined;
    const ownerPublicKey = keyBindingOwnerPublicKey(binding);
    if (!ownerPublicKey || keyBindingOwnerAccount(binding) !== account) return undefined;
    return {
      ownerAccountId: account,
      gatewayId: binding.gatewayId,
      publicOrigin: binding.publicOrigin,
      tlsSpkiFingerprint: tlsSpkiFingerprint(binding.certificate),
      ownerPublicKey,
    };
  };
  /** A registration that is gone holds no tunnel and no DNS challenge lease. */
  const disconnect = (account: string) => {
    broker.closeAccount(account);
    // A lease left behind expires by itself within ten minutes.
    void options.acmeDns?.forget(account).catch(() => {});
  };
  const accountServices = options.accountSignIn
    ? new AccountServices({
        origin: options.controlOrigin!,
        configuration: options.accountSignIn,
        accounts: options.accounts,
        sessions: options.sessions,
        google: options.webLogin?.identity,
        admission: loginAdmission,
        gatewayAccounts,
        gatewayBinding,
        currentOwner: accountOwner,
        deleteAccount: (account, version) => {
          const removed = options.accounts.deleteAccount(account, version);
          for (const id of removed) disconnect(id);
          log.info(`Deleted an Omnesis account and ${removed.length} routing registrations`);
        },
        deleteGateway: (owner) => {
          options.accounts.deleteGateway(owner);
          disconnect(owner);
          log.info("A gateway left its Omnesis account; its registration is removed");
        },
        assertCurrent: () => {
          if (options.recoveryPolicy) {
            try {
              assertRecoveryPolicyCurrent(options.recoveryPolicy);
            } catch {
              throw new RelayError(503, "Account coordination is temporarily unavailable");
            }
          }
        },
        authenticateOwner: async (req) => {
          const session = await authenticate(req);
          if (
            session.identityAccountId !== session.accountId ||
            linkedIdentity(session.identityAccountId)
          )
            throw new RelayError(403, "A raw gateway owner-key session is required");
          const owner = accountOwner(session.accountId);
          if (!owner) throw new RelayError(403, "Verified gateway owner required");
          return { ...owner, sessionExpiresAt: session.expiresAt };
        },
      })
    : undefined;
  // Google's redirect exists only to sign in to account services, which the opt-in gates.
  const webLogin =
    options.webLogin && accountServices
      ? new RelayWebLogin(
          {
            ...options.webLogin,
            accountBrowser: {
              begin: (req) => accountServices.googleContext(req),
              complete: (token, nonce, context, request) =>
                accountServices.completeGoogle(token, nonce, context, request),
              failed: (context) => accountServices.googleFailure(context),
            },
          },
          loginAdmission,
        )
      : undefined;
  const keyControlOrigin = (): string => {
    if (options.controlOrigin) return relayOrigin(options.controlOrigin).origin;
    if (!options.allowLoopbackEnrollment)
      throw new RelayError(503, "Configure the relay public control origin");
    const address = server.address();
    if (!address || typeof address === "string" || !["127.0.0.1", "::1"].includes(address.address))
      throw new RelayError(503, "Configure the relay public control origin");
    const host = address.address === "::1" ? "[::1]" : "127.0.0.1";
    return `${options.tls ? "https" : "http"}://${host}:${address.port}`;
  };
  const keyAuthentication = new GatewayKeyAuthentication({ relayOrigin: keyControlOrigin });
  const hostnameProof =
    options.hostnameProof ??
    ((name: string, account: string, gateway: string) =>
      verifyRoutingHostname(name, account, gateway, options.relayDomain));
  const upgraded = new Set<Duplex>();
  const controls = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  const channels = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const server = options.tls ? createHttpsServer(options.tls) : createServer();
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  // A proxy reuses its connections; closing one as it sends the next request loses that request.
  if (cdn) server.keepAliveTimeout = PROXIED_KEEP_ALIVE_MS;

  const authenticate = async (
    req: IncomingMessage,
    discovery = false,
  ): Promise<{ accountId: string; identityAccountId: string; expiresAt: number }> => {
    // Node can discard duplicate Authorization headers while parsing. Inspect
    // the original field names so conflicting credentials are always refused.
    const credentialFields = req.rawHeaders.filter(
      (name, index) =>
        index % 2 === 0 && [SESSION_HEADER, "authorization"].includes(name.toLowerCase()),
    );
    if (credentialFields.length !== 1) throw new RelayError(401, "One relay credential required");
    const authorization = req.headers.authorization;
    const token =
      authorization === undefined
        ? req.headers[SESSION_HEADER]
        : /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization)?.[1];
    if (typeof token !== "string" || token.length > 4096)
      throw new RelayError(401, "Relay authentication required");
    try {
      const session = await options.sessions.verify(token);
      if (options.recoveryPolicy) assertRecoveryPolicyCurrent(options.recoveryPolicy);
      const accountId = discovery ? session.accountId : resolveAccount(session.accountId);
      if (!discovery || options.accounts.gatewayBinding(session.accountId) !== undefined)
        recovery?.binding(accountId);
      return {
        ...session,
        expiresAt: options.recoveryPolicy
          ? Math.min(session.expiresAt, options.recoveryPolicy.expiresAt)
          : session.expiresAt,
        identityAccountId: session.accountId,
        accountId,
      };
    } catch {
      throw new RelayError(401, "Relay authentication failed");
    }
  };

  server.on("request", (req, res) => {
    const started = performance.now();
    res.once("finish", () =>
      metrics.http(req.method, req.url, res.statusCode, (performance.now() - started) / 1000),
    );
    // A shared cache must never keep a response; the few public ones say so themselves.
    if (!res.headersSent) res.setHeader("cache-control", "no-store");
    const proxied = cdn !== undefined && acceptProxiedRequest(req, cdn);
    void (async () => {
      if (
        cdn?.directRoutes === "tunnel" &&
        !proxied &&
        !(req.url === "/healthz" && req.method === "GET")
      )
        throw new RelayError(421, "Use the relay's public address");
      if (accountServices && (await accountServices.handle(req, res))) return;
      if (googleBrowser && (await googleBrowser.handle(req, res))) return;
      if (webLogin && (await webLogin.handle(req, res))) return;
      if (req.url === "/healthz" && req.method === "GET") {
        const policy = options.recoveryPolicy;
        let expired = false;
        if (policy) {
          try {
            assertRecoveryPolicyCurrent(policy);
          } catch {
            expired = true;
          }
        }
        res.writeHead(expired ? 503 : 200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: !expired,
            protocol: 2,
            ...(policy
              ? {
                  recovery: {
                    epoch: policy.epoch,
                    expiresAt: policy.expiresAt,
                    state: expired ? "expired" : "current",
                  },
                }
              : {}),
          }),
        );
        return;
      }
      if (req.url?.split("?")[0] === "/_relay/v2/config") {
        if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
        const query = new URL(req.url, "http://relay.invalid").searchParams;
        if (req.url.length > 512 || query.size !== 1 || !query.has("gatewayId"))
          throw new RelayError(400, "One gateway UUID is required");
        const gateway = gatewayIdSchema.safeParse(query.get("gatewayId"));
        if (!gateway.success) throw new RelayError(400, "Invalid gateway UUID");
        const address = server.address();
        const privateEnrollment =
          options.allowLoopbackEnrollment === true &&
          address !== null &&
          typeof address !== "string" &&
          ["127.0.0.1", "::1"].includes(address.address) &&
          (!options.controlOrigin ||
            isLoopback(new URL(relayOrigin(options.controlOrigin)).hostname));
        const data = router.server.address();
        const port =
          options.publicDataPort ??
          (privateEnrollment && data !== null && typeof data !== "string" ? data.port : 443);
        let publicOrigin: string | undefined;
        if (options.relayDomain) {
          const hostname = hostedGatewayHostname(gateway.data, options.relayDomain);
          try {
            publicOrigin = bindingOrigin(
              `https://${hostname}${port === 443 ? "" : `:${port}`}`,
            ).origin;
          } catch {
            throw new RelayError(503, "Relay hostname assignment is unavailable");
          }
          // Short names collide; a new gateway learns here to pick another id before it enrolls.
          if (!options.accounts.hostnameAvailable(hostname, gateway.data))
            throw new RelayError(409, "Hosted name belongs to another gateway");
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            protocol: 2,
            gatewayId: gateway.data,
            publicOrigin,
            managedDomain: options.relayDomain,
            invitationRequired: !privateEnrollment,
            signup: accountServices?.signupOpen() ?? false,
            dnsChallenges: Boolean(options.acmeDns),
          }),
        );
        return;
      }
      if (req.url === "/_relay/v2/acme/challenge") {
        if (!options.acmeDns)
          throw new RelayError(503, "Managed DNS challenges are not configured");
        const session = await authenticate(req);
        const binding = gatewayBinding(session.accountId);
        if (
          session.identityAccountId !== session.accountId ||
          !binding ||
          keyBindingOwnerAccount(binding) !== session.accountId
        )
          throw new RelayError(403, "A raw gateway owner-key session is required");
        if (req.method !== "POST" && req.method !== "DELETE")
          throw new RelayError(405, "Method not allowed");
        return loginAdmission.run(async () => {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new RelayError(415, "JSON required");
          const parts: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 512) throw new RelayError(413, "DNS challenge body too large");
            parts.push(Buffer.from(chunk));
          }
          let input: unknown;
          try {
            input = JSON.parse(Buffer.concat(parts).toString());
          } catch {
            throw new RelayError(400, "Invalid DNS challenge body");
          }
          try {
            if (req.method === "POST") {
              const value = z.object({ value: dnsChallengeValueSchema }).strict().parse(input);
              const lease = await options.acmeDns!.create(
                session.accountId,
                bindingOrigin(binding.publicOrigin).hostname,
                value.value,
              );
              res.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
              });
              res.end(JSON.stringify(lease));
            } else {
              const value = z.object({ id: z.string().uuid() }).strict().parse(input);
              await options.acmeDns!.remove(session.accountId, value.id);
              res.writeHead(204, { "cache-control": "no-store" });
              res.end();
            }
          } catch (error) {
            throw error instanceof RelayError
              ? error
              : new RelayError(400, "Invalid DNS challenge request");
          }
        }, req);
      }
      if (req.url === "/_relay/v2/key/challenge" || req.url === "/_relay/v2/key/complete") {
        if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
        return loginAdmission.run(async () => {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new RelayError(415, "JSON required");
          const parts: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 40_000) throw new RelayError(413, "Key authentication body too large");
            parts.push(Buffer.from(chunk));
          }
          let input: unknown;
          try {
            input = JSON.parse(Buffer.concat(parts).toString());
          } catch {
            throw new RelayError(400, "Invalid key authentication body");
          }
          if (req.url === "/_relay/v2/key/challenge") {
            let challenge;
            try {
              challenge = keyAuthentication.challenge(input);
            } catch (error) {
              throw error instanceof RelayError
                ? error
                : new RelayError(400, "Invalid key registration");
            }
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(challenge));
            return;
          }
          const session = await completeKeyEnrollment(input, {
            authentication: keyAuthentication,
            accounts: options.accounts,
            sessions: options.sessions,
            recovery,
            issueSession,
            hostnameProof,
            controlOrigin: keyControlOrigin,
            privateEnrollmentAllowed: () => {
              const address = server.address();
              return (
                options.allowLoopbackEnrollment === true &&
                address !== null &&
                typeof address !== "string" &&
                ["127.0.0.1", "::1"].includes(address.address) &&
                isLoopback(new URL(keyControlOrigin()).hostname)
              );
            },
            closeMigratedAccount: (account) => broker.closeAccount(account),
          }).catch((error: unknown) => {
            // The response carries no reason, so this line is the operator's only clue.
            log.warn(`Gateway registration refused: ${String(error)}`);
            throw error;
          });
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(session));
        }, req);
      }
      if (req.url === "/_relay/v1/login" && req.method === "POST") {
        if (!options.identity) throw new RelayError(503, "Google sign-in is not configured");
        return loginAdmission.run(async () => {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new RelayError(415, "JSON required");
          const body: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 20_000) throw new RelayError(413, "Login body too large");
            body.push(Buffer.from(chunk));
          }
          let input: z.infer<typeof loginSchema>;
          try {
            input = loginSchema.parse(JSON.parse(Buffer.concat(body).toString()));
          } catch {
            throw new RelayError(400, "Invalid login body");
          }
          let session;
          try {
            session = await issueSession(await options.identity!.verify(input.idToken));
          } catch {
            throw new RelayError(401, "Identity verification failed");
          }
          options.accounts.registerAccount(session.accountId);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(session));
        }, req);
      }
      if (req.url === "/_relay/v2/key/google-link") {
        const session = await authenticate(req);
        const binding = gatewayBinding(session.accountId);
        if (
          session.identityAccountId !== session.accountId ||
          !binding ||
          keyBindingOwnerAccount(binding) !== session.accountId
        )
          throw new RelayError(403, "A raw gateway owner-key session is required");
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              googleAccountId: googleAccountForOwner(session.accountId) ?? null,
            }),
          );
          return;
        }
        if (req.method === "DELETE") {
          if (recovery) recovery.unlinkGoogleAccount(session.accountId);
          else {
            const linked = options.accounts.googleAccountForOwner(session.accountId);
            if (linked !== undefined)
              options.accounts.unlinkGoogleAccount(linked, session.accountId);
          }
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
          return;
        }
        if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
        if (!options.gatewayIdentity)
          throw new RelayError(503, "Gateway Google sign-in is not configured");
        return loginAdmission.run(async () => {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new RelayError(415, "JSON required");
          const parts: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += Buffer.byteLength(chunk);
            if (bytes > 20_000) throw new RelayError(413, "Google link body too large");
            parts.push(Buffer.from(chunk));
          }
          let identity;
          try {
            const value = z
              .object({ identityToken: z.string().min(1).max(16_384) })
              .strict()
              .parse(JSON.parse(Buffer.concat(parts).toString()));
            identity = await options.gatewayIdentity!.verify(
              value.identityToken,
              gatewayBindingNonce(binding),
            );
          } catch {
            throw new RelayError(400, "Invalid Google owner identity proof");
          }
          if (JSON.stringify(gatewayBinding(session.accountId)) !== JSON.stringify(binding))
            throw new RelayError(409, "Gateway identity changed; sign in again");
          const google = accountId(identity);
          if (recovery) recovery.linkGoogleAccount(google, session.accountId);
          else options.accounts.linkGoogleAccount(google, session.accountId);
          res.writeHead(204, { "cache-control": "no-store" });
          res.end();
        }, req);
      }
      const directoryUrl = new URL(req.url!, "http://relay.invalid");
      if (directoryUrl.pathname === "/_relay/v2/gateways") {
        if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
        const session = await authenticate(req, true);
        const result = directory.list(session.identityAccountId, directoryUrl.searchParams);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }
      if (directoryUrl.pathname === "/_relay/v2/gateway") {
        const session = await authenticate(req, req.method === "GET");
        if (req.method === "GET") {
          const binding = directory.select(session.identityAccountId, directoryUrl.searchParams);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(binding));
          return;
        }
        if (req.method === "POST") {
          if (recovery) throw new RelayError(403, "Owner-key recovery registration is required");
          if (
            session.identityAccountId !== session.accountId ||
            linkedIdentity(session.identityAccountId)
          )
            throw new RelayError(403, "Linked Google identities cannot replace gateway ownership");
          if (!options.gatewayIdentity)
            throw new RelayError(503, "Gateway sign-in provider not configured");
          return loginAdmission.run(async () => {
            const parts: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
              bytes += Buffer.byteLength(chunk);
              if (bytes > 40_000) throw new RelayError(413, "Binding too large");
              parts.push(Buffer.from(chunk));
            }
            let binding;
            try {
              binding = await verifyGatewayBinding(
                JSON.parse(Buffer.concat(parts).toString()),
                session.accountId,
                options.gatewayIdentity!,
              );
            } catch {
              throw new RelayError(400, "Invalid gateway identity binding");
            }
            const host = bindingOrigin(binding.publicOrigin).hostname;
            if (!(await hostnameProof(host, session.accountId, binding.gatewayId)))
              throw new RelayError(403, "Hostname ownership proof required");
            options.accounts.registerBinding(
              session.accountId,
              gatewayBindingSchema.parse({
                gatewayId: binding.gatewayId,
                publicOrigin: binding.publicOrigin,
                certificate: binding.certificate,
                identityToken: binding.identityToken,
              }),
            );
            res.writeHead(204, { "cache-control": "no-store" });
            res.end();
          }, req);
        }
        throw new RelayError(405, "Method not allowed");
      }
      // Application HTTP must terminate at the gateway, never at this daemon.
      throw new RelayError(404, "Use the gateway's end-to-end TLS origin");
    })().catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent)
        res.writeHead(error instanceof RelayError ? error.status : 500, {
          "cache-control": "no-store",
        });
      res.end();
    });
  });

  // Registered last, so the header is read before HTTP, TLS or the ClientHello router run.
  const fronts = options.proxyProtocolPeers
    ? [server, router.server].map((listener) =>
        acceptProxyProtocol(listener, options.proxyProtocolPeers!),
      )
    : [];

  server.on("upgrade", (req, socket, head) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    socket.on("error", () => socket.destroy());
    const proxied = cdn !== undefined && acceptProxiedRequest(req, cdn);
    void (async () => {
      if (
        cdn?.tunnelOrigin &&
        proxied &&
        req.url === "/_relay/v1/tunnel" &&
        req.headers[TUNNEL_DIRECT_HEADER] === "1"
      ) {
        metrics.http("GET", req.url, 307, 0);
        rejectUpgrade(socket, 307, websocketUrl(relayOrigin(cdn.tunnelOrigin), req.url));
        return;
      }
      const session = await authenticate(req);
      if (socket.destroyed) return;
      if (
        session.identityAccountId !== session.accountId ||
        linkedIdentity(session.identityAccountId)
      )
        throw new RelayError(
          403,
          "Linked Google identities cannot operate gateway control channels",
        );
      if (req.url === "/_relay/v1/tunnel") {
        if (req.headers["x-omnesis-tunnel-protocol"] !== "2")
          throw new RelayError(426, "End-to-end TLS tunnel required");
        const gateway = gatewayIdSchema.safeParse(req.headers["x-omnesis-gateway-id"]);
        if (!gateway.success) throw new RelayError(400, "Invalid gateway ID");
        if (recovery && gatewayBinding(session.accountId)?.gatewayId !== gateway.data)
          throw new RelayError(403, "A verified gateway recovery binding is required");
        broker.admit(session.accountId);
        // A session can outlive its registration: 401 sends the gateway back to prove its keys.
        if (!options.accounts.bindGateway(session.accountId, gateway.data))
          throw options.accounts.registered(session.accountId)
            ? new RelayError(409, "Account already has a different gateway")
            : new RelayError(401, "This gateway is not registered");
        controls.handleUpgrade(req, socket, head, (ws) => {
          metrics.http("GET", req.url, 101, 0);
          broker.attach(session.accountId, ws, session.expiresAt);
        });
        return;
      }
      if (req.url === "/_relay/v1/data") {
        const ticket = req.headers["x-omnesis-relay-ticket"];
        if (typeof ticket !== "string" || !broker.canClaim(session.accountId, ticket))
          throw new RelayError(403, "Invalid channel ticket");
        channels.handleUpgrade(req, socket, head, (ws) => {
          metrics.http("GET", req.url, 101, 0);
          broker.claim(session.accountId, ticket, ws);
        });
        return;
      }
      throw new RelayError(404, "Use the gateway's end-to-end TLS origin");
    })().catch((error: unknown) => {
      const status = error instanceof RelayError ? error.status : 500;
      metrics.http("GET", req.url, status, 0);
      rejectUpgrade(socket, status);
    });
  });

  return {
    server,
    dataServer: router.server,
    metrics: () =>
      metrics.render({
        ...loginAdmission.snapshot(),
        ...broker.snapshot(),
        ...router.snapshot(),
        ...options.accounts.snapshot(),
        ...options.accounts.identities.snapshot(),
        ...(options.acmeDns?.snapshot() ?? { dnsLeases: 0, dnsQueued: 0 }),
        recoveryExpiresAt: options.recoveryPolicy?.expiresAt ?? 0,
        recoveryEpoch: options.recoveryPolicy?.epoch ?? 0,
      }),
    async close() {
      for (const front of fronts) front.close();
      cdn?.proxies.close?.();
      accountServices?.close();
      webLogin?.close();
      googleBrowser?.close();
      if (router.server.listening) await router.close();
      broker.close();
      await options.acmeDns?.close().catch(() => {});
      for (const socket of upgraded) socket.destroy();
      for (const client of [...controls.clients, ...channels.clients]) client.terminate();
      controls.close();
      channels.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function validateTarget(req: IncomingMessage): void {
  if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.method === "CONNECT") {
    throw new RelayError(400, "Origin-form HTTP requests required");
  }
}

export function rejectUpgrade(socket: Duplex, status: number, location?: string): void {
  socket.end(
    `HTTP/1.1 ${status} Relay error\r\n${location ? `Location: ${location}\r\nCache-Control: no-store\r\n` : ""}Connection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}
