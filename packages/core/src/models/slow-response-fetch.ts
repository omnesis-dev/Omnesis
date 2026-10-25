// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A `fetch` for requests whose response may legitimately take longer than five
 * minutes to start, such as transcribing a long recording on a CPU-only host.
 *
 * Node's built-in `fetch` gives up on any response whose headers take more
 * than 300 seconds (`UND_ERR_HEADERS_TIMEOUT`), and on a body that pauses for
 * as long. That limit cannot be changed per request, and a dispatcher from the
 * `undici` package is not accepted by every Node release's built-in `fetch`,
 * so this uses the package's own `fetch` with a dispatcher that sets no
 * response deadline. Callers must bound the request themselves with an
 * `AbortSignal`.
 *
 * The package loads on first use, so a process that never makes such a
 * request does not pay for it. Its `fetch` does not recognise the built-in
 * `FormData`, so a multipart body must be sent already encoded, and it does
 * not follow `HTTP(S)_PROXY` settings that the built-in `fetch` can.
 */

type Undici = typeof import("undici");

let client: Promise<{ fetch: Undici["fetch"]; dispatcher: InstanceType<Undici["Agent"]> }> | null =
  null;

function undiciClient() {
  client ??= import("undici").then(({ Agent, fetch }) => ({
    fetch,
    dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
  }));
  return client;
}

// undici's request and response types are structurally the platform's but
// declared separately, so they are bridged with casts.
export const fetchAllowingSlowResponse: typeof fetch = async (input, init) => {
  const { fetch: undiciFetch, dispatcher } = await undiciClient();
  return (await undiciFetch(input as Parameters<Undici["fetch"]>[0], {
    ...(init as Parameters<Undici["fetch"]>[1]),
    dispatcher,
  })) as unknown as Response;
};
