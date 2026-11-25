// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { requestDesktopGateway } from "./gateway-access.js";
import type { DesktopEnrollmentUI } from "./enrollment.js";
import type { DesktopProfile } from "./environment.js";
import type { DesktopProtocolContext } from "./protocol.js";

export const desktopAccountSchema = z.object({
  account: z.object({ linked: z.boolean() }).optional(),
  publicOrigin: z.string().optional(),
  signup: z.object({ inviteOnly: z.boolean() }).optional(),
  config: z.object({ acmeTermsUrl: z.string().optional() }).optional(),
  connect: z
    .object({
      state: z.enum(["idle", "waiting", "registering", "linking", "done", "failed"]),
      authorizeUrl: z.string().optional(),
      connectUrl: z.string().optional(),
      code: z.string().optional(),
      verification: z.object({ url: z.string(), expiresAt: z.number() }).optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type DesktopAccount = z.infer<typeof desktopAccountSchema>;
const accountConnectParams = z
  .object({
    intent: z.enum(["create", "existing"]).default("existing"),
    termsAccepted: z.literal(true),
    invite: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

export function safeBrowserUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid browser destination");
  return url.href;
}

/** Only a validated, fixed action value can complete a browser interaction. */
export function continued(value: unknown): true {
  if (value !== "continue") throw new Error("Invalid browser response");
  return true;
}

const accountRemedies: Readonly<Record<string, string>> = {
  "invite-invalid": "That invitation code was not accepted. Check the code and try again.",
  "invite-expired": "That invitation has expired. Ask for a new invitation and try again.",
  "invite-used":
    "That invitation has already been used. Sign in to your existing account or use a new invitation.",
  expired: "Account sign-in expired. Start sign-in again.",
  capacity: "The connection service is busy. Try again in a moment.",
};
export class DesktopAccountFailure extends Error {
  constructor(code: string | undefined) {
    super(
      code && Object.hasOwn(accountRemedies, code)
        ? accountRemedies[code]
        : "Your account could not connect. Check your internet connection and try again.",
    );
  }
}

export async function connectDesktopAccount(
  profile: DesktopProfile,
  params: unknown,
  context: DesktopProtocolContext,
  dependencies: {
    request?: typeof requestDesktopGateway;
    sleep?: (signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<DesktopAccount> {
  const input = accountConnectParams.parse(params);
  const request = dependencies.request ?? requestDesktopGateway;
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(10 * 60_000)]);
  const shown = new Set<string>();
  let linked = false;
  try {
    let status = desktopAccountSchema.parse(
      await request(profile, "/admin/cloud-relay/connect", { method: "POST", body: input, signal }),
    );
    for (;;) {
      signal.throwIfAborted();
      if (status.account?.linked) {
        linked = true;
        return status;
      }
      if (status.connect?.state === "failed") throw new DesktopAccountFailure(status.connect.error);
      const url =
        status.connect?.verification?.url ??
        status.connect?.authorizeUrl ??
        status.connect?.connectUrl;
      if (url && !shown.has(url)) {
        shown.add(url);
        await context.interactions.ask(
          "openBrowser",
          {
            url: safeBrowserUrl(url),
            code: status.connect?.code,
            message: "Finish connecting your Omnesis account in your browser.",
          },
          continued,
          signal,
        );
      }
      await (
        dependencies.sleep ?? ((currentSignal) => delay(1000, undefined, { signal: currentSignal }))
      )(signal);
      status = desktopAccountSchema.parse(await request(profile, "/admin/cloud-relay", { signal }));
    }
  } finally {
    if (!linked)
      await request(profile, "/admin/cloud-relay/connect/cancel", {
        method: "POST",
        body: {},
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
}

export function desktopEnrollmentUI(context: DesktopProtocolContext): DesktopEnrollmentUI {
  let code: string | undefined;
  return {
    connectCode: (value) => {
      code = value.code;
    },
    openBrowser: async (url, signal) => {
      await context.interactions.ask(
        "openBrowser",
        { url: safeBrowserUrl(url), code, message: "Sign in to find your Omnesis library." },
        continued,
        signal,
      );
    },
    chooseGateway: async (choices, signal) =>
      context.interactions.ask(
        "chooseGateway",
        {
          choices: choices.map((choice) => ({
            id: choice.gatewayId,
            name: choice.displayName ?? "Omnesis library",
          })),
        },
        (value) => {
          if (typeof value !== "string" || !choices.some((choice) => choice.gatewayId === value))
            throw new Error("Invalid library choice");
          return value;
        },
        signal,
      ),
    compareCode: async (value, signal) =>
      context.interactions.ask(
        "compareCode",
        {
          code: value.verificationCode,
          message:
            "Approve this Mac on the device you already use, and check that these codes match.",
        },
        (answer) => {
          if (answer !== "approve") throw new Error("Comparison was not approved");
          return true;
        },
        signal,
      ),
  };
}
