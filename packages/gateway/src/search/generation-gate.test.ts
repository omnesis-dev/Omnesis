// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { SearchGenerationGate } from "./generation-gate.js";

test("readers wait for asynchronous publication cleanup and snapshot refresh", async () => {
  const gate = new SearchGenerationGate();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let readerStarted = false;
  const publication = gate.publish(async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  const read = gate.read(async () => {
    readerStarted = true;
  });
  await Promise.resolve();
  expect(readerStarted).toBe(false);
  finish.resolve();
  await Promise.all([publication, read]);
  expect(readerStarted).toBe(true);
});

test("a publication drains old searches and queues new searches behind the new generation", async () => {
  const gate = new SearchGenerationGate();
  const old = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let generation = 1;
  const events: string[] = [];
  const search = gate.read(async () => {
    const model = generation;
    started.resolve();
    await old.promise;
    expect(generation).toBe(model);
    events.push("old query and candidates complete");
  });
  await started.promise;
  const publish = gate.publish(() => {
    events.push("publish and retire old model");
    generation = 2;
  });
  const next = gate.read(async () => {
    events.push(`search generation ${generation}`);
  });
  await Promise.resolve();
  expect(events).toEqual([]);
  old.resolve();
  await Promise.all([search, publish, next]);
  expect(events).toEqual([
    "old query and candidates complete",
    "publish and retire old model",
    "search generation 2",
  ]);
});

test("searches run concurrently and a rejected search releases its generation", async () => {
  const gate = new SearchGenerationGate();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const started: number[] = [];
  const a = gate.read(async () => {
    started.push(1);
    await first.promise;
    throw new Error("scripted search failure");
  });
  const rejected = expect(a).rejects.toThrow("scripted search failure");
  const b = gate.read(async () => {
    started.push(2);
    await second.promise;
  });
  await Promise.resolve();
  expect(started).toEqual([1, 2]);
  let published = false;
  const publication = gate.publish(() => {
    published = true;
  });
  first.resolve();
  await rejected;
  expect(published).toBe(false);
  second.resolve();
  await Promise.all([b, publication]);
  expect(published).toBe(true);
});

test("failed and overlapping publications preserve admission order without poisoning readers", async () => {
  const gate = new SearchGenerationGate();
  const events: string[] = [];
  const failed = gate.publish(() => {
    events.push("failed publication");
    throw new Error("scripted publication failure");
  });
  const rejected = expect(failed).rejects.toThrow("scripted publication failure");
  const read = gate.read(async () => {
    events.push("reader");
  });
  const second = gate.publish(() => {
    events.push("second publication");
  });
  await Promise.all([rejected, second, read]);
  expect(events).toEqual(["failed publication", "second publication", "reader"]);
});
