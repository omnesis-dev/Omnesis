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
 * The package's `fetch` does not recognise the built-in `FormData`, so a
 * multipart body must be sent already encoded.
 */

import { Agent, fetch as undiciFetch } from "undici";

const noResponseDeadline = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export const fetchAllowingSlowResponse: typeof fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: noResponseDeadline,
  }) as unknown as Promise<Response>;
