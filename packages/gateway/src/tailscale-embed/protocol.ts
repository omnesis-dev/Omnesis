// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The JSON-lines conversation with the Tailscale helper program, mirrored
 * from packages/tailnet-helper/internal/protocol. The gateway writes one
 * command per line on the helper's standard input and reads one event per
 * line from its standard output.
 */

import { z } from "zod";

/** The protocol revision this gateway speaks; a helper reporting another is stopped. */
export const HELPER_PROTOCOL_VERSION = 3;

export const helperBackendSchema = z.enum([
  "starting",
  "needs-login",
  "needs-approval",
  "running",
  "stopped",
]);
export type HelperBackend = z.infer<typeof helperBackendSchema>;

export const helperCertificateSchema = z
  .object({
    source: z.enum(["tailscale", "gateway"]),
    reason: z.enum(["https-disabled", "magicdns-disabled", "pending", "failed"]).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict();
export type HelperCertificate = z.infer<typeof helperCertificateSchema>;

export const helperPublicSchema = z
  .object({
    state: z.enum(["off", "starting", "on", "needs-enable", "unavailable"]),
    url: z.string().url().optional(),
    enableUrl: z.string().url().optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type HelperPublic = z.infer<typeof helperPublicSchema>;

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i);

export const helperStatusSchema = z
  .object({
    type: z.literal("status"),
    protocol: z.number().int(),
    backend: helperBackendSchema,
    loginUrl: z.string().url().optional(),
    node: z
      .object({
        dnsName: hostnameSchema,
        /** The device's name on the tailnet: the first label of `dnsName`. */
        hostName: z.string().min(1).max(63),
        /**
         * The name the device asks for, as the coordination server has it on
         * record; Tailscale names the device after it unless another device
         * holds that name or the device was renamed in the admin console.
         */
        askedName: z.string().min(1).max(63).optional(),
        tailnet: z.string().max(253).optional(),
        ips: z.array(z.string().max(64)).max(8),
      })
      .strict()
      .optional(),
    owner: z
      .object({
        id: z.string().min(1).max(64),
        login: z.string().max(320),
        displayName: z.string().max(320).optional(),
      })
      .strict()
      .optional(),
    certificate: helperCertificateSchema,
    public: helperPublicSchema,
  })
  .strict();
export type HelperStatus = z.infer<typeof helperStatusSchema>;

export const helperFatalSchema = z
  .object({ type: z.literal("fatal"), message: z.string().max(4000) })
  .strict();

export const helperEventSchema = z.discriminatedUnion("type", [
  helperStatusSchema,
  helperFatalSchema,
]);
export type HelperEvent = z.infer<typeof helperEventSchema>;

/** Private parent-to-helper material; never persist or include it in status. */
export const helperGatewayCertificateSchema = z
  .object({
    cert: z
      .string()
      .min(1)
      .max(256 * 1024),
    key: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();
export type HelperGatewayCertificate = z.infer<typeof helperGatewayCertificateSchema>;

/** One command line for the helper. */
export type HelperCommand =
  | { type: "configure"; public: { enabled: boolean; paths: readonly string[] } }
  | { type: "gateway-certificate"; certificate: HelperGatewayCertificate }
  | { type: "login" }
  | { type: "logout" }
  /** Ask Tailscale for this device name, retrying it when Tailscale suffixed it earlier. */
  | { type: "rename"; hostname: string };

/** Parse one line from the helper; null for anything that is not a valid event. */
export function parseHelperEvent(line: string): HelperEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = helperEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function encodeHelperCommand(command: HelperCommand): string {
  const validated =
    command.type === "gateway-certificate"
      ? {
          type: command.type,
          certificate: helperGatewayCertificateSchema.parse(command.certificate),
        }
      : command;
  return `${JSON.stringify(validated)}\n`;
}
