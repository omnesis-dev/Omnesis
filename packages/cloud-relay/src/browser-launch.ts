// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import { readBody } from "./relay-json-body.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoginAdmission } from "./admission.js";

/**
 * Sign-in links carry their one-time secret in the query, and link scanners (antivirus, VPN
 * "threat protection", mail filters) fetch what a browser opens, without its cookies and without
 * running scripts. So opening a link changes nothing: it shows a Continue button, and only that
 * press, a same-origin POST, ties the sign-in to the browser. The first browser to press it keeps
 * it, and the same browser may open the link again. Any other browser is told so, and can't take
 * the sign-in over.
 */
export type LaunchView =
  { state: "open" } | { state: "here"; location: string } | { state: "taken" };

/** Refused because another browser already pressed Continue on this sign-in. */
export class LaunchTaken extends RelayError {
  constructor() {
    super(409, "This sign-in was opened in another browser");
  }
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/_relay/account/style.css"></head><body><main>${brand}${body}</main></body></html>`;

function pageHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  // Not `no-referrer`: under it a browser sends `Origin: null` with the form, and the press could
  // not be told apart from another site's. `strict-origin` sends only the origin, never the link.
  res.setHeader("referrer-policy", "strict-origin");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
}

/** The page a link opens: nothing has happened yet, and the press posts the same fields back. */
function sendLaunchPage(res: ServerResponse, action: string, fields: Record<string, string>): void {
  pageHeaders(res);
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join("");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    shell(
      "Continue signing in",
      `<h1>Continue signing in</h1><p>Press Continue to sign in to your Omnesis account in this browser.</p><form method="post" action="${escape(action)}">${hidden}<button type="submit">Continue</button></form>`,
    ),
  );
}

/** `restart` says where to go to start over, for example "your gateway". */
function sendTakenPage(res: ServerResponse, restart: string): void {
  pageHeaders(res);
  res.writeHead(409, { "content-type": "text/html; charset=utf-8" });
  res.end(
    shell(
      "Opened in another browser",
      `<h1>This sign-in was opened in another browser</h1><p>Finish signing in there. To use this browser instead, go back to ${escape(restart)} and start the sign-in again.</p>`,
    ),
  );
}

/** The one-use link's fields, each exactly once and nothing else, or undefined. */
function fieldsOf(values: URLSearchParams, names: LaunchNames): Record<string, string> | undefined {
  const allowed = new Set([...names.required, ...(names.optional ?? [])]),
    fields: Record<string, string> = {};
  for (const name of new Set(values.keys())) {
    const all = values.getAll(name);
    if (!allowed.has(name) || all.length !== 1) return undefined;
    fields[name] = all[0]!;
  }
  return names.required.every((name) => fields[name] !== undefined) ? fields : undefined;
}

export interface LaunchNames {
  required: string[];
  optional?: string[];
}
export interface LaunchRoute<T> {
  admission: LoginAdmission;
  /** The relay's own origin, which the Continue press must come from. */
  origin: string;
  /** Where the page posts: the link's own path. */
  path: string;
  names: LaunchNames;
  /** The checked fields, or undefined when they aren't a launch. */
  parse(fields: Record<string, string>): T | undefined;
  peek(input: T, cookieHeader: string): LaunchView;
  launch(input: T, cookieHeader: string): { location: string; cookie?: string };
  /** The sentence on the "opened in another browser" page that says how to start again. */
  restart: string;
}

/**
 * A sign-in link's route. `GET` shows the Continue page (or sends the browser that already holds
 * the sign-in back to it) and changes nothing; only the `POST` it makes, from the relay's own
 * origin, binds.
 */
export async function serveLaunch<T>(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  route: LaunchRoute<T>,
): Promise<boolean> {
  const parse = (fields: Record<string, string> | undefined) => {
    const input = fields && route.parse(fields);
    if (input === undefined) throw new RelayError(400, "Invalid sign-in link");
    return { fields: fields!, input };
  };
  if (req.method === "GET") {
    const { fields, input } = parse(fieldsOf(url.searchParams, route.names));
    // Reading changes nothing, so it is bounded but not counted as a sign-in attempt.
    return route.admission.poll(async () => {
      const view = route.peek(input, req.headers.cookie ?? "");
      if (view.state === "here") {
        res.writeHead(303, { location: view.location });
        res.end();
      } else if (view.state === "taken") sendTakenPage(res, route.restart);
      else sendLaunchPage(res, route.path, fields);
      return true;
    }, req);
  }
  if (req.method !== "POST") throw new RelayError(405, "Method not allowed");
  if (url.search) throw new RelayError(400, "Invalid sign-in link");
  return route.admission
    .run(async () => {
      const { input } = parse(fieldsOf(await readLaunchForm(req, route.origin), route.names));
      let result: { location: string; cookie?: string };
      try {
        result = route.launch(input, req.headers.cookie ?? "");
      } catch (error) {
        if (!(error instanceof LaunchTaken)) throw error;
        sendTakenPage(res, route.restart);
        return true;
      }
      res.writeHead(303, {
        location: result.location,
        ...(result.cookie ? { "set-cookie": result.cookie } : {}),
      });
      res.end();
      return true;
    }, req)
    .catch((error: unknown) => {
      req.resume();
      throw error;
    });
}

/**
 * The Continue press. Only the relay's own page can send it: the browser names that page's origin
 * on a form post.
 */
async function readLaunchForm(req: IncomingMessage, origin: string): Promise<URLSearchParams> {
  if (req.headers.origin !== origin) throw new RelayError(403, "Same-origin sign-in required");
  if (
    req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    throw new RelayError(415, "Form sign-in request required");
  return new URLSearchParams((await readBody(req, 2048)).toString("utf8"));
}

/** The binding cookie this browser holds for an operation, if exactly one. */
export function launchCookie(header: string, name: string): string | undefined {
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}
