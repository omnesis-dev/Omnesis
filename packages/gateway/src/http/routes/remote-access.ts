// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settings → Connectivity as one setting: the guided setup's own state, the
 * checks for an address the owner runs themselves, and Tailscale already on
 * the host. Every gateway has these and the Omnesis account and relay;
 * `features` says whether it also offers its own Tailscale device (an
 * installation with its helper program).
 *
 * The account, the relay and the gateway's Tailscale device keep their own
 * routes (cloud-relay.ts, tailscale.ts); the portal's guided setup calls them
 * directly, so their step-ups and checks apply unchanged.
 *
 * `mcpAddresses` lists each address away from home with where MCP answers
 * there (see mcp-addresses.ts); PATCH `{ mcp: { <id>: <reach> } }` changes
 * it. Letting MCP answer further loosens the gateway, so it asks for a step-up
 * where the gateway requires one; narrowing it never does. The Tailscale
 * device's public address is that device's own setting, written through the
 * same service call as PATCH /admin/tailscale/settings. Putting MCP on the
 * Internet through Tailscale on this computer turns Funnel on; when Tailscale
 * refuses, the choice is kept and `mcpRefusal` names the command to run.
 *
 * Tailscale on this computer: `publish` serves the gateway, with its pages and
 * device API on the Internet or not (`public`); `unpublish` stops serving it.
 * See host-access.ts for how the two choices share one Funnel.
 */

import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ADDRESS_CHECK_PATH, type AddressChecks } from "../../remote-access/address-check.js";
import {
  MCP_ADDRESS_IDS,
  MCP_CHOICES,
  MCP_REACHES,
  type McpAddresses,
  type McpAddressId,
} from "../../remote-access/mcp-addresses.js";
import {
  remoteAccessFirstSchema,
  type RemoteAccessSettingsStore,
} from "../../remote-access/settings.js";
import { scope } from "../scope.js";
import { requireStepUp } from "../step-up.js";
import { validateJson } from "../validate.js";
import type { PublicAddressSource } from "../../public-address.js";
import type { HostAccess } from "../../remote-access/host-access.js";
import type { RouteApp } from "./types.js";

const mcpReach = z.enum(MCP_REACHES);
const mcpBody = z
  .object(
    Object.fromEntries(MCP_ADDRESS_IDS.map((id) => [id, mcpReach.optional()])) as Record<
      McpAddressId,
      z.ZodOptional<typeof mcpReach>
    >,
  )
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });
const httpsAddress = z
  .string()
  .trim()
  .url("Enter a full address, starting with https://.")
  .refine((value) => URL.canParse(value) && new URL(value).protocol === "https:", {
    message: "The address must start with https://.",
  });
const checkBody = z.object({ url: httpsAddress }).strict();
const publishBody = z.object({ public: z.boolean() }).strict();
const nonceParam = /^[A-Za-z0-9_-]{16,64}$/;

export interface RemoteAccessRouteOptions {
  settings: RemoteAccessSettingsStore;
  checks: AddressChecks;
  /** Tailscale already on this computer; present when the gateway listens on a port. */
  hostAccess?: HostAccess;
  /** The gateway's public address, which applies as soon as it is saved. */
  publicAddress?: PublicAddressSource;
  /** Which addresses away from home answer MCP. */
  mcpAddresses: McpAddresses;
  /** Whether this installation has the gateway's own Tailscale device. */
  tailscaleEmbed: boolean;
}

export function mountRemoteAccessRoutes(app: RouteApp, options: RemoteAccessRouteOptions): void {
  const bounded = bodyLimit({ maxSize: 4096 });
  const addresses = options.mcpAddresses;
  // Built per gateway: a switch for an address this gateway does not offer is refused.
  const settingsBody = z
    .object({
      setupCompleted: z.boolean().optional(),
      first: remoteAccessFirstSchema.optional(),
      mcp: mcpBody.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." })
    .superRefine((body, ctx) => {
      const offered = new Set<string>(addresses.offered());
      for (const [key, reach] of Object.entries(body.mcp ?? {})) {
        if (!offered.has(key))
          ctx.addIssue({
            code: "custom",
            path: ["mcp", key],
            message: "This gateway has no such address.",
          });
        else if (reach && !MCP_CHOICES[key as McpAddressId].includes(reach))
          ctx.addIssue({
            code: "custom",
            path: ["mcp", key],
            message: "This address has no such choice.",
          });
      }
    });
  const state = async () => {
    const configured = options.publicAddress?.baseUrl() ?? null;
    // The stored MCP choices are only the owner's departures from the default; the list says
    // where MCP answers.
    const { mcp, ...choices } = options.settings.get();
    const [mcpAddresses, way] = await Promise.all([
      addresses.list(),
      addresses.publicAddressWay(configured),
    ]);
    return {
      ...choices,
      features: { tailscaleEmbed: options.tailscaleEmbed },
      publicBaseUrl: {
        configured,
        // OMNESIS_PUBLIC_BASE_URL sets it, so one saved in the config changes nothing.
        setByEnvironment: options.publicAddress?.setByEnvironment() ?? false,
        // The way in this address belongs to when it is not the owner's own domain:
        // "relay", "tailnet" or "host"; null for the owner's own.
        way,
      },
      mcpAddresses,
    };
  };

  app.get("/admin/remote-access", scope.admin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await state());
  });
  app.patch(
    "/admin/remote-access",
    scope.admin(),
    bounded,
    requireStepUp((body) => !addresses.loosens((body as { mcp?: unknown } | null)?.mcp)),
    validateJson(settingsBody),
    async (c) => {
      const { mcp, ...body } = c.req.valid("json");
      const mcpRefusal = mcp ? await addresses.update(mcp) : null;
      if (body.first || body.setupCompleted !== undefined) {
        options.settings.update({
          ...(body.first ? { first: body.first } : {}),
          ...(body.setupCompleted === undefined
            ? {}
            : { setupCompletedAt: body.setupCompleted ? new Date().toISOString() : null }),
        });
      }
      return c.json({ ...(await state()), ...(mcpRefusal ? { mcpRefusal } : {}) });
    },
  );

  app.post(
    "/admin/remote-access/check-address",
    scope.admin(),
    bounded,
    validateJson(checkBody),
    async (c) => c.json(await options.checks.check(c.req.valid("json").url)),
  );
  // The other half of the check: only this gateway knows the nonce it just issued.
  app.get(`${ADDRESS_CHECK_PATH}/:nonce`, scope.public(), (c) => {
    const nonce = c.req.param("nonce");
    c.header("Cache-Control", "no-store");
    return nonceParam.test(nonce) && options.checks.answer(nonce)
      ? c.text(nonce)
      : c.json({ error: "Not found" }, 404);
  });

  const host = options.hostAccess;
  if (!host) return;
  app.get("/admin/remote-access/host-tailscale", scope.admin(), async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await host.status());
  });
  // Publishing opens the gateway on the tailnet or to the Internet, so it asks for a step-up
  // where the gateway requires one.
  app.post(
    "/admin/remote-access/host-tailscale/publish",
    scope.admin(),
    bounded,
    requireStepUp(),
    validateJson(publishBody),
    async (c) => c.json(await host.publish(c.req.valid("json").public)),
  );
  // Unpublishing only closes the gateway to others, so it never asks for a step-up.
  app.post("/admin/remote-access/host-tailscale/unpublish", scope.admin(), bounded, async (c) =>
    c.json(await host.unpublish()),
  );
}
