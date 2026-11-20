// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The MCP address for agents on the gateway's own machine:
 * `http://localhost:<port>/mcp`, plain HTTP on loopback, which the MCP
 * authorization spec allows for loopback alone. An agent there connects with
 * no certificate to trust, which the gateway's HTTPS address cannot offer when
 * it serves a self-signed certificate.
 *
 * It listens on 127.0.0.1 and ::1 and nowhere else, so nothing off this
 * machine reaches it, and it serves only what an MCP client uses: the
 * endpoint, the OAuth discovery documents and routes, and the static files
 * the sign-in page loads. The portal's other pages redirect to the gateway's
 * HTTPS loopback address, and anything else is not found. A request must name
 * a loopback host: without TLS nothing else checks the name, and a web page
 * that rebinds its own name to 127.0.0.1 would otherwise reach the listener.
 *
 * Requests are answered by the gateway's own app. The listener records each
 * one it accepts (`arrivedOnLocalMcp`), so the OAuth routes know it came from
 * this machine and sign it in through the address it used: that address is
 * its own issuer and `http://localhost:<port>/mcp` its resource.
 *
 * A port another program holds, or any other failure to listen, is reported
 * and never stops the gateway. Inside a container the listener is not
 * started: the container's loopback is not the host's.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { getRequestListener, type Http2Bindings, type HttpBindings } from "@hono/node-server";
import { createLogger } from "@omnesis/core";
import { PUBLIC_PATHS, publicPathAllowed } from "./tailscale-embed/caller.js";
import type { OmnesisConfig } from "@omnesis/config";

const log = createLogger("gateway:local-mcp");

/** The addresses the listener binds: this machine's loopback, and nothing else, ever. */
export const LOCAL_MCP_BIND_ADDRESSES = ["127.0.0.1", "::1"] as const;

/**
 * What an MCP client on this machine needs: the public address's allowlist
 * without the data sources' sign-in callback and the startup probe, neither of
 * which an agent uses.
 */
export const LOCAL_MCP_PATHS: readonly string[] = PUBLIC_PATHS.filter(
  (path) => path !== "/oauth/callback" && path !== "/.well-known/omnesis-startup",
);

/**
 * Where the address for agents on this computer stands:
 *
 * - `listening`: `url` answers.
 * - `starting`: the gateway has not opened it yet.
 * - `off`: `gateway.localMcp.enabled` is false.
 * - `container`: the gateway runs in a container, whose loopback is not the host's.
 * - `port-in-use`: another program holds `port`.
 * - `failed`: listening on `port` failed for another reason.
 */
export type LocalMcpState =
  | { state: "listening"; port: number; url: string }
  | { state: "starting" | "off" | "container" }
  | { state: "port-in-use" | "failed"; port: number };

/**
 * The port the address uses: `OMNESIS_LOCAL_MCP_PORT`, as `OMNESIS_GATEWAY_PORT` names the
 * gateway's, else `gateway.localMcp.port`, else the gateway's port plus one. `0` lets the
 * system choose, which test gateways use so their neighbours' ports stay free.
 */
export function localMcpPort(
  config: OmnesisConfig | undefined,
  gatewayPort: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = env.OMNESIS_LOCAL_MCP_PORT;
  if (fromEnv !== undefined && /^\d+$/u.test(fromEnv) && Number(fromEnv) <= 65_535)
    return Number(fromEnv);
  const configured = config?.gateway?.localMcp?.port;
  if (configured !== undefined) return configured;
  return gatewayPort > 0 && gatewayPort < 65_535 ? gatewayPort + 1 : 0;
}

const accepted = new WeakSet<IncomingMessage>();

/** What listening on an address this machine does not have fails with. */
const ABSENT_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/** Whether a request's Node bindings are those of a request this listener accepted. */
export function arrivedOnLocalMcp(env: unknown): boolean {
  const incoming = (env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return incoming !== undefined && accepted.has(incoming);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export interface LocalMcpListenerOptions {
  /** The port to listen on; 0 lets the system choose. */
  port: number;
  /** The gateway's app, which answers every request the listener accepts. */
  handle: (request: Request, env: HttpBindings | Http2Bindings) => Response | Promise<Response>;
  /** The gateway's HTTPS loopback origin, where the portal's pages are. */
  portalOrigin: () => string;
  /** Called with each server before it listens, so the gateway drains it on shutdown. */
  onServer?: (server: Server) => void;
  /** The addresses to bind (tests); always loopback in the gateway. */
  bindAddresses?: readonly string[];
}

export class LocalMcpListener {
  private current: LocalMcpState;
  private readonly servers: Server[] = [];
  private closing: Promise<void> | null = null;

  constructor(
    private readonly options: LocalMcpListenerOptions | null,
    initial?: LocalMcpState,
  ) {
    this.current = initial ?? (options ? { state: "starting" } : { state: "off" });
  }

  /** A listener that never listens, standing in `state` (`off` or `container`). */
  static notStarted(state: "off" | "container"): LocalMcpListener {
    return new LocalMcpListener(null, { state });
  }

  state(): LocalMcpState {
    return this.current;
  }

  /**
   * Listen on every loopback address; resolves with where it stands, never rejects. A
   * machine without IPv6 has no ::1, and `localhost` then resolves to 127.0.0.1 alone; but
   * another program holding the port on either address would receive what agents send to
   * `localhost`, so that is the port in use.
   */
  async start(): Promise<LocalMcpState> {
    const options = this.options;
    if (!options || this.current.state !== "starting") return this.current;
    const listener = getRequestListener((request, env) => this.answer(request, env, options));
    const [first, ...rest] = options.bindAddresses ?? LOCAL_MCP_BIND_ADDRESSES;
    let port = options.port;
    try {
      port = await this.listenOn(listener, first!, port, options);
      for (const address of rest) {
        try {
          await this.listenOn(listener, address, port, options);
        } catch (error) {
          if (!ABSENT_ADDRESS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
          log.debug(`MCP for agents on this computer is not on ${address}: it has no such address`);
        }
      }
    } catch (error) {
      await this.closeServers(0);
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      this.current = { state: inUse ? "port-in-use" : "failed", port: options.port || port };
      log.warn(
        inUse
          ? `Not serving MCP for agents on this computer: port ${options.port || port} is in use. Set gateway.localMcp.port to another port.`
          : `Not serving MCP for agents on this computer on port ${options.port || port}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.current;
    }
    if (this.closing) {
      // Shutdown began while it was opening: what opened since closes too.
      await this.closeServers(0);
      return this.current;
    }
    this.current = { state: "listening", port, url: `http://localhost:${port}` };
    log.info(`MCP for agents on this computer at http://localhost:${port}/mcp`);
    return this.current;
  }

  /**
   * Stop listening: requests under way get `drainMs` to finish, as on the gateway's own
   * listener, then their connections are closed. A start still under way stops too.
   */
  close(drainMs = 0): Promise<void> {
    this.closing ??= this.closeServers(drainMs);
    return this.closing;
  }

  private async closeServers(drainMs: number): Promise<void> {
    const servers = this.servers.splice(0);
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => server.closeAllConnections?.(), drainMs);
            timer.unref?.();
            server.close(() => {
              clearTimeout(timer);
              resolve();
            });
            server.closeIdleConnections?.();
          }),
      ),
    );
  }

  private listenOn(
    listener: ReturnType<typeof getRequestListener>,
    address: string,
    port: number,
    options: LocalMcpListenerOptions,
  ): Promise<number> {
    const server = createServer((request, response) => {
      accepted.add(request);
      void listener(request, response);
    });
    options.onServer?.(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address, port, exclusive: true }, () => {
        server.off("error", reject);
        server.on("error", (error) => log.warn(`MCP listener on ${address}: ${error.message}`));
        this.servers.push(server);
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  private answer(
    request: Request,
    env: HttpBindings | Http2Bindings,
    options: LocalMcpListenerOptions,
  ): Response | Promise<Response> {
    const url = new URL(request.url);
    const port = this.current.state === "listening" ? this.current.port : null;
    const ownPort = String(port ?? "");
    if (!isLoopbackHost(url.hostname) || (port !== null && url.port !== ownPort)) {
      return Response.json(
        { error: "This address answers only as localhost, 127.0.0.1 or [::1]." },
        { status: 421 },
      );
    }
    if (publicPathAllowed(url.pathname, LOCAL_MCP_PATHS)) return options.handle(request, env);
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/portal" || url.pathname.startsWith("/portal/"))
    ) {
      return Response.redirect(`${options.portalOrigin()}${url.pathname}${url.search}`, 302);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
