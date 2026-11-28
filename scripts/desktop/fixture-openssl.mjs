// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnOwnedChildProcess } from "@omnesis/core";
/** Fixed test-tool executable; rejection never substitutes for physical process closure. */
export async function runFixtureOpenSsl(args, options = {}, observe) {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    args.length > 128 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 16384
  )
    throw new Error("Invalid fixture crypto command bounds");
  const owner = spawnOwnedChildProcess("openssl", args, { env: { ...process.env } });
  let reason;
  let stopping;
  const stop = (failure) => {
    reason ??= failure;
    stopping ??= owner.stop();
    void stopping.catch(() => {});
  };
  let outputBytes = 0;
  const count = (part) => {
    outputBytes += part.length;
    if (outputBytes > 65536) stop("output");
  };
  owner.child.stdout?.on("data", count);
  owner.child.stderr?.on("data", count);
  owner.child.stdin?.on("error", () => {});
  owner.child.stdin?.end();
  const abort = () => stop("cancelled");
  const timer = setTimeout(() => stop("deadline"), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    observe?.(owner);
    if (options.signal?.aborted) abort();
    await owner.ready;
    await owner.joined;
    await stopping;
    if (!owner.joinedConfirmed || reason || owner.child.exitCode !== 0 || owner.child.signalCode)
      throw new Error(
        reason ? `Fixture crypto ${reason}; child joined` : "Fixture crypto failed; child joined",
      );
  } catch (error) {
    // A failed spawn, observer, output bound or cancellation still retains this exact owner.
    await owner.stop();
    if (!owner.joinedConfirmed)
      throw Object.assign(new Error("Fixture crypto cleanup is unconfirmed", { cause: error }), {
        cleanupFailure: "qa-openssl",
      });
    if (reason) throw new Error(`Fixture crypto ${reason}; child joined`, { cause: error });
    throw new Error("Fixture crypto failed; child joined", { cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
