// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import { brand } from "./relay-page.js";
import type { IncomingMessage, ServerResponse } from "node:http";

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
export function sendLaunchPage(
  res: ServerResponse,
  action: string,
  fields: Record<string, string>,
): void {
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
export function sendTakenPage(res: ServerResponse, restart: string): void {
  pageHeaders(res);
  res.writeHead(409, { "content-type": "text/html; charset=utf-8" });
  res.end(
    shell(
      "Opened in another browser",
      `<h1>This sign-in was opened in another browser</h1><p>Finish signing in there. To use this browser instead, go back to ${escape(restart)} and start the sign-in again.</p>`,
    ),
  );
}

/**
 * The Continue press. Only the relay's own page can send it: the browser names that page's origin
 * on a form post. The fields come back exactly as the page sent them, and nothing else.
 */
export async function readLaunchForm(
  req: IncomingMessage,
  origin: string,
  names: { required: string[]; optional?: string[] },
): Promise<Record<string, string>> {
  if (req.headers.origin !== origin) throw new RelayError(403, "Same-origin sign-in required");
  if (
    req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  )
    throw new RelayError(415, "Form sign-in request required");
  const deadline = setTimeout(() => req.destroy(new Error("Request body deadline")), 5000);
  deadline.unref();
  let text: string;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += Buffer.byteLength(chunk);
      if (length > 2048) throw new RelayError(413, "Request too large");
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(deadline);
  }
  const form = new URLSearchParams(text),
    allowed = new Set([...names.required, ...(names.optional ?? [])]),
    fields: Record<string, string> = {};
  for (const name of new Set(form.keys())) {
    const values = form.getAll(name);
    if (!allowed.has(name) || values.length !== 1)
      throw new RelayError(400, "Invalid sign-in request");
    fields[name] = values[0]!;
  }
  if (names.required.some((name) => fields[name] === undefined))
    throw new RelayError(400, "Invalid sign-in request");
  return fields;
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
