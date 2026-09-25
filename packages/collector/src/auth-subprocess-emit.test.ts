// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { emit, emitFinal, keyringUnavailableNotice } from "./auth-subprocess-emit.js";

/**
 * Build a Writable whose write callback is captured and only invoked when
 * the test explicitly flushes. Lets us assert that `emitFinal` is gated on
 * the callback (drain semantics) rather than resolving as soon as
 * `stream.write` returns.
 */
function captureWriteStream(): {
  stream: Writable;
  chunks: string[];
  flush: (err?: Error | null) => void;
} {
  const chunks: string[] = [];
  let pendingCb: ((err?: Error | null) => void) | null = null;
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, callback): void {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      pendingCb = callback;
    },
  });
  // When the write callback is invoked with an error, Writable destroys
  // itself and emits an 'error' event. Without a listener the test runner
  // surfaces it as an unhandled rejection, even though emitFinal's
  // returned promise rejects correctly. The test is about that promise,
  // so swallow the redundant stream-level error event.
  stream.on("error", () => {});
  return {
    stream,
    chunks,
    flush(err = null) {
      const cb = pendingCb;
      pendingCb = null;
      if (cb) cb(err);
    },
  };
}

describe("emit", () => {
  test("writes one NDJSON line per event", () => {
    const { stream, chunks, flush } = captureWriteStream();
    emit(stream, { type: "url", url: "https://example.com/oauth" });
    flush();
    emit(stream, { type: "qr", data: "QRPAYLOAD" });
    flush();
    expect(chunks).toEqual([
      `{"type":"url","url":"https://example.com/oauth"}\n`,
      `{"type":"qr","data":"QRPAYLOAD"}\n`,
    ]);
  });
});

describe("emitFinal", () => {
  test("resolves only after the stream invokes its write callback", async () => {
    const { stream, chunks, flush } = captureWriteStream();
    let resolved = false;
    const p = emitFinal(stream, { type: "complete", accountId: "+447700000000" });
    void p.then(() => {
      resolved = true;
    });

    // Give the microtask queue a chance to settle. Without drain
    // semantics, the promise would resolve here.
    await new Promise<void>((r) => setImmediate(r));
    expect(resolved).toBe(false);
    expect(chunks).toEqual([`{"type":"complete","accountId":"+447700000000"}\n`]);

    flush();
    await p;
    expect(resolved).toBe(true);
  });

  test("rejects when the stream callback reports an error", async () => {
    const { stream, flush } = captureWriteStream();
    const boom = new Error("EPIPE");
    const p = emitFinal(stream, { type: "error", error: "x" });
    flush(boom);
    await expect(p).rejects.toBe(boom);
  });

  test("appends a trailing newline so the parent's line splitter sees a complete event", async () => {
    const { stream, chunks, flush } = captureWriteStream();
    const p = emitFinal(stream, { type: "complete", accountId: "abc" });
    flush();
    await p;
    expect(chunks[0].endsWith("\n")).toBe(true);
  });
});

describe("keyringUnavailableNotice", () => {
  test("names the keyring when an encrypted install could not load its root key", () => {
    // Without this line the flow dies later reading a credential file, and the
    // error names the file rather than the reason it could not be opened.
    const notice = keyringUnavailableNotice({
      primed: false,
      encryptionRequired: true,
      backend: "passphrase",
    });
    expect(notice).toContain("install root key unavailable");
    expect(notice).toContain("passphrase");
    // The parent splits the child's stderr on newlines before redacting.
    expect(notice?.endsWith("\n")).toBe(true);
  });

  test("reports the backend as auto when none was named", () => {
    expect(
      keyringUnavailableNotice({ primed: false, encryptionRequired: true, backend: undefined }),
    ).toContain("secret store: auto");
  });

  test("stays silent when there is nothing wrong to report", () => {
    // A default install encrypts nothing and primes nothing: warning there
    // would put a keyring error in front of every auth flow that ever runs.
    expect(
      keyringUnavailableNotice({ primed: false, encryptionRequired: false, backend: "file" }),
    ).toBeNull();
    expect(
      keyringUnavailableNotice({ primed: true, encryptionRequired: true, backend: "passphrase" }),
    ).toBeNull();
  });
});
