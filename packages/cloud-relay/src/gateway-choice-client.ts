// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bindingOrigin, gatewayBindingSchema, type GatewayBinding } from "./gateway-binding.js";
import { readBoundedJson } from "./google-credentials.js";
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
  })
  .strict();
const pageSchema = z
  .object({ gateways: z.array(choiceSchema).max(50), nextCursor: z.string().uuid().optional() })
  .strict();

/** Metadata is an untrusted discovery hint. Selection must still match the leaf binding and pass SAS approval. */
interface GatewaySelectionOptions {
  relay: URL;
  token: string;
  signal: AbortSignal;
  select(choices: readonly GatewayChoice[], signal: AbortSignal): Promise<string>;
  fetch?: typeof fetch;
}
export async function selectGoogleGateway(
  options: GatewaySelectionOptions,
): Promise<GatewayBinding> {
  return (await selectGateway(options, "v2")).binding;
}
export async function selectAccountGateway(
  options: GatewaySelectionOptions & { accountId: string; expiresAt: number },
) {
  const selected = await selectGateway(options, "v3");
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
  return result;
}
async function selectGateway(
  options: GatewaySelectionOptions,
  version: "v2" | "v3",
): Promise<{ binding: GatewayBinding; raw: unknown }> {
  const request = async (path: string) => {
    options.signal.throwIfAborted();
    const response = await (options.fetch ?? fetch)(new URL(path, options.relay), {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok)
      throw new Error("Gateway discovery is unavailable; try again or pair by QR code");
    return readBoundedJson(response);
  };
  const choices: GatewayChoice[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 20) throw new Error("Gateway directory is too large");
    const response = pageSchema.parse(
      await request(`/_relay/${version}/gateways${cursor === undefined ? "" : `?after=${cursor}`}`),
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
  if (choices.length === 0)
    throw new Error("No gateways are connected to your Omnesis account yet");
  options.signal.throwIfAborted();
  // There is nothing to choose between with one gateway.
  const selected =
    choices.length === 1
      ? choices[0]!.gatewayId
      : await selectBeforeAbort(
          () => options.select(Object.freeze(choices), options.signal),
          options.signal,
        );
  options.signal.throwIfAborted();
  const choice = choices.find((choice) => choice.gatewayId === selected);
  if (!choice) throw new Error("Choose one of the discovered gateways");
  const raw = await request(`/_relay/${version}/gateway?gatewayId=${choice.gatewayId}`);
  const binding = gatewayBindingSchema.parse(
    version === "v2" ? raw : z.object({ binding: gatewayBindingSchema }).parse(raw).binding,
  );
  if (
    binding.gatewayId !== choice.gatewayId ||
    bindingOrigin(binding.publicOrigin).origin !== bindingOrigin(choice.publicOrigin).origin
  )
    throw new Error("Gateway selection changed; start sign-in again");
  return { binding, raw };
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
