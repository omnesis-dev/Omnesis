// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough, Readable, Writable } from "node:stream";
import { expect, test, vi } from "vitest";
import { DesktopRestoreFailure } from "./restore-errors.js";
import { DesktopInteractionBroker, runDesktopProtocol } from "./protocol.js";

type Message = Record<string, unknown> & {
  id?: string;
  event?: string;
  interaction?: { id: string; kind: string };
  error?: { code: string };
};
function fixture(
  handle: Parameters<typeof runDesktopProtocol>[0]["handle"],
  onMessage?: (message: Message, input: PassThrough) => void,
) {
  const input = new PassThrough();
  const messages: Message[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as Message;
      messages.push(message);
      onMessage?.(message, input);
      callback();
    },
  });
  const run = runDesktopProtocol({ input, output, handle });
  return { input, messages, run };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function send(input: PassThrough, id: string, command: string, params?: unknown) {
  input.write(JSON.stringify({ id, command, ...(params === undefined ? {} : { params }) }) + "\n");
}

test("negotiates version one and refuses an unsupported native protocol", async () => {
  const handle = vi.fn(() => "ready");
  const f = fixture(handle, (message, input) => {
    if (message.id === "supported") input.end();
  });
  f.input.write(JSON.stringify({ version: 2, id: "unsupported", command: "status" }) + "\n");
  f.input.write(JSON.stringify({ version: 1, id: "supported", command: "status" }) + "\n");
  await f.run;
  expect(handle).toHaveBeenCalledTimes(1);
  expect(f.messages.every((message) => message.version === 1)).toBe(true);
  expect(f.messages[0]).toMatchObject({ ok: false });
  expect(f.messages[1]).toMatchObject({ id: "supported", ok: true, result: "ready" });
});

test("serializes lifecycle operations while responses finish active native prompts", async () => {
  const calls: string[] = [];
  let interactionId = "";
  const f = fixture(
    async (request, context) => {
      calls.push(request.id);
      if (request.command === "connect") {
        return context.interactions.ask(
          "compareCode",
          { code: "123 456" },
          (value) => {
            if (value !== "approve") throw new Error("fictional-private-value");
            return "approved";
          },
          context.signal,
        );
      }
      return "ready";
    },
    (message, input) => {
      if (message.event === "interaction") {
        interactionId = message.interaction!.id;
        send(input, "answer", "respond", { interactionId, value: "approve" });
      }
      if (message.id === "later") input.end();
    },
  );
  send(f.input, "join", "connect");
  send(f.input, "later", "status");
  await f.run;
  expect(calls).toEqual(["join", "later"]);
  expect(interactionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.messages).toContainEqual({ version: 1, id: "answer", ok: true, result: null });
  expect(f.messages).toContainEqual({ version: 1, id: "join", ok: true, result: "approved" });
});

test("invalid native response is sanitized and keeps the prompt open for a corrected answer", async () => {
  let interactionId = "";
  const f = fixture(
    async (_request, { interactions, signal }) =>
      interactions.ask(
        "chooseGateway",
        {},
        (value) => {
          if (value !== "home") throw new Error("fictional-private-error");
          return value;
        },
        signal,
      ),
    (message, input) => {
      if (message.event === "interaction") {
        interactionId = message.interaction!.id;
        send(input, "bad", "respond", { interactionId, value: "fictional-private-answer" });
      }
      if (message.id === "bad") send(input, "good", "respond", { interactionId, value: "home" });
      if (message.id === "connect") input.end();
    },
  );
  send(f.input, "connect", "connect");
  await f.run;
  expect(f.messages.find((m) => m.id === "bad")).toMatchObject({
    ok: false,
    error: { code: "INVALID_RESPONSE" },
  });
  expect(f.messages).toContainEqual({ version: 1, id: "connect", ok: true, result: "home" });
  expect(JSON.stringify(f.messages)).not.toContain("fictional-private");
});

test("cancellation bypasses blocked lifecycle work and rejects its pending interaction", async () => {
  const f = fixture(
    async (_request, { interactions, signal }) =>
      interactions.ask("openBrowser", {}, () => true, signal),
    (message, input) => {
      if (message.event === "interaction") send(input, "cancel", "cancel");
      if (message.id === "connect") input.end();
    },
  );
  send(f.input, "connect", "connect");
  await f.run;
  expect(f.messages).toContainEqual({ version: 1, id: "cancel", ok: true, result: null });
  expect(f.messages.find((m) => m.id === "connect")).toMatchObject({
    ok: false,
    error: { code: "CANCELLED" },
  });
});

test("malformed requests and duplicate IDs cannot execute work or echo unvalidated input", async () => {
  const handle = vi.fn(async () => "ready");
  const f = fixture(handle);
  f.input.write('{"fictional-private-input"\n');
  f.input.write(JSON.stringify({ id: "fictional-private-id", command: "unknown" }) + "\n");
  send(f.input, "same", "status");
  send(f.input, "same", "stop");
  f.input.end();
  await f.run;
  expect(handle).toHaveBeenCalledTimes(1);
  expect(f.messages.filter((m) => m.ok === false).map((m) => m.error!.code)).toEqual([
    "INVALID_JSON",
    "INVALID_REQUEST",
    "DUPLICATE_ID",
  ]);
  expect(JSON.stringify(f.messages)).not.toContain("fictional-private");
});

test("discards oversized frames without retaining their bytes and accepts the next frame", async () => {
  const f = fixture(() => "ready");
  f.input.write("x".repeat(600_000));
  f.input.write("y".repeat(600_000));
  f.input.write("\n");
  send(f.input, "status", "status");
  f.input.end();
  await f.run;
  expect(f.messages.find((m) => m.error?.code === "FRAME_TOO_LARGE")).toBeDefined();
  expect(f.messages).toContainEqual({ version: 1, id: "status", ok: true, result: "ready" });
});

test("bounds lifecycle admission while an operation is blocked", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handle = vi.fn(async () => {
    await blocked;
    return true;
  });
  const f = fixture(handle, (message, input) => {
    if (message.error?.code === "BUSY") {
      release();
    }
    if (message.id === "31") input.end();
  });
  for (let index = 0; index < 33; index++) send(f.input, String(index), "status");
  await f.run;
  expect(handle).toHaveBeenCalledTimes(32);
  expect(f.messages.find((m) => m.id === "32")).toMatchObject({
    ok: false,
    error: { code: "BUSY" },
  });
});

test("interaction broker bounds prompts and closes every waiter", async () => {
  const broker = new DesktopInteractionBroker(async () => {});
  const pending = Array.from({ length: 32 }, () =>
    broker.ask("compareCode", {}, () => true).catch((error: unknown) => error),
  );
  await expect(broker.ask("compareCode", {}, () => true)).rejects.toMatchObject({ code: "BUSY" });
  broker.close();
  expect(await Promise.all(pending)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "CANCELLED" })]),
  );
  await expect(broker.ask("compareCode", {}, () => true)).rejects.toMatchObject({
    code: "CANCELLED",
  });
});

test("stdout writes honor backpressure before sending the next response", async () => {
  const releases: (() => void)[] = [];
  const chunks: string[] = [];
  let first!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    first = resolve;
  });
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      releases.push(() => callback());
      first();
    },
  });
  const run = runDesktopProtocol({
    input: Readable.from([
      '{"id":"first","command":"status"}\n{"id":"second","command":"status"}\n',
    ]),
    output,
    handle: () => true,
  });
  await firstWrite;
  expect(chunks).toHaveLength(1);
  releases.shift()!();
  // The second write is observable through the writable event loop, without a timing sleep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(chunks).toHaveLength(2);
  releases.shift()!();
  await run;
});

test("handler exceptions and unsupported results produce content-free errors", async () => {
  const f = fixture(
    (request) => {
      if (request.id === "error") throw new Error("fictional-private-error");
      const result: Record<string, unknown> = {};
      result.self = result;
      return result;
    },
    (message, input) => {
      if (message.id === "circular") input.end();
    },
  );
  send(f.input, "error", "prepare");
  send(f.input, "circular", "status");
  await f.run;
  expect(f.messages.map((m) => m.error?.code)).toEqual(["OPERATION_FAILED", "INVALID_RESULT"]);
  expect(JSON.stringify(f.messages)).not.toContain("fictional-private");
});

test("EOF releases prompts that can no longer receive a native response", async () => {
  const f = fixture(
    async (_request, { interactions }) => interactions.ask("openBrowser", {}, () => true),
    (message, input) => {
      if (message.event === "interaction") input.end();
    },
  );
  send(f.input, "connect", "connect");
  await f.run;
  expect(f.messages.find((m) => m.id === "connect")).toMatchObject({
    ok: false,
    error: { code: "CANCELLED" },
  });
});

test("interaction payload cannot replace its routing identity", async () => {
  let actual: { id: string; kind: string } | undefined;
  const broker = new DesktopInteractionBroker(async ({ interaction }) => {
    actual = interaction;
  });
  const pending = broker.ask("compareCode", { id: "spoofed", kind: "spoofed" }, (value) => value);
  expect(actual?.kind).toBe("compareCode");
  expect(actual?.id).not.toBe("spoofed");
  broker.respond(actual!.id, "approve");
  expect(await pending).toBe("approve");
});

test("a failed stdout channel rejects without an unhandled stream error", async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("fictional-channel-failure"));
    },
  });
  await expect(
    runDesktopProtocol({
      input: Readable.from(['{"id":"status","command":"status"}\n']),
      output,
      handle: () => true,
    }),
  ).rejects.toThrow("fictional-channel-failure");
});

test("interaction cancellation removes its abort listener and never accepts a late response", async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  let id = "";
  const broker = new DesktopInteractionBroker(async ({ interaction }) => {
    id = interaction.id;
  });
  const pending = broker.ask("openBrowser", {}, () => true, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(() => broker.respond(id, "continue")).toThrow("no longer waiting");
});

test("EOF aborts active non-interactive work and prevents queued lifecycle mutations", async () => {
  const active = deferred<void>();
  const observed: string[] = [];
  const f = fixture(async (request, { signal }) => {
    observed.push(request.id);
    active.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled work")), { once: true }),
    );
  });
  send(f.input, "active", "connect");
  send(f.input, "queued", "prepare");
  await active.promise;
  f.input.end();
  await f.run;
  expect(observed).toEqual(["active"]);
  expect(f.messages.filter((message) => message.error?.code === "CANCELLED")).toHaveLength(2);
});

test("version-one removal commands preserve structured preview and result envelopes", async () => {
  const preview = {
    available: true,
    mode: "erase-data",
    confirmationId: "a".repeat(64),
    summary: "Fictional removal plan",
    dataKept: false,
    keyKept: false,
  };
  const removed = { status: "retired", data: "erased", keyring: "cleared" };
  const calls: string[] = [];
  const f = fixture(
    (request) => {
      calls.push(request.command);
      if (request.command === "removePreview") return preview;
      expect(request.params).toEqual({ eraseData: true, confirmationId: preview.confirmationId });
      return removed;
    },
    (message, input) => {
      if (message.id === "preview")
        send(input, "remove", "remove", {
          eraseData: true,
          confirmationId: preview.confirmationId,
        });
      if (message.id === "remove") input.end();
    },
  );
  send(f.input, "preview", "removePreview", { eraseData: true });
  await f.run;
  expect(calls).toEqual(["removePreview", "remove"]);
  expect(f.messages).toContainEqual({ version: 1, id: "preview", ok: true, result: preview });
  expect(f.messages).toContainEqual({ version: 1, id: "remove", ok: true, result: removed });
});

test("recovery command family preserves private structured replies", async () => {
  const commands = ["recoveryStatus", "recoveryPrepare", "recoveryCommit", "recoveryCancel"];
  const seen: string[] = [];
  const f = fixture(
    (request) => {
      seen.push(request.command);
      return { accepted: true };
    },
    (message, input) => {
      const next = commands[seen.length];
      if (next) send(input, next, next, {});
      else input.end();
    },
  );
  send(f.input, commands[0]!, commands[0]!, {});
  await f.run;
  expect(seen).toEqual(commands);
  expect(f.messages).toHaveLength(4);
  expect(f.messages.every((message) => message.ok === true)).toBe(true);
});

test("restore errors expose fixed guidance while refusing raw or forged exception text", async () => {
  const privateValue = "invented-private-recovery-code",
    errors = [
      new DesktopRestoreFailure("RESTORE_RECOVERY_REQUIRED"),
      Object.assign(new Error(privateValue), { code: "RESTORE_RECOVERY_REQUIRED" }),
    ];
  let attempt = 0;
  const f = fixture(
    () => {
      throw errors[attempt++]!;
    },
    (message, input) => {
      if (message.id === "first")
        send(input, "second", "restorePreview", { recoveryCode: privateValue });
      else input.end();
    },
  );
  send(f.input, "first", "restorePreview", { recoveryCode: privateValue });
  await f.run;
  expect(f.messages[0]).toMatchObject({ ok: false, error: { code: "RESTORE_RECOVERY_REQUIRED" } });
  expect(f.messages[1]).toMatchObject({ ok: false, error: { code: "OPERATION_FAILED" } });
  expect(JSON.stringify(f.messages)).not.toContain(privateValue);
});
