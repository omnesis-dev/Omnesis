// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { spawnOwnedChildProcess, type OwnedChildProcess } from "@omnesis/core";
import { PortableTailnetActor, TailnetActorFrames } from "./portable-tailnet-actor.js";

const PREFIX = "OMNESIS_TAILNET_FIXTURE ";
const roots: string[] = [];
const owners: OwnedChildProcess[] = [];
const actors: PortableTailnetActor[] = [];

afterEach(async () => {
  const joined = await Promise.allSettled(owners.splice(0).map((owner) => owner.stop()));
  await Promise.allSettled(actors.splice(0).map((actor) => actor.stop()));
  const failures = joined.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason as unknown),
      "Independent fixture join failed; inputs retained",
    );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("actor framing preserves split UTF-8 and ignores ordinary Go test output", () => {
  const frames: unknown[] = [],
    logs: string[] = [];
  const decoder = new TailnetActorFrames(
    (frame) => frames.push(frame),
    (line) => logs.push(line),
  );
  const bytes = Buffer.from(
    `=== RUN fixture\n${PREFIX}${JSON.stringify({ value: "雪" })}\r\nPASS\n`,
  );
  const split = bytes.indexOf(Buffer.from("雪")) + 1;
  decoder.write(bytes.subarray(0, split));
  expect(frames).toEqual([]);
  decoder.write(bytes.subarray(split));
  decoder.end();
  expect(frames).toEqual([{ value: "雪" }]);
  expect(logs).toEqual(["=== RUN fixture", "PASS"]);
});

test("each frame is bounded independently of a chunk containing many frames", () => {
  const frames: unknown[] = [];
  const decoder = new TailnetActorFrames(
    (frame) => frames.push(frame),
    () => {},
  );
  const value = "x".repeat(40_000);
  decoder.write(Buffer.from(`${PREFIX}${JSON.stringify({ value })}\n`.repeat(3)));
  decoder.end();
  expect(frames).toEqual([{ value }, { value }, { value }]);
});

test.each(["x".repeat(64 * 1024 + 1), `${PREFIX}{invalid}\n`])(
  "invalid actor output fails closed (%#)",
  (input) => {
    const decoder = new TailnetActorFrames(
      () => {},
      () => {},
    );
    expect(() => decoder.write(Buffer.from(input))).toThrow();
  },
);

test.each([Buffer.from("incomplete output"), Buffer.from([0xe9])])(
  "incomplete output never becomes EOF success (%#)",
  (input) => {
    const decoder = new TailnetActorFrames(
      () => {},
      () => {},
    );
    decoder.write(input);
    expect(() => decoder.end()).toThrow();
  },
);

async function actorFixture(
  bootstrap: unknown,
  marker?: Error,
  invalidTrailer = false,
): Promise<PortableTailnetActor> {
  const root = await mkdtemp(join(tmpdir(), "omnesis-tailnet actor literal-"));
  roots.push(root);
  const program = join(root, "actor.mjs");
  await writeFile(
    program,
    `
import { createInterface } from "node:readline";
const prefix = ${JSON.stringify(PREFIX)};
const trailer = ${JSON.stringify(`${PREFIX}{invalid}\n`)};
process.stdout.write(prefix + JSON.stringify(${JSON.stringify({ id: 0, value: bootstrap })}) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const value = request.op === "stop" ? true : { name: request.name };
  process.stdout.write(prefix + JSON.stringify({ id: request.id, value }) + "\\n" + (request.op === "stop" && ${invalidTrailer} ? trailer : ""), () => {
    if (request.op === "stop") process.exit(0);
  });
});
`,
  );
  const actor = new PortableTailnetActor("fixture-actor", root, root, root, {
    spawnActor: (_command, _args, options) => {
      const owner = spawnOwnedChildProcess(process.execPath, [program], options);
      owners.push(owner);
      if (!marker) return owner;
      const joined = owner.joined.then(() => {
        throw marker;
      });
      void joined.catch(() => {});
      return {
        child: owner.child,
        ready: owner.ready,
        joined,
        get joinedConfirmed() {
          return owner.joinedConfirmed;
        },
        stop: async () => {
          await owner.stop();
          throw marker;
        },
      };
    },
  });
  actors.push(actor);
  return actor;
}

test("the actor reads actual child replies and joins before fixture deletion", async () => {
  const actor = await actorFixture({ controlUrl: "http://127.0.0.1:32145" });
  expect(await actor.ready).toBe("http://127.0.0.1:32145");
  expect(await actor.request("machine", { name: "fixture-peer" })).toEqual({
    name: "fixture-peer",
  });
  await actor.stop();
  expect(owners[0]!.joinedConfirmed).toBe(true);
}, 30_000);

test.each([undefined, new Error("invented fixture join receipt")])(
  "an explicit cleanup receipt survives an independently joined child (%s)",
  async (failure) => {
    const marker = Object.assign(new Error("invented actor cleanup uncertainty"), {
      cleanupFailure: failure,
    });
    const actor = await actorFixture({ controlUrl: "http://127.0.0.1:32145" }, marker);
    await actor.ready;
    await expect(actor.stop()).rejects.toHaveProperty("cleanupFailure", failure);
    expect(owners[0]!.joinedConfirmed).toBe(true);
  },
  30_000,
);

test("bootstrap cannot point the actor owner outside loopback", async () => {
  const actor = await actorFixture({ controlUrl: "https://fixture.example.test" });
  await expect(actor.ready).rejects.toThrow("escaped loopback");
  await expect(actor.stop()).rejects.toThrow();
  expect(owners[0]!.joinedConfirmed).toBe(true);
}, 30_000);

test("a successful reply and exit zero cannot erase malformed trailing output", async () => {
  const actor = await actorFixture({ controlUrl: "http://127.0.0.1:32145" }, undefined, true);
  await actor.ready;
  await expect(actor.stop()).rejects.toThrow();
  expect(owners[0]!.joinedConfirmed).toBe(true);
}, 30_000);
