// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** Test-only DNS substitution. TLS still verifies the public hostname and fixture CA. */
export function verifiedLoopbackFetch(
  origin: string,
  certificate: string,
  fallback: typeof fetch,
): typeof fetch {
  const exchange = async (request: Request, redirects = 0): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== origin) return fallback(request);
    const body = request.body ? await request.arrayBuffer() : undefined;
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          hostname: "127.0.0.1",
          servername: url.hostname,
          ca: certificate,
          rejectUnauthorized: true,
          method: request.method,
          headers,
          signal: request.signal,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (let index = 0; index < res.rawHeaders.length; index += 2)
            responseHeaders.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!);
          const status = res.statusCode!;
          const stream = [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          if (stream === null) res.resume();
          resolve(
            new Response(stream, {
              status,
              statusText: res.statusMessage,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? Buffer.from(body) : undefined);
    });
    const location = response.headers.get("location");
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      !location ||
      request.redirect === "manual"
    )
      return response;
    await response.body?.cancel();
    if (request.redirect === "error" || redirects >= 20)
      throw new Error("Unexpected TLS fixture redirect");
    const target = new URL(location, url);
    const nextHeaders = new Headers(request.headers);
    if (target.origin !== url.origin) {
      nextHeaders.delete("authorization");
      nextHeaders.delete("cookie");
    }
    const method =
      (response.status === 303 && request.method !== "HEAD") ||
      ([301, 302].includes(response.status) && request.method === "POST")
        ? "GET"
        : request.method;
    return exchange(
      new Request(target, {
        method,
        headers: nextHeaders,
        redirect: request.redirect,
        signal: request.signal,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
      }),
      redirects + 1,
    );
  };
  return (input, init) => exchange(new Request(input, init));
}
