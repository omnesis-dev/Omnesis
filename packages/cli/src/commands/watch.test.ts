// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis watch`, at the layer where a verb becomes a request.
 *
 * Almost everything this command does is read and print, and printing is not
 * worth pinning. What is worth pinning is the mapping from a verb to what it
 * asks the gateway for — `pause` and `resume` are one call with a different
 * status, and swapping the pair is a live bug that no reader would notice and
 * nothing else would catch.
 *
 * The other case is the 404, which means two different things on this surface:
 * the gate hides the whole thing when the feature is off, and a route 404s an
 * id that does not exist. Only the first earns the hint.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, gw: vi.fn() };
});

import { gw, EXIT_USER_ERROR } from "../utils.js";
import {
  parseBindings,
  parseDuration,
  renderCrossWatchFiring,
  renderDifferences,
  watchJudgeNeedsAttention,
  watchCommand,
} from "./watch.js";

function command(name: string) {
  const commands = watchCommand.subCommands as Record<
    string,
    { run: (context: { args: Record<string, unknown> }) => Promise<void> }
  >;
  return commands[name]!;
}

/** A gateway that answers every call with one body. */
function answering(body: unknown, status = 200): void {
  (gw as Mock).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const WATCH = {
  id: "w-1",
  name: "every-email",
  status: "paused",
  addedAt: "2026-03-01T09:00:00Z",
  fromSeq: 12,
  note: null,
  firings: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const STORED = {
  id: "w-1",
  name: "every-email",
  status: "active" as const,
  addedAt: "2026-03-01T09:00:00Z",
  fromSeq: 12,
  note: null,
  dsl: {
    watch: {
      name: "every-email",
      firing_policy: "stays_active",
      ontology_fingerprint: "abc123",
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          recall: { semantic: { query: "a question", threshold: 0.35 } },
        },
      ],
      sink: { input: "mail" },
    },
  },
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function watchReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    journalHead: 0,
    journalEvents: 0,
    judge: { loadable: false, calls: 0, deferrals: 0, errors: 0 },
    health: null,
    delivery: null,
    evaluation: { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    ontology: null,
    watches: [],
    ...overrides,
  };
}

describe("reporting Watch judge readiness", () => {
  test("warns before an active semantic Watch has any nominations", () => {
    expect(
      watchJudgeNeedsAttention(
        watchReport({
          watches: [
            {
              name: "fictional semantic watch",
              status: "active",
              note: null,
              judgeRequired: true,
              firings: 0,
              traceRecords: 0,
              judge: { calls: 0, deferrals: 0 },
              pendingNominations: 0,
              failure: null,
              delivery: null,
              attemptedToday: 0,
            },
          ],
        }) as never,
      ),
    ).toBe(true);
  });

  test("does not warn when no active Watch needs a judge or an older gateway omits readiness", () => {
    expect(watchJudgeNeedsAttention(watchReport() as never)).toBe(false);
    expect(
      watchJudgeNeedsAttention(
        watchReport({ judge: { calls: 0, deferrals: 0, errors: 0 } }) as never,
      ),
    ).toBe(false);
  });
});

function writeLocal(dsl: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-show-"));
  scratch.push(dir);
  const path = join(dir, "local.json");
  writeFileSync(path, JSON.stringify(dsl, null, 2));
  return path;
}

/** What the command wrote, parsed. The suite runs in --json mode. */
async function captured(
  run: () => Promise<void>,
): Promise<{ differences: { path: string; stored?: string; local?: string }[] }> {
  const lines: string[] = [];
  (console.log as unknown as Mock).mockImplementation((s: string) => lines.push(String(s)));
  await run();
  return JSON.parse(lines.join("\n")) as {
    differences: { path: string; stored?: string; local?: string }[];
  };
}

describe("the verbs it offers", () => {
  test("read the runtime, and change only what a watch is", () => {
    // `try` is the one verb that takes a candidate rather than a stored watch:
    // it replays it over the recent journal and reports what it would have
    // decided, before there is a watch to name. `probe` reads the corpus
    // rather than the runtime, and returns counts and
    // scores — never documents. `deliver` turns a watch's delivery block on or
    // off, which is what the runtime then honours on its own. `fire` is the one
    // verb that makes something happen now: it runs the delivery path over a
    // firing the operator asked for, so a path that is broken can be found out
    // about before the day it was needed. Nothing here retries or acknowledges
    // a firing — a firing is a row, and a verb claiming otherwise would be a
    // promise the runtime cannot keep.
    expect(Object.keys(watchCommand.subCommands ?? {})).toEqual([
      "list",
      "add",
      "rm",
      "show",
      "restamp",
      "pause",
      "resume",
      "try",
      "probe",
      "deliver",
      "fire",
      "firings",
      "trace",
      "judge",
      "report",
    ]);
  });
});

describe("saying where a watch's firings go", () => {
  test("wakes the named agent with the operator's own instruction", async () => {
    // The two halves of a wake, and they come from different places: the watch
    // decides *when*, deterministically, and this sentence decides *what*. A
    // request that dropped either would install a watch that fires into nothing.
    answering({ watch: { ...WATCH, name: "an-order-shipped" } });
    await command("deliver").run({
      args: {
        id: "an-order-shipped",
        to: "agent-wake",
        integration: "openclaw",
        instruction: "Draft a reply and leave it in my drafts.",
      },
    });

    const [path, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/admin/watch/watches/an-order-shipped/delivery");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "Draft a reply and leave it in my drafts.",
    });
  });

  test("refuses a wake with nobody to wake, before asking the gateway", async () => {
    // Named here rather than at the route, so the message says which flag is
    // missing instead of which field the body wanted.
    answering({ watch: WATCH });
    await expect(
      command("deliver").run({ args: { id: "w-1", to: "agent-wake", instruction: "Reply." } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(gw as Mock, "a wake with no integration reached the gateway").not.toHaveBeenCalled();
  });

  test("refuses a wake with nothing to say", async () => {
    answering({ watch: WATCH });
    await expect(
      command("deliver").run({ args: { id: "w-1", to: "agent-wake", integration: "openclaw" } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(gw as Mock).not.toHaveBeenCalled();
  });

  test("notifies by default, under the name the DSL uses now", async () => {
    answering({ watch: WATCH });
    await command("deliver").run({ args: { id: "w-1", to: "omnesis-notify" } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: "omnesis-notify" });
  });

  test("still takes the old spelling, and asks the gateway in the new one", async () => {
    // An operator has `--to ios-push` in an alias or a note. Breaking that to
    // rename a value they never chose would be a poor trade — and normalising
    // it here means everything downstream of the flag speaks one vocabulary.
    answering({ watch: WATCH });
    await command("deliver").run({ args: { id: "w-1", to: "ios-push" } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: "omnesis-notify" });
  });

  test("refuses a destination it does not know, before asking the gateway", async () => {
    answering({ watch: WATCH });
    await expect(
      command("deliver").run({ args: { id: "w-1", to: "email" } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(gw as Mock).not.toHaveBeenCalled();
  });

  test("stopping delivery sends a null kind, not an absent one", async () => {
    // An absent `kind` is a malformed body the route refuses; null is the way
    // to say "nowhere". The two look alike and behave nothing alike.
    answering({ watch: WATCH });
    await command("deliver").run({ args: { id: "w-1", to: "none" } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ kind: null });
  });

  test("carries the referents the instruction names", async () => {
    // The half prose cannot supply. "Reply in the thread this came from" names
    // something the woken agent has no way to resolve; a binding is how the
    // watch hands it over.
    answering({ watch: { ...WATCH, name: "an-order-shipped" } });
    await command("deliver").run({
      args: {
        id: "an-order-shipped",
        to: "agent-wake",
        integration: "openclaw",
        instruction: "Reply in the thread this came from.",
        binding: ["thread=thread-4821", "channel=order-updates"],
      },
    });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "agent-wake",
      integration: "openclaw",
      instruction: "Reply in the thread this came from.",
      bindings: { thread: "thread-4821", channel: "order-updates" },
    });
  });

  test("takes a single --binding as well as several", async () => {
    answering({ watch: WATCH });
    await command("deliver").run({
      args: {
        id: "w-1",
        to: "agent-wake",
        integration: "openclaw",
        instruction: "File it.",
        binding: "folder=Invoices",
      },
    });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).bindings).toEqual({ folder: "Invoices" });
  });

  test("omits bindings entirely when none were given", async () => {
    // An empty map and no map must reach the gateway as the same wake, or the
    // anchor a wake reconciles against churns on a flag nobody passed.
    answering({ watch: WATCH });
    await command("deliver").run({
      args: { id: "w-1", to: "agent-wake", integration: "openclaw", instruction: "Reply." },
    });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(Object.keys(JSON.parse(String(init.body)))).not.toContain("bindings");
  });

  test("refuses a binding that is not a pair, naming the flag", async () => {
    answering({ watch: WATCH });
    for (const bad of ["thread", "=thread-4821", "thread="]) {
      await expect(
        command("deliver").run({
          args: {
            id: "w-1",
            to: "agent-wake",
            integration: "openclaw",
            instruction: "Reply.",
            binding: bad,
          },
        }),
      ).rejects.toThrow(/--binding/);
    }
    expect(gw as Mock, "a malformed binding reached the gateway").not.toHaveBeenCalled();
  });

  test("refuses a binding on a delivery that has nothing to resolve it", async () => {
    answering({ watch: WATCH });
    await expect(
      command("deliver").run({
        args: { id: "w-1", to: "omnesis-notify", binding: "thread=thread-4821" },
      }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(gw as Mock).not.toHaveBeenCalled();
  });
});

describe("binding pairs", () => {
  test("splits on the first = only, so a value may contain one", () => {
    expect(parseBindings("link=https://example.com/a?b=c")).toEqual({
      link: "https://example.com/a?b=c",
    });
  });

  test("refuses a key given twice rather than keeping the last one", () => {
    // A silent overwrite loses one of two things the operator asked for and
    // says nothing about which.
    expect(() => parseBindings(["thread=a", "thread=b"])).toThrow(/twice/);
  });

  test("holds the same limits the gateway will apply", () => {
    expect(() => parseBindings(`${"k".repeat(65)}=v`)).toThrow(/64/);
    expect(() => parseBindings(`k=${"v".repeat(513)}`)).toThrow(/512/);
    expect(() => parseBindings(Array.from({ length: 33 }, (_, i) => `key${i}=value${i}`))).toThrow(
      /32/,
    );
    // The boundary itself is allowed — an off-by-one here refuses a pair the
    // gateway would have taken.
    expect(
      Object.keys(parseBindings(Array.from({ length: 32 }, (_, i) => `key${i}=v`))),
    ).toHaveLength(32);
  });

  test("no flag is an empty map, not an error", () => {
    expect(parseBindings(undefined)).toEqual({});
  });
});

describe("firing a watch by hand", () => {
  test("asks the gateway to fire it, and says where it went", async () => {
    answering({
      watch: { id: "w-1", name: "an-order-shipped" },
      seq: -1,
      delivered: 1,
      suppressed: 0,
    });

    await command("fire").run({ args: { id: "an-order-shipped" } });

    const [path, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/admin/watch/watches/an-order-shipped/fire");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  test("carries the documents the firing is about", async () => {
    // The one input with reach: a woken agent may be answered from these.
    answering({ watch: { name: "an-order-shipped" }, seq: -2, delivered: 1, suppressed: 0 });

    await command("fire").run({ args: { id: "w-1", doc: ["d1", "d2"] } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ documentIds: ["d1", "d2"] });
  });

  test("sends the payload as JSON, and refuses one that is not", async () => {
    answering({ watch: { name: "an-order-shipped" }, seq: -4, delivered: 1, suppressed: 0 });
    await command("fire").run({ args: { id: "w-1", payload: '{"note":"checking"}' } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ payload: { note: "checking" } });

    await expect(
      command("fire").run({ args: { id: "w-1", payload: "not json" } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    await expect(
      command("fire").run({ args: { id: "w-1", payload: "[1,2]" } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
  });

  test("takes a single --doc as well as several", async () => {
    // citty hands over one value for a flag passed once and an array for a
    // flag passed twice; the operator wrote the same thing either way.
    answering({ watch: { name: "an-order-shipped" }, seq: -3, delivered: 1, suppressed: 0 });

    await command("fire").run({ args: { id: "w-1", doc: "d1" } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ documentIds: ["d1"] });
  });
});

describe("holding and resuming", () => {
  test("pause asks for paused", async () => {
    answering({ watch: { ...WATCH, status: "paused" } });
    await command("pause").run({ args: { id: "w-1" } });

    const [path, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/admin/watch/watches/w-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ status: "paused" });
  });

  test("resume asks for active", async () => {
    // The pair swapped is a bug that reads correctly at every call site.
    answering({ watch: { ...WATCH, status: "active" } });
    await command("resume").run({ args: { id: "w-1" } });

    const [, init] = (gw as Mock).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ status: "active" });
  });

  test("escapes an id that would otherwise change the path", async () => {
    answering({ watch: WATCH });
    await command("pause").run({ args: { id: "a/b?c" } });
    const [path] = (gw as Mock).mock.calls[0] as [string];
    expect(path).toBe("/admin/watch/watches/a%2Fb%3Fc");
  });
});

describe("adding a watch", () => {
  test("refuses a --from-seq that is not a whole number", async () => {
    // Caught here rather than at the gateway, because the message a person
    // needs is about the flag they typed.
    for (const fromSeq of ["-1", "1.5", "abc"]) {
      await expect(
        command("add").run({ args: { file: "/nonexistent", "from-seq": fromSeq } }),
      ).rejects.toThrow();
    }
  });
});

describe("what a 404 means", () => {
  test("on the collection, that the feature is off", async () => {
    answering({ error: "Not found" }, 404);
    await expect(command("list").run({ args: {} })).rejects.toThrow(/OMNESIS_EXPERIMENTAL/);
  });

  test("on one watch, that the id is wrong — no hint about a feature already on", async () => {
    answering({ error: "no such watch" }, 404);
    await expect(command("trace").run({ args: { id: "nope" } })).rejects.toThrow(/no such watch/);
  });
});

describe("reading a watch's spec", () => {
  test("prints the stored spec rather than a local file", async () => {
    // The store is the authority: once a compiler writes watches there is no
    // local file, and when there is one it may have drifted.
    answering({ watch: STORED });
    const lines: string[] = [];
    (console.log as unknown as Mock).mockImplementation((s: string) => lines.push(String(s)));
    await command("show").run({ args: { id: "w-1" } });

    const [path] = (gw as Mock).mock.calls[0] as [string];
    expect(path).toBe("/admin/watch/watches/w-1");
    // A value that exists only inside the DSL, so this cannot pass by matching
    // a name that also sits on the envelope.
    const printed = JSON.parse(lines.join("\n")) as {
      dsl: { watch: { nodes: { recall: { semantic: { threshold: number } } }[] } };
    };
    expect(printed.dsl.watch.nodes[0]!.recall.semantic.threshold).toBe(0.35);
  });

  test("reports identical when the file matches, whatever its key order", async () => {
    // The two sides have been through a database and two serializers. Key
    // order and whitespace differ constantly and mean nothing; treating them
    // as differences would make the affordance useless on its first run.
    answering({ watch: STORED });
    const reordered = {
      watch: {
        sink: { input: "mail" },
        nodes: [
          {
            filter: { documentType: "email", source: "gmail", event: ["created"] },
            recall: { semantic: { threshold: 0.35, query: "a question" } },
            type: "source.document_event",
            id: "mail",
          },
        ],
        ontology_fingerprint: "abc123",
        firing_policy: "stays_active",
        name: "every-email",
      },
    };
    const out = await captured(() =>
      command("show").run({ args: { id: "w-1", diff: writeLocal(reordered) } }),
    );
    expect(out.differences, "a reordering was reported as a difference").toEqual([]);
    // The local file never leaves the machine: reading it is the whole point,
    // and the only request this command makes is the GET that fetched the spec.
    expect((gw as Mock).mock.calls, "--diff made more than one request").toHaveLength(1);
    expect(gw).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("names the path of a value that genuinely moved", async () => {
    // The case the affordance exists for, and the one a line diff loses: a
    // single changed scalar deep in the tree.
    answering({ watch: STORED });
    const drifted = JSON.parse(JSON.stringify(STORED.dsl)) as typeof STORED.dsl;
    (
      drifted.watch.nodes[0] as { recall: { semantic: { threshold: number } } }
    ).recall.semantic.threshold = 0.5;
    const out = await captured(() =>
      command("show").run({ args: { id: "w-1", diff: writeLocal(drifted) } }),
    );
    expect(out.differences, "a changed threshold was reported as identical").toHaveLength(1);
    expect(out.differences[0].path).toBe("/watch/nodes/0/recall/semantic/threshold");
    expect(out.differences[0].stored).toBe("0.35");
    expect(out.differences[0].local).toBe("0.5");
  });

  test("names a clause the file dropped", async () => {
    // An absent leaf is a difference, not a match. A comparison that only
    // walked the file's own keys would call a deleted filter identical.
    answering({ watch: STORED });
    const missing = JSON.parse(JSON.stringify(STORED.dsl)) as {
      watch: { nodes: { recall?: unknown }[] };
    };
    delete missing.watch.nodes[0]!.recall;
    const out = await captured(() =>
      command("show").run({ args: { id: "w-1", diff: writeLocal(missing) } }),
    );
    // The full list, in order — the sort is deliberate so a listing reads
    // top-down through the spec rather than in walk order.
    expect(out.differences.map((d) => d.path)).toEqual([
      "/watch/nodes/0/recall/semantic/query",
      "/watch/nodes/0/recall/semantic/threshold",
    ]);
    expect(out.differences.every((d) => d.local === undefined)).toBe(true);
  });

  test("refuses a diff file it cannot read", async () => {
    answering({ watch: STORED });
    await expect(
      command("show").run({ args: { id: "w-1", diff: "/nonexistent/watch.json" } }),
    ).rejects.toThrow(/Could not read/);
    // A user error, not a crash — anything scripting the CLI reads the code.
    await command("show")
      .run({ args: { id: "w-1", diff: "/nonexistent/watch.json" } })
      .catch((err: unknown) => {
        expect((err as { exitCode?: number }).exitCode).toBe(EXIT_USER_ERROR);
      });
  });

  test("does not hint about experimental mode on a 404", async () => {
    // A 404 here means the id is wrong, not that the feature is off.
    answering({ error: "no such watch" }, 404);
    await expect(command("show").run({ args: { id: "nope" } })).rejects.toThrow(/no such watch/);
  });
});

describe("what a path can and cannot hide", () => {
  /**
   * The one answer this command must never give is a false "identical" — it
   * tells an operator their file matches what is running when it does not.
   *
   * The stored side is validated against a strict schema and could not carry
   * either of these shapes. The local side is a file the command was handed and
   * never validates, and a file that is not a valid spec is exactly the case an
   * operator reaches for this to find out about.
   */
  function diffOf(stored: unknown, local: unknown) {
    answering({ watch: { ...STORED, dsl: stored } });
    return captured(() => command("show").run({ args: { id: "w-1", diff: writeLocal(local) } }));
  }

  test("a key containing the separator is not nesting", async () => {
    const out = await diffOf(
      { watch: { sink: { input: "mail" } } },
      { "watch/sink/input": "mail" },
    );
    expect(out.differences, "a flattened key read as identical to real nesting").not.toEqual([]);
  });

  test("an object keyed by digits is not an array", async () => {
    const out = await diffOf({ a: { "0": "x" } }, { a: ["x"] });
    expect(out.differences, "an object read as identical to an array").not.toEqual([]);
  });

  test("an empty container that the file dropped is a difference", async () => {
    // `filter: {}` and `event: []` are ordinary in this DSL, and a walk that
    // recorded nothing for an empty container would call their removal a match.
    const out = await diffOf({ watch: { filter: {}, event: [] } }, { watch: {} });
    // Three, not two: `/watch` is a leaf on the local side (it is empty there)
    // and a container on the stored side, which is itself a difference worth
    // reporting rather than an artefact.
    expect(out.differences.map((d) => d.path)).toEqual(["/watch", "/watch/event", "/watch/filter"]);
    const byPath = new Map(out.differences.map((d) => [d.path, d]));
    expect(byPath.get("/watch/event")?.stored).toBe("[]");
    expect(byPath.get("/watch/filter")?.stored).toBe("{}");
    expect(byPath.get("/watch")?.local).toBe("{}");
  });

  test("a value of a different type is a difference, however it prints", async () => {
    const out = await diffOf({ a: 1, b: true, c: null }, { a: "1", b: "true", c: "null" });
    expect(out.differences.map((d) => d.path)).toEqual(["/a", "/b", "/c"]);
  });

  test("array order is meaning", async () => {
    // A sequence gate's `order` is the case that makes this load-bearing.
    const out = await diffOf({ order: ["a", "b"] }, { order: ["b", "a"] });
    expect(out.differences.map((d) => d.path)).toEqual(["/order/0", "/order/1"]);
  });

  test("escapes an id that would otherwise change the path", async () => {
    answering({ watch: STORED });
    await command("show").run({ args: { id: "a/b?c" } });
    expect((gw as Mock).mock.calls[0]![0]).toBe("/admin/watch/watches/a%2Fb%3Fc");
  });
});

describe("the difference listing a person reads", () => {
  // The command runs in JSON mode almost everywhere it is exercised, so the
  // prose is rendered by a pure function and checked here directly rather than
  // going unexecuted.
  test("says identical when there is nothing to report", () => {
    expect(renderDifferences([], "every-email", "local.json").join("\n")).toContain("identical");

    // One difference is the common case when a file has drifted by a single
    // edit, and it is the case a naive count line gets wrong.
    const one = renderDifferences(
      [{ path: "/watch/nodes/0/window", stored: '"7d"', local: '"14d"' }],
      "every-email",
      "local.json",
    ).join("\n");
    expect(one).toContain("1 difference");
    expect(one).not.toContain("difference(s)");
    expect(one).not.toContain("1 differences");
  });

  test("names each path with both sides, and marks an absent one", () => {
    const out = renderDifferences(
      [
        { path: "/watch/nodes/0/recall/semantic/threshold", stored: "0.35", local: "0.5" },
        { path: "/watch/nodes/0/recall/semantic/query", stored: '"a question"' },
      ],
      "every-email",
      "local.json",
    ).join("\n");
    expect(out).toContain("2 differences");
    expect(out).toContain("/watch/nodes/0/recall/semantic/threshold");
    expect(out).toContain("0.35");
    expect(out).toContain("0.5");
    expect(out, "a leaf missing from the file was not marked absent").toContain("(absent)");
  });
});

/**
 * The routes are keyed by id; every listing an operator reads is keyed by name.
 *
 * So a name is what someone has to hand when they go to act on a watch, and it
 * used to earn a bare `404 no such watch` — which reads as "it is gone" rather
 * than "wrong kind of identifier". The failure worth pinning is not the 404
 * itself but what reads it: a script that treats one as "not installed" reports
 * a live watch as absent, and says so with a straight face.
 */
describe("naming the watch to act on", () => {
  /** Responses in order, one per `gw` call. */
  function answeringInTurn(...responses: { status: number; body: unknown }[]): void {
    const mock = gw as Mock;
    for (const { status, body } of responses) {
      mock.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }
  }

  test("takes an id straight to the route, with no lookup", async () => {
    // The id is the identity. Spending a round trip to confirm it — or deciding
    // by the shape of the string which kind of thing it is — would make the
    // unambiguous form the slow one, and couple this to a format the gateway
    // has never promised.
    answeringInTurn({ status: 200, body: { watch: "every-email", firings: [] } });
    await command("firings").run({ args: { id: "w-1" } });

    expect((gw as Mock).mock.calls).toHaveLength(1);
    expect((gw as Mock).mock.calls[0]?.[0]).toBe("/admin/watch/watches/w-1/firings");
  });

  test("falls back to the listing when the id misses, and retries with the id it finds", async () => {
    answeringInTurn(
      { status: 404, body: { error: "no such watch" } },
      { status: 200, body: { watches: [WATCH], journalHead: 0 } },
      { status: 200, body: { watch: "every-email", firings: [] } },
    );
    await command("firings").run({ args: { id: "every-email" } });

    const calls = (gw as Mock).mock.calls.map((call) => call[0] as string);
    expect(calls).toEqual([
      "/admin/watch/watches/every-email/firings",
      "/admin/watch/watches",
      "/admin/watch/watches/w-1/firings",
    ]);
  });

  test("carries the method through to the retry", async () => {
    // `rm` and `pause` resolve the same way as a read does, and a retry that
    // dropped the method would GET the watch and report success without
    // removing anything.
    answeringInTurn(
      { status: 404, body: { error: "no such watch" } },
      { status: 200, body: { watches: [WATCH], journalHead: 0 } },
      { status: 200, body: {} },
    );
    await command("rm").run({ args: { id: "every-email" } });

    const retry = (gw as Mock).mock.calls[2];
    expect(retry?.[0]).toBe("/admin/watch/watches/w-1");
    expect((retry?.[1] as RequestInit).method).toBe("DELETE");
  });

  test("keeps the route's own 404 when the name is not there either", async () => {
    answeringInTurn(
      { status: 404, body: { error: "no such watch" } },
      { status: 200, body: { watches: [WATCH], journalHead: 0 } },
    );
    await expect(command("trace").run({ args: { id: "no-such-watch" } })).rejects.toThrow(
      /no such watch/,
    );
  });

  test("refuses an ambiguous name instead of picking one", async () => {
    // Names are not unique. Resolving to whichever the listing returned first
    // would remove, pause or resume a watch the operator did not mean.
    answeringInTurn(
      { status: 404, body: { error: "no such watch" } },
      {
        status: 200,
        body: { watches: [WATCH, { ...WATCH, id: "w-2", status: "active" }], journalHead: 0 },
      },
    );
    const failure = await command("rm")
      .run({ args: { id: "every-email" } })
      .then(() => undefined)
      .catch((err: unknown) => err as Error);

    expect(failure).toMatchObject({ exitCode: EXIT_USER_ERROR });
    expect(failure?.message).toContain("w-1");
    expect(failure?.message).toContain("w-2");
    // Nothing was removed: the ambiguity was settled before any second call.
    expect((gw as Mock).mock.calls).toHaveLength(2);
  });

  test("leaves the gate's 404 alone when the whole surface is off", async () => {
    // With experimental mode off every route 404s, the listing included. Reading
    // that as "the name was not found" would tell the operator to check their
    // spelling when the feature is simply not running.
    answeringInTurn(
      { status: 404, body: { error: "not found" } },
      { status: 404, body: { error: "not found" } },
    );
    await expect(command("firings").run({ args: { id: "every-email" } })).rejects.toThrow(/404/);
  });

  test("resolves for every verb that acts on one watch", async () => {
    for (const verb of ["rm", "show", "pause", "resume", "firings", "trace"] as const) {
      vi.clearAllMocks();
      answeringInTurn(
        { status: 404, body: { error: "no such watch" } },
        { status: 200, body: { watches: [WATCH], journalHead: 0 } },
        { status: 200, body: { watch: STORED, firings: [], records: [] } },
      );
      await command(verb).run({ args: { id: "every-email" } });
      expect(
        (gw as Mock).mock.calls[2]?.[0],
        `${verb} did not resolve the name it was given`,
      ).toContain("/admin/watch/watches/w-1");
    }
  });
});

/**
 * Whether a firing caused anything.
 *
 * A firing wakes a workflow; the workflow may notify someone, file something,
 * or correctly do nothing. An audit needs both halves on one row — that the
 * wake was accepted, and what the run made of it — and it needs them across
 * every watch at once, since "did anything fire last night" names no watch to
 * ask about. These cases hold the request that view makes: the cross-watch
 * route, the window it asks for, and the flags that keep it one view rather
 * than two. The line it prints is checked below.
 */
describe("every watch's firings at once", () => {
  test("asks the cross-watch route with a window, defaulting to a day", async () => {
    const now = Date.parse("2026-08-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    answering({ firings: [] });
    await command("firings").run({ args: { all: true } });

    const [path] = (gw as Mock).mock.calls[0] as [string];
    const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
    expect(path.startsWith("/admin/watch/firings?")).toBe(true);
    expect(Number(query.get("since"))).toBe(now - 86_400_000);
    expect(query.get("limit")).toBeNull();
  });

  test("takes the window the operator asked for, in any of its units", async () => {
    const now = Date.parse("2026-08-21T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    for (const [since, ms] of [
      ["90m", 90 * 60_000],
      ["7d", 7 * 86_400_000],
      ["12h", 12 * 3_600_000],
    ] as const) {
      vi.clearAllMocks();
      answering({ firings: [] });
      await command("firings").run({ args: { all: true, since } });
      const [path] = (gw as Mock).mock.calls[0] as [string];
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      expect(Number(query.get("since")), `--since ${since}`).toBe(now - ms);
    }
  });

  test("refuses a window it cannot read, naming the flag", async () => {
    answering({ firings: [] });
    for (const since of ["yesterday", "24", "h", "0h", "-3d"]) {
      await expect(command("firings").run({ args: { all: true, since } })).rejects.toThrow(
        /--since/,
      );
    }
    expect(gw as Mock).not.toHaveBeenCalled();
  });

  test("carries --limit through, and refuses one that is not a count", async () => {
    answering({ firings: [] });
    await command("firings").run({ args: { all: true, limit: "50" } });
    const [path] = (gw as Mock).mock.calls[0] as [string];
    expect(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("limit")).toBe("50");

    await expect(command("firings").run({ args: { all: true, limit: "lots" } })).rejects.toThrow(
      /--limit/,
    );
  });

  test("refuses a watch name alongside --all, and a window without it", async () => {
    // Both are the operator asking for two different views at once. Answering
    // one of them silently would hand back a page they did not ask for.
    answering({ firings: [] });
    await expect(
      command("firings").run({ args: { all: true, id: "every-email" } }),
    ).rejects.toMatchObject({ exitCode: EXIT_USER_ERROR });
    await expect(
      command("firings").run({ args: { id: "every-email", since: "7d" } }),
    ).rejects.toThrow(/--since applies to --all/);
    await expect(command("firings").run({ args: {} })).rejects.toThrow(/--all/);
    expect(gw as Mock).not.toHaveBeenCalled();
  });

  test("a 404 on the collection means the runtime is off, not a mistyped id", async () => {
    // There is no id on this route to mistype, so the other reading of a 404 is
    // not available — and the hint is the only actionable thing about it.
    answering({ error: "Not found" }, 404);
    await expect(command("firings").run({ args: { all: true } })).rejects.toThrow(
      /OMNESIS_EXPERIMENTAL/,
    );
  });

  test("--json passes the payload through unchanged", async () => {
    // A machine reader gets the gateway's answer, not this command's reading of
    // it. Fields a newer gateway added survive; prose never appears.
    const body = {
      firings: [
        {
          watchId: "w-9",
          watchName: "a-parcel-is-late",
          seq: 41,
          firedAt: "2026-08-20T22:14:00Z",
          somethingNewer: { kept: true },
        },
      ],
    };
    answering(body);
    const lines: string[] = [];
    (console.log as unknown as Mock).mockImplementation((s: string) => lines.push(String(s)));
    await command("firings").run({ args: { all: true } });
    expect(JSON.parse(lines.join("\n"))).toEqual(body);
  });
});

describe("the cross-watch firing line", () => {
  // Rendered by a pure function and checked here, because the suite runs in
  // --json mode and prose nobody executes is prose nobody has checked.
  const BASE = {
    watchId: "w-9",
    watchName: "a-parcel-is-late",
    seq: 41,
    firedAt: "2026-08-20T22:14:00Z",
  };

  test("says when, which watch, whether it was delivered, and what came back", () => {
    const line = renderCrossWatchFiring({
      ...BASE,
      noticedAt: "2026-08-20T22:15:00Z",
      delivery: { kind: "agent-wake", delivered: 1, attempted: 1 },
      workflow: {
        subscriptionId: "sub_fictional_9",
        firingId: "fir_fictional_9",
        deliveryStatus: "accepted",
        outcome: { status: "completed", report: "Filed a claim." },
      },
    });
    expect(line).toContain("2026-08-20T22:15:00Z");
    expect(line).toContain("a-parcel-is-late");
    expect(line).toContain("delivered");
    expect(line).toContain("completed");
    // The subject's time is the heading only when nothing noticed it later.
    expect(line).not.toContain("22:14:00Z");
  });

  test("says so out loud when the woken workflow never reported", () => {
    // The case the whole view exists for. A wake that was accepted and a wake
    // whose workflow did the work are the same row without this column, and an
    // audit that read "delivered" would call the chain proven.
    const line = renderCrossWatchFiring({
      ...BASE,
      delivery: { kind: "agent-wake", delivered: 1 },
      workflow: { subscriptionId: "sub_fictional_9", deliveryStatus: "accepted" },
    });
    expect(line).toContain("no outcome reported");
    expect(line).toContain("delivered");
  });

  test("renders a gateway that sends nothing past the identity", () => {
    // An older gateway than this CLI. Every field beyond the identity is
    // optional, and printing `undefined` at whoever is auditing a wake would
    // be worse than saying less.
    const line = renderCrossWatchFiring(BASE);
    expect(line).not.toContain("undefined");
    expect(line).toContain("2026-08-20T22:14:00Z");
    expect(line).toContain("a-parcel-is-late");
    expect(line).toContain("delivers nowhere");
    expect(line).toContain("no outcome reported");
  });

  test("keeps a refusal and a degrade visible", () => {
    const refused = renderCrossWatchFiring({
      ...BASE,
      delivery: { kind: "agent-wake", delivered: 0, attempted: 1, error: "no agent connected" },
      workflow: { outcome: { status: "failed" } },
    });
    expect(refused).toContain("not delivered");
    expect(refused).toContain("no agent connected");
    expect(refused).toContain("failed");

    const degraded = renderCrossWatchFiring({
      ...BASE,
      delivery: { kind: "omnesis-notify", delivered: 1, degraded: "no-agent" },
    });
    expect(degraded).toContain("plain banner");
    expect(degraded).toContain("no agent answered in time");
  });

  test("marks a firing the operator asked for", () => {
    const line = renderCrossWatchFiring({ ...BASE, forced: true });
    expect(line).toContain("by hand");
  });
});

describe("reading a window", () => {
  test("takes the units an operator writes", () => {
    expect(parseDuration("90m", "--since")).toBe(90 * 60_000);
    expect(parseDuration("24h", "--since")).toBe(24 * 3_600_000);
    expect(parseDuration("7d", "--since")).toBe(7 * 86_400_000);
    expect(parseDuration("30s", "--since")).toBe(30_000);
    expect(parseDuration(" 12H ", "--since")).toBe(12 * 3_600_000);
  });

  test("refuses anything else, naming the flag it was given", () => {
    for (const bad of ["", "h", "24", "1w", "1.5h", "0d", "-1h"]) {
      expect(() => parseDuration(bad, "--since"), bad).toThrow(/--since/);
    }
  });
});
