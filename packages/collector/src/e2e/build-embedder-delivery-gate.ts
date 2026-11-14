// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";

const MAX_CONTROL_BYTES = 256;

/** Hold real native build results at Worker delivery, without changing inference. */
export async function createBuildEmbedderDeliveryGate(): Promise<{
  env: Record<string, string>;
  held: Promise<void>;
  release(): void;
  close(): Promise<void>;
}> {
  const nonce = randomBytes(32).toString("hex");
  const waiting = Promise.withResolvers<void>();
  // A failed fixture may tear down before reaching its held await.
  void waiting.promise.catch(() => {});
  const sockets = new Set<Socket>();
  const authenticatedSockets = new Set<Socket>();
  let released = false;
  let closing = false;
  let failure: Error | undefined;
  let closePromise: Promise<void> | undefined;
  const fail = (message: string): void => {
    failure ??= new Error(message);
    waiting.reject(failure);
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    let input = "";
    let authenticated = false;
    socket.on("data", (bytes: Buffer) => {
      if (authenticated) {
        fail("Embedding fixture sent unexpected control bytes");
        socket.destroy();
        return;
      }
      if (bytes.length > MAX_CONTROL_BYTES - input.length) {
        socket.destroy();
        return;
      }
      input += bytes.toString("ascii");
      if (!input.endsWith("\n")) return;
      if (input !== `held:${nonce}\n`) {
        // Unauthenticated local connections never control the held worker.
        socket.destroy();
        return;
      }
      authenticated = true;
      authenticatedSockets.add(socket);
      waiting.resolve();
      if (released) socket.end(`release:${nonce}\n`);
    });
    socket.on("error", () => {
      if (authenticated && !released && !closing) fail("Embedding fixture controller failed");
    });
    socket.on("close", () => {
      sockets.delete(socket);
      authenticatedSockets.delete(socket);
      if (authenticated && !released && !closing)
        fail("Embedding fixture controller disconnected before release");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid embedding gate address");
  const preload = new URL("./build-embedder-delivery-gate.mjs", import.meta.url).href;
  return {
    env: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${JSON.stringify(preload)}`]
        .filter(Boolean)
        .join(" "),
      OMNESIS_E2E_BUILD_DELIVERY_GATE: JSON.stringify({ port: address.port, nonce }),
    },
    held: waiting.promise,
    release() {
      if (failure) throw failure;
      if (released) return;
      released = true;
      for (const socket of authenticatedSockets) socket.end(`release:${nonce}\n`);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      released = true;
      waiting.reject(new Error("Embedding fixture closed before a native result was held"));
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      return closePromise;
    },
  };
}
