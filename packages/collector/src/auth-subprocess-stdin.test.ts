// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit coverage for the auth-subprocess stdin receiver: NDJSON framing
 * across chunk boundaries, first-code-wins, malformed-line tolerance,
 * EOF / timeout semantics. Drives a real PassThrough so the chunking
 * behaviour matches a live pipe.
 */

import { PassThrough, Readable } from "node:stream";
import { describe, test, expect } from "vitest";
import { AnswerUnavailable, createStdinReceiver } from "./auth-subprocess-stdin.js";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

describe("createStdinReceiver", () => {
  test("resolves flowId from the init message and code from the code message", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "flow-1" }));
    stream.write(line({ type: "code", code: "abc123" }));
    await expect(receiver.flowId()).resolves.toBe("flow-1");
    await expect(receiver.receiveCode()).resolves.toBe("abc123");
  });

  test("resolves publicBaseUrl from the init message when set", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(
      line({ type: "init", flowId: "flow-pbu", publicBaseUrl: "https://gw.example.com:7600" }),
    );
    await expect(receiver.publicBaseUrl()).resolves.toBe("https://gw.example.com:7600");
  });

  test("publicBaseUrl resolves undefined when the init omits it", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "flow-no-pbu" }));
    await expect(receiver.publicBaseUrl()).resolves.toBeUndefined();
  });

  test("handles NDJSON frames split across chunk boundaries", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const framed =
      line({ type: "init", flowId: "flow-split" }) + line({ type: "code", code: "split-code" });
    // Drip-feed in 5-byte chunks so every frame straddles chunk boundaries.
    for (let i = 0; i < framed.length; i += 5) {
      stream.write(framed.slice(i, i + 5));
    }
    await expect(receiver.flowId()).resolves.toBe("flow-split");
    await expect(receiver.receiveCode()).resolves.toBe("split-code");
  });

  test("code arriving BEFORE receiveCode() is awaited resolves immediately", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "code", code: "early-bird" }));
    // Give the stream a tick to flush its data event.
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveCode()).resolves.toBe("early-bird");
  });

  test("code arriving AFTER receiveCode() is awaited resolves the pending promise", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveCode();
    stream.write(line({ type: "code", code: "late-bloomer" }));
    await expect(pending).resolves.toBe("late-bloomer");
  });

  test("duplicate code messages: first wins, duplicates ignored", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "code", code: "first-code" }));
    stream.write(line({ type: "code", code: "second-code" }));
    await expect(receiver.receiveCode()).resolves.toBe("first-code");
    // A second consumer also sees the first code.
    await expect(receiver.receiveCode()).resolves.toBe("first-code");
  });

  test("malformed lines are ignored; a later valid code still resolves", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveCode();
    stream.write("not-json-at-all}{\n");
    stream.write(line({ type: "code" })); // wrong shape — missing code field
    stream.write(line({ type: "unknown-type", code: "x" })); // unknown discriminator
    stream.write(line({ type: "code", code: "valid-after-noise" }));
    await expect(pending).resolves.toBe("valid-after-noise");
  });

  test("EOF while awaiting a code rejects", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveCode();
    stream.end();
    await expect(pending).rejects.toThrow(/closed before a code arrived/);
  });

  test("receiveCode() called after EOF rejects immediately", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.end();
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveCode()).rejects.toThrow(/closed before a code arrived/);
  });

  test("a code received before EOF survives the EOF", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "code", code: "kept" }));
    stream.end();
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveCode()).resolves.toBe("kept");
  });

  test("accountId resolves from an init message that carries one", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "flow-reauth", accountId: "maya@example.com" }));
    await expect(receiver.flowId()).resolves.toBe("flow-reauth");
    await expect(receiver.accountId()).resolves.toBe("maya@example.com");
  });

  test("accountId resolves undefined when the init message has none (first-time add)", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "flow-add" }));
    await expect(receiver.flowId()).resolves.toBe("flow-add");
    await expect(receiver.accountId()).resolves.toBeUndefined();
  });

  test("flowId resolves undefined after the init timeout", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream, { initTimeoutMs: 20 });
    await expect(receiver.flowId()).resolves.toBeUndefined();
  });

  test("accountId resolves undefined after the init timeout", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream, { initTimeoutMs: 20 });
    await expect(receiver.accountId()).resolves.toBeUndefined();
  });

  test("accountId resolves undefined on EOF without an init message", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.end();
    await expect(receiver.accountId()).resolves.toBeUndefined();
  });

  test("flowId resolves undefined on EOF without an init message", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.end();
    await expect(receiver.flowId()).resolves.toBeUndefined();
  });

  test("receiveCode rejects after the code timeout", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream, { codeTimeoutMs: 20 });
    await expect(receiver.receiveCode()).rejects.toThrow(/timed out/);
  });

  test("a trailing frame without newline is processed at EOF", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(JSON.stringify({ type: "init", flowId: "no-newline" })); // no trailing \n
    stream.end();
    await expect(receiver.flowId()).resolves.toBe("no-newline");
  });

  // ── widget-result channel (hosted-widget / link-widget) ──
  // Unlike `code` (first-wins latch), widget-results are a FIFO queue: one
  // session can deliver several, each consumed by one receiveWidgetResult().

  test("widget-result arriving BEFORE the await is buffered and resolves", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(
      line({ type: "widget-result", token: "public-1", metadata: { institution: "A" } }),
    );
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveWidgetResult()).resolves.toEqual({
      token: "public-1",
      metadata: { institution: "A" },
    });
  });

  test("widget-result arriving AFTER the await resolves the pending promise", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveWidgetResult();
    stream.write(line({ type: "widget-result", token: "public-late" }));
    await expect(pending).resolves.toEqual({ token: "public-late", metadata: undefined });
  });

  test("multiple widget-results are delivered FIFO, one per call", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "widget-result", token: "item-1" }));
    stream.write(line({ type: "widget-result", token: "item-2" }));
    stream.write(line({ type: "widget-result", token: "item-3" }));
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveWidgetResult()).resolves.toMatchObject({ token: "item-1" });
    await expect(receiver.receiveWidgetResult()).resolves.toMatchObject({ token: "item-2" });
    await expect(receiver.receiveWidgetResult()).resolves.toMatchObject({ token: "item-3" });
  });

  test("interleaved waiters and deliveries pair up in order", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const first = receiver.receiveWidgetResult();
    const second = receiver.receiveWidgetResult();
    stream.write(line({ type: "widget-result", token: "w-1" }));
    stream.write(line({ type: "widget-result", token: "w-2" }));
    await expect(first).resolves.toMatchObject({ token: "w-1" });
    await expect(second).resolves.toMatchObject({ token: "w-2" });
  });

  test("EOF while awaiting a widget-result rejects", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveWidgetResult();
    stream.end();
    await expect(pending).rejects.toThrow(/widget-result channel closed/);
  });

  test("receiveWidgetResult() called after EOF rejects immediately", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.end();
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveWidgetResult()).rejects.toThrow(/widget-result channel closed/);
  });

  test("a widget-result buffered before EOF survives the EOF", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "widget-result", token: "kept-widget" }));
    stream.end();
    await new Promise((r) => setImmediate(r));
    await expect(receiver.receiveWidgetResult()).resolves.toMatchObject({ token: "kept-widget" });
  });

  test("receiveWidgetResult rejects after the timeout", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream, { codeTimeoutMs: 20 });
    await expect(receiver.receiveWidgetResult()).rejects.toThrow(/timed out/);
  });
});

describe("credentials on the init line", () => {
  test("are surfaced to the provider", async () => {
    // Deliberately the stdin pipe, not argv: `/proc/<pid>/cmdline` is readable
    // by any local process.
    const receiver = createStdinReceiver(
      Readable.from([
        `${JSON.stringify({
          type: "init",
          flowId: "flow-1",
          credentials: { api_key: "gk_live_supersecret" },
        })}\n`,
      ]),
      { initTimeoutMs: 500 },
    );
    expect(await receiver.credentials()).toEqual({ api_key: "gk_live_supersecret" });
  });

  test("are undefined for a provider whose credential is shared across accounts", async () => {
    const receiver = createStdinReceiver(
      Readable.from([`${JSON.stringify({ type: "init", flowId: "flow-1" })}\n`]),
      { initTimeoutMs: 500 },
    );
    expect(await receiver.credentials()).toBeUndefined();
  });

  test("an unterminated line cannot grow without bound", async () => {
    const receiver = createStdinReceiver(Readable.from(["{".repeat(2_000_000)]), {
      initTimeoutMs: 200,
    });
    expect(await receiver.credentials()).toBeUndefined();
  });
});

describe("answers to typed challenges", () => {
  test("an answer resolves the wait it names", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));

    const pending = receiver.receiveAnswer("c1");
    stream.write(line({ type: "answer", id: "c1", answer: { token: "t" } }));

    await expect(pending).resolves.toEqual({ token: "t" });
  });

  test("an answer that arrives first is held, not dropped", async () => {
    // The provider emits the challenge and then awaits it, so an operator who
    // was already looking at the form can answer before the wait exists.
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));
    stream.write(line({ type: "answer", id: "c1", answer: { a: 1 } }));

    await expect(receiver.receiveAnswer("c1")).resolves.toEqual({ a: 1 });
  });

  test("two waits are resolved by the answers addressed to them, whatever the order", async () => {
    // The reason an answer carries an id: a flow can have asked twice, and the
    // second answer arriving first must not resolve the first question.
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));

    const first = receiver.receiveAnswer("c1");
    const second = receiver.receiveAnswer("c2");
    stream.write(line({ type: "answer", id: "c2", answer: { which: "second" } }));
    stream.write(line({ type: "answer", id: "c1", answer: { which: "first" } }));

    await expect(first).resolves.toEqual({ which: "first" });
    await expect(second).resolves.toEqual({ which: "second" });
  });

  test("an answer for a question nobody asked never resolves another one", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));
    stream.write(line({ type: "answer", id: "stray", answer: { a: 1 } }));

    const pending = receiver.receiveAnswer("c1");
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);

    stream.write(line({ type: "answer", id: "c1", answer: { a: 2 } }));
    await expect(pending).resolves.toEqual({ a: 2 });
  });

  test("a closed channel rejects a wait rather than hanging the flow", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));

    const pending = receiver.receiveAnswer("c1");
    stream.end();

    await expect(pending).rejects.toThrow(/answer channel closed/);
  });

  test("a wait started after the channel closed is rejected at once", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));
    stream.end();
    await new Promise((r) => setImmediate(r));

    await expect(receiver.receiveAnswer("c1")).rejects.toThrow(/answer channel closed/);
  });
});

describe("why a wait ended without an answer", () => {
  test("a torn-down channel says so, rather than leaving it to be read off the message", () => {
    // The caller has to choose a failure code, and the two reasons take
    // opposite ones: nobody came back in time is worth retrying, and the
    // channel closing under the wait is the operator having stopped. Deciding
    // that by matching the message text is the substring-matching the typed
    // vocabulary exists to remove — moving it from a consumer into a producer
    // would not have made it less of one.
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    const pending = receiver.receiveCode();
    stream.end();
    return expect(pending).rejects.toMatchObject({
      name: "AnswerUnavailable",
      reason: "closed",
    });
  });

  test("the same for a widget result and for a challenge answer", async () => {
    for (const wait of [
      (r: ReturnType<typeof createStdinReceiver>) => r.receiveWidgetResult(),
      (r: ReturnType<typeof createStdinReceiver>) => r.receiveAnswer("c1"),
    ]) {
      const stream = new PassThrough();
      const receiver = createStdinReceiver(stream);
      const pending = wait(receiver);
      stream.end();
      await expect(pending).rejects.toBeInstanceOf(AnswerUnavailable);
    }
  });
});

describe("what the client said it can draw", () => {
  test("arrives on the init line, and is absent when the client did not say", async () => {
    const withKinds = new PassThrough();
    const a = createStdinReceiver(withKinds);
    withKinds.write(line({ type: "init", flowId: "f", renders: ["code", "fields"] }));
    await expect(a.renders()).resolves.toEqual(["code", "fields"]);

    const silent = new PassThrough();
    const b = createStdinReceiver(silent);
    silent.write(line({ type: "init", flowId: "f" }));
    // Absent, not empty: the caller reads silence as the default set, and an
    // empty list would mean a client that can draw nothing at all.
    await expect(b.renders()).resolves.toBeUndefined();
  });
});

describe("a flow told it is over", () => {
  test("rejects every pending wait with the reason, so the provider can classify it", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));

    const code = receiver.receiveCode();
    const widget = receiver.receiveWidgetResult();
    const answer = receiver.receiveAnswer("c1");

    stream.write(line({ type: "abort", reason: "denied", detail: "Access was declined." }));

    // Someone was asked and said no. That is the opposite of a platform that
    // could not be reached, and until the flow could be told rather than
    // killed, a provider could not tell them apart — its catch never ran.
    for (const pending of [code, widget, answer]) {
      await expect(pending).rejects.toMatchObject({
        name: "AnswerUnavailable",
        reason: "denied",
        message: "Access was declined.",
      });
    }
  });

  test("a wait started afterwards refuses at once, rather than parking", async () => {
    // A provider's failure path may well ask again — that is what the grace
    // period before teardown is for. Without a latch that ask parks for the
    // full answer timeout on a channel nobody is going to write to, and the
    // three seconds it was given are spent waiting for ten minutes.
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));
    stream.write(line({ type: "abort", reason: "denied", detail: "Access was declined." }));
    await new Promise((r) => setImmediate(r));

    for (const pending of [
      receiver.receiveCode(),
      receiver.receiveWidgetResult(),
      receiver.receiveAnswer("c1"),
    ]) {
      await expect(pending).rejects.toMatchObject({ reason: "denied" });
    }
  });

  test("a cancellation is not a refusal", async () => {
    const stream = new PassThrough();
    const receiver = createStdinReceiver(stream);
    stream.write(line({ type: "init", flowId: "f" }));
    const pending = receiver.receiveCode();
    stream.write(line({ type: "abort", reason: "cancelled" }));
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
  });
});
