// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  bindingOrigin,
  certificateFingerprint,
  gatewayBindingSchema,
  type GatewayBinding,
} from "./gateway-binding.js";
import { readBoundedJson } from "./google-credentials.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import type { GatewayChoice } from "./gateway-directory.js";

const choiceSchema = z
  .object({
    gatewayId: z.string().uuid(),
    publicOrigin: z.string().max(2048),
    displayName: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value))
      .optional(),
    online: z.boolean(),
  })
  .strict();
const pageSchema = z
  .object({ gateways: z.array(choiceSchema).max(50), nextCursor: z.string().uuid().optional() })
  .strict();

const expectedGatewaySchema = z
  .object({
    gatewayUrl: z.string().max(2048),
    gatewayFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    tlsSpkiFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type ExpectedAccountGateway = Readonly<z.infer<typeof expectedGatewaySchema>>;

/** Copy trusted local identity before asynchronous authorization can change caller-owned state. */
export function snapshotExpectedAccountGateway(
  value: ExpectedAccountGateway | undefined,
): ExpectedAccountGateway | undefined {
  if (value === undefined) return undefined;
  const expected = expectedGatewaySchema.parse(value);
  if (Object.hasOwn(expected, "tlsSpkiFingerprint") && expected.tlsSpkiFingerprint === undefined)
    throw new Error("The approved library public key pin is invalid");
  if (bindingOrigin(expected.gatewayUrl).origin !== expected.gatewayUrl)
    throw new Error("The approved library origin is invalid");
  return Object.freeze(expected);
}

/** Metadata is an untrusted discovery hint. Selection must still match the leaf binding and pass SAS approval. */
export interface GatewayDirectoryOptions {
  relay: URL;
  token: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}
interface GatewaySelectionOptions extends GatewayDirectoryOptions {
  select(choices: readonly GatewayChoice[], signal: AbortSignal): Promise<string>;
}

/** Returns untrusted account routing hints, including an explicit empty directory response. */
export async function listAccountGateways(
  options: GatewayDirectoryOptions,
): Promise<readonly GatewayChoice[]> {
  return listGateways(options, "v3");
}

export async function selectGoogleGateway(
  options: GatewaySelectionOptions,
): Promise<GatewayBinding> {
  return (await selectGateway(options, "v2")).binding;
}
export async function selectAccountGateway(
  options: GatewaySelectionOptions & {
    accountId: string;
    expiresAt: number;
    expectedGateway?: ExpectedAccountGateway;
  },
) {
  const expected = snapshotExpectedAccountGateway(options.expectedGateway);
  const selected = await selectGateway(options, "v3", expected);
  const result = z
    .object({
      binding: gatewayBindingSchema,
      accountId: z.string().regex(/^[a-f0-9]{64}$/),
      identityToken: z.string().min(1).max(16384),
      expiresAt: z.number().int().positive(),
    })
    .strict()
    .parse(selected.raw);
  if (
    result.accountId !== options.accountId ||
    result.expiresAt > options.expiresAt ||
    result.expiresAt * 1000 <= Date.now()
  )
    throw new Error("Gateway account changed or sign-in expired; start again");
  return { ...result, displayName: selected.displayName };
}
async function selectGateway(
  options: GatewaySelectionOptions,
  version: "v2" | "v3",
  expected?: ExpectedAccountGateway,
): Promise<{ binding: GatewayBinding; raw: unknown; displayName?: string }> {
  const choices = await listGateways(options, version);
  if (choices.length === 0)
    throw new Error("No gateways are connected to your Omnesis account yet");
  const eligible = expected
    ? choices.filter((choice) => bindingOrigin(choice.publicOrigin).origin === expected.gatewayUrl)
    : choices;
  if (expected && eligible.length !== 1)
    throw new Error("The approved library is unavailable or ambiguous; start again");
  options.signal.throwIfAborted();
  // There is nothing to choose between with one gateway.
  const selected =
    eligible.length === 1
      ? eligible[0]!.gatewayId
      : await selectBeforeAbort(
          () => options.select(Object.freeze(eligible), options.signal),
          options.signal,
        );
  options.signal.throwIfAborted();
  const choice = eligible.find((choice) => choice.gatewayId === selected);
  if (!choice) throw new Error("Choose one of the discovered gateways");
  const raw = await directoryRequest(
    options,
    `/_relay/${version}/gateway?gatewayId=${choice.gatewayId}`,
  );
  const binding = gatewayBindingSchema.parse(
    version === "v2" ? raw : z.object({ binding: gatewayBindingSchema }).parse(raw).binding,
  );
  if (
    binding.gatewayId !== choice.gatewayId ||
    bindingOrigin(binding.publicOrigin).origin !== bindingOrigin(choice.publicOrigin).origin
  )
    throw new Error("Gateway selection changed; start sign-in again");
  if (expected) {
    const actual =
      expected.tlsSpkiFingerprint === undefined
        ? certificateFingerprint(binding.certificate)
        : tlsSpkiFingerprint(binding.certificate);
    const approved = expected.tlsSpkiFingerprint ?? expected.gatewayFingerprint;
    if (actual !== approved) throw new Error("The approved library identity changed; start again");
  }
  return { binding, raw, ...(choice.displayName ? { displayName: choice.displayName } : {}) };
}

async function directoryRequest(options: GatewayDirectoryOptions, path: string): Promise<unknown> {
  options.signal.throwIfAborted();
  const response = await (options.fetch ?? fetch)(new URL(path, options.relay), {
    headers: { authorization: `Bearer ${options.token}` },
    redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
  });
  options.signal.throwIfAborted();
  if (!response.ok)
    throw new Error("Gateway discovery is unavailable; try again or pair by QR code");
  return readBoundedJson(response);
}

async function listGateways(
  options: GatewayDirectoryOptions,
  version: "v2" | "v3",
): Promise<readonly GatewayChoice[]> {
  const choices: GatewayChoice[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("Gateway directory is too large");
    const response = pageSchema.parse(
      await directoryRequest(
        options,
        `/_relay/${version}/gateways${cursor === undefined ? "" : `?after=${cursor}`}`,
      ),
    );
    for (const choice of response.gateways) {
      bindingOrigin(choice.publicOrigin);
      if (seen.has(choice.gatewayId))
        throw new Error("Gateway directory changed; refresh the choices");
      seen.add(choice.gatewayId);
      choices.push(Object.freeze(choice));
    }
    if (response.nextCursor === undefined) break;
    if (response.gateways.at(-1)?.gatewayId !== response.nextCursor)
      throw new Error("Invalid gateway directory cursor");
    cursor = response.nextCursor;
  }
  options.signal.throwIfAborted();
  return Object.freeze(choices);
}

async function selectBeforeAbort(
  select: () => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([select(), cancelled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
