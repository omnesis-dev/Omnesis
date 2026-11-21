// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:https";
import { serve, type HttpBindings, type Http2Bindings } from "@hono/node-server";
import { GatewayHttpShutdown } from "../gateway-http-shutdown.js";
import { renderStartupPage, startupPageCsp } from "./page.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SecureContext } from "node:tls";
import type { StartupManager } from "./manager.js";

export const STARTUP_STATUS_PATH = "/.well-known/omnesis-startup";
export type GatewayFetch = (
  request: Request,
  env: HttpBindings | Http2Bindings,
) => Response | Promise<Response>;
type SniCallback = (
  hostname: string,
  callback: (error: Error | null, context?: SecureContext) => void,
) => void;

/** Owns one listener from boot through normal service. No database or application
 * imports: readiness is a dispatcher switch, never a second bind or a proxy. */
export class StartupServer {
  readonly shutdown = new GatewayHttpShutdown();
  private application: GatewayFetch | undefined;
  private sniCallback: SniCallback | undefined;
  private nodeServer: Server | undefined;
  private readonly page = renderStartupPage();
  private readonly csp = startupPageCsp();

  constructor(private readonly manager: StartupManager) {}

  get server(): Server {
    if (!this.nodeServer) throw new Error("Startup HTTPS listener is not open");
    return this.nodeServer;
  }

  async listen(options: {
    port: number;
    hostname: string;
    cert: string;
    key: string;
  }): Promise<void> {
    if (this.nodeServer) throw new Error("Startup listener already opened");
    await new Promise<void>((resolve, reject) => {
      const server = serve(
        {
          fetch: (request, env) => this.handle(request, env),
          port: options.port,
          hostname: options.hostname,
          createServer,
          serverOptions: {
            cert: options.cert,
            key: options.key,
            SNICallback: (hostname, callback) => {
              if (this.sniCallback) this.sniCallback(hostname, callback);
              else callback(null);
            },
          },
        },
        () => {
          server.off("error", reject);
          resolve();
        },
      ) as Server;
      this.nodeServer = server;
      this.shutdown.attach(server);
      server.on("upgrade", this.rejectUpgrade);
      server.once("error", reject);
    });
  }

  setSniCallback(callback: SniCallback): void {
    this.sniCallback = callback;
  }

  /** Synchronous handoff: upgrades and HTTP become available in the same turn. */
  activate(fetch: GatewayFetch, mountUpgrades: (server: Server) => void): void {
    if (this.application) throw new Error("Gateway application already active");
    const state = this.manager.snapshot().state;
    if (state !== "starting") throw new Error("Gateway startup is no longer active");
    mountUpgrades(this.server);
    this.server.off("upgrade", this.rejectUpgrade);
    this.application = fetch;
  }

  private readonly rejectUpgrade = (_request: IncomingMessage, socket: Duplex): void => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n",
    );
  };

  /** Alternate listeners must pass upgrades through the same admission boundary
   * as HTTP. A private socket must not expose app routes before activation or
   * let a second upgrade listener run after the shutdown listener rejects it. */
  admitUpgrade(request: IncomingMessage, socket: Duplex, accept: () => void): void {
    if (!this.application) {
      this.rejectUpgrade(request, socket);
      return;
    }
    const admission = this.shutdown.guard(() => {
      accept();
      return true;
    });
    if (admission instanceof Response) this.rejectUpgrade(request, socket);
  }

  /** Alternate trusted listeners use this same readiness and shutdown gate. */
  handle(request: Request, env: HttpBindings | Http2Bindings): Response | Promise<Response> {
    return this.shutdown.guard(() => this.fetch(request, env));
  }

  private fetch(request: Request, env: HttpBindings | Http2Bindings): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === STARTUP_STATUS_PATH && (request.method === "GET" || request.method === "HEAD")) {
      return Response.json(this.manager.snapshot(), {
        headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (this.application) return this.application(request, env);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    const portal =
      (path === "/portal" || path.startsWith("/portal/")) && !path.startsWith("/portal/api/");
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      path !== "/health" &&
      (acceptsHtml ||
        request.headers.get("sec-fetch-mode") === "navigate" ||
        portal ||
        path === "/")
    ) {
      return new Response(request.method === "HEAD" ? null : this.page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": this.csp,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    }
    return Response.json(
      { error: "Gateway is starting up", code: "GATEWAY_STARTING" },
      { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } },
    );
  }
}
