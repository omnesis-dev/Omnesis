// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { selectGoogleGateway } from "./gateway-choice-client.js";
import type { GatewayChoice } from "./gateway-directory.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const choice = (value = 1) => ({
  gatewayId: id(value),
  publicOrigin: `https://g-${value}.example.test`,
});
const binding = (value = 1) => ({
  ...choice(value),
  certificate: "fixture-public-leaf",
  identityToken: "fixture-public-proof",
});
const options = () => ({
  relay: new URL("https://relay.example.test"),
  token: "fixture-token",
  signal: new AbortController().signal,
  select: vi.fn<(choices: readonly GatewayChoice[], signal: AbortSignal) => Promise<string>>(
    async () => id(1),
  ),
  fetch: vi.fn<typeof fetch>(),
});
afterEach(() => vi.unstubAllGlobals());

test("only explicit selection fetches the matching binding; paginated metadata never grants access", async () => {
  const config = options();
  config.fetch
    .mockResolvedValueOnce(Response.json({ gateways: [choice(1)], nextCursor: id(1) }))
    .mockResolvedValueOnce(Response.json({ gateways: [choice(2)] }))
    .mockResolvedValueOnce(Response.json(binding(2)));
  config.select.mockImplementation(async (choices) => {
    expect(choices).toEqual([choice(1), choice(2)]);
    expect(Object.isFrozen(choices)).toBe(true);
    expect(Object.isFrozen(choices[0])).toBe(true);
    return id(2);
  });
  expect(await selectGoogleGateway(config)).toEqual(binding(2));
  expect(String(config.fetch.mock.calls[1]![0])).toBe(
    `https://relay.example.test/_relay/v2/gateways?after=${id(1)}`,
  );
  expect(String(config.fetch.mock.calls[2]![0])).toContain(`/_relay/v2/gateway?gatewayId=${id(2)}`);
  expect(config.fetch.mock.calls[0]![1]).toMatchObject({
    headers: { authorization: "Bearer fixture-token" },
    redirect: "error",
  });
});

test("empty, oversized, repeated, malformed and misleading directories cannot choose a gateway", async () => {
  for (const page of [
    { gateways: [] },
    { gateways: [choice()], nextCursor: id(2) },
    { gateways: [], nextCursor: id(1) },
    { gateways: [choice(), choice()] },
    { gateways: [{ ...choice(), publicOrigin: "http://g-1.example.test" }] },
    { gateways: [{ ...choice(), displayName: "\u001b[2Jspoofed" }] },
    { gateways: Array.from({ length: 51 }, (_, index) => choice(index + 1)) },
  ]) {
    const config = options();
    config.fetch.mockResolvedValue(Response.json(page));
    await expect(selectGoogleGateway(config)).rejects.toThrow();
    expect(config.select).not.toHaveBeenCalled();
  }
  const repeated = options();
  repeated.fetch.mockImplementation(async () =>
    Response.json({ gateways: [choice()], nextCursor: id(1) }),
  );
  await expect(selectGoogleGateway(repeated)).rejects.toThrow("changed");
  const tooLarge = options();
  let index = 0;
  tooLarge.fetch.mockImplementation(async () => {
    const row = choice(++index);
    return Response.json({ gateways: [row], nextCursor: row.gatewayId });
  });
  await expect(selectGoogleGateway(tooLarge)).rejects.toThrow("too large");
  expect(tooLarge.fetch).toHaveBeenCalledTimes(20);
});

test("invalid or changed selections and failing network responses never proceed to enrollment", async () => {
  for (const selectedBinding of [
    binding(2),
    { ...binding(), publicOrigin: choice(2).publicOrigin },
  ]) {
    const config = options();
    config.fetch
      .mockResolvedValueOnce(Response.json({ gateways: [choice()] }))
      .mockResolvedValueOnce(Response.json(selectedBinding));
    await expect(selectGoogleGateway(config)).rejects.toThrow("selection changed");
    expect(config.select).not.toHaveBeenCalled();
  }
  const unknown = options();
  unknown.select.mockResolvedValue(id(3));
  unknown.fetch.mockResolvedValue(Response.json({ gateways: [choice(1), choice(2)] }));
  await expect(selectGoogleGateway(unknown)).rejects.toThrow("Choose one");
  expect(unknown.fetch).toHaveBeenCalledTimes(1);
  const unavailable = options();
  unavailable.fetch.mockResolvedValue(new Response("", { status: 503 }));
  await expect(selectGoogleGateway(unavailable)).rejects.toThrow("unavailable");
});

test("cancellation stops selection even if its callback ignores the abort and default fetch remains supported", async () => {
  const config = options(),
    controller = new AbortController();
  config.signal = controller.signal;
  controller.abort(new Error("cancelled fixture"));
  await expect(selectGoogleGateway(config)).rejects.toThrow("cancelled fixture");
  expect(config.fetch).not.toHaveBeenCalled();
  const active = options(),
    cancel = new AbortController();
  active.signal = cancel.signal;
  active.fetch.mockResolvedValue(Response.json({ gateways: [choice(1), choice(2)] }));
  active.select.mockImplementation(async () => {
    cancel.abort(new Error("cancelled during selection"));
    return new Promise(() => {});
  });
  await expect(selectGoogleGateway(active)).rejects.toThrow("cancelled during selection");
  expect(active.fetch).toHaveBeenCalledTimes(1);
  const defaults = options();
  defaults.fetch
    .mockResolvedValueOnce(Response.json({ gateways: [choice()] }))
    .mockResolvedValueOnce(Response.json(binding()));
  vi.stubGlobal("fetch", defaults.fetch);
  const { fetch: _fetch, ...rest } = defaults;
  expect(await selectGoogleGateway(rest)).toEqual(binding());
  expect(defaults.select).not.toHaveBeenCalled();
});
