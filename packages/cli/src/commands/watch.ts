// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import {
  c,
  gw,
  isJSON,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";

/**
 * `omnesis watch` — the operator's window onto the watch runtime.
 *
 * A firing is a row and a trace. It is also a notification, for a watch that
 * asked to be one — `deliver` is how that is turned on, and off is the default.
 * So these commands are mostly reads. The writes add a watch as data (a DSL file
 * the operator wrote or a compiler produced, validated against the live ontology
 * before it is stored), hold or resume one, and say where its firings go.
 *
 * The whole surface 404s when the gateway is not in experimental mode, so a 404
 * on the collection earns a hint rather than an opaque failure.
 */

/**
 * What the runtime says about a watch, and whether it amounts to anything.
 *
 * `verdict` is optional because a gateway older than this build does not send
 * one, and a CLI that printed "undefined" at an operator over a version skew
 * would be worse than one that says nothing.
 */
interface WatchVerdictLine {
  name: string;
  because: string;
  /** The word for it. Absent on a gateway that predates the field. */
  label?: string;
  /** Whether there is anything to do about it; absent reads as "no". */
  actionable?: boolean;
}

interface WatchSummary {
  id: string;
  name: string;
  status: "active" | "paused" | "retired";
  addedAt: string;
  fromSeq: number;
  note: string | null;
  firings: number;
  verdict?: WatchVerdictLine | null;
}

/** A watch as the store holds it — the DSL included, which the listing omits. */
interface StoredWatch extends Omit<WatchSummary, "firings"> {
  dsl: unknown;
}

/**
 * What delivering a firing did.
 *
 * Absent for a watch that delivers nowhere, which is most of them — and the
 * only place a transport's refusal is written down, so a firing that went
 * nowhere is otherwise indistinguishable from one that was never meant to go
 * anywhere.
 */
interface FiringDelivery {
  kind: string;
  delivered: number;
  attempted?: number;
  error?: string;
  /**
   * That it arrived as less than it should have. A degraded delivery counts as
   * delivered everywhere else on this row, so without it a plain banner and the
   * agent's account of what happened read identically.
   */
  degraded?: string;
  /** When the transport was asked. Absent on a gateway that predates the field. */
  at?: string;
}

interface Firing {
  seq: number;
  firedAt: string;
  /** When the journal saw the event. Null once it has aged out of the journal. */
  noticedAt?: string | null;
  payload: unknown;
  /** True when an operator fired the watch by hand rather than the runtime. */
  forced?: boolean;
  delivery?: FiringDelivery;
}

/**
 * What the woken workflow made of a firing.
 *
 * The half a delivery receipt cannot answer: a wake that was accepted still
 * says nothing about whether the work happened, and `deferred` is a run that
 * ended waiting on something that will re-enter rather than a final word.
 */
interface WorkflowOutcome {
  status: string;
  report?: string;
  reportedAt?: string;
}

/** The wake a firing became, and what came back from it. */
interface FiringWorkflow {
  subscriptionId?: string;
  firingId?: string;
  deliveryStatus?: string;
  acceptedAt?: string;
  localRunId?: string;
  outcome?: WorkflowOutcome;
}

/**
 * A firing as the cross-watch ledger carries it: the watch named on the row,
 * because the row no longer sits under a heading that says which one it is.
 *
 * Everything past the identity is optional. This shape is what a gateway newer
 * than the operator's may send, and one older than this CLI sends less of it —
 * rendering it as though the fields were promised would print `undefined` at
 * whoever is auditing a wake.
 */
interface CrossWatchFiring {
  watchId: string;
  watchName: string;
  seq: number;
  firedAt: string;
  noticedAt?: string | null;
  forced?: boolean;
  payload?: unknown;
  documents?: unknown;
  delivery?: FiringDelivery;
  workflow?: FiringWorkflow;
}

/**
 * What a degrade class means to whoever is reading the trace.
 *
 * The wire carries the class; the prose is the client's, because what an
 * operator does about each of these differs — wire an agent, look at why a
 * turn failed, or nothing at all if it was a swap that has since finished.
 */
const DEGRADE_PROSE: Readonly<Record<string, string>> = {
  "no-opener": "no agent integration is wired",
  "no-agent": "no agent answered in time",
  "open-failed": "the agent did not open a conversation",
};

interface TraceRecord {
  seq: number;
  nodeId: string;
  key: string;
  transition: string;
  detail: string | null;
  at: string;
}

const OFF_HINT =
  "the watch runtime is off — start the gateway with OMNESIS_EXPERIMENTAL=1 to use it.";

/**
 * A failed response as a CliError.
 *
 * A 404 means two different things here and they need different answers: the
 * gate 404s the whole surface when experimental mode is off, while a route
 * 404s a watch id that does not exist. Only the first earns the hint — telling
 * someone to enable a feature they already have on, because they mistyped an
 * id, is worse than saying nothing.
 */
function gatewayError(status: number, body: string, hintOn404: boolean): CliError {
  let message = body;
  let diagnostics: unknown;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; diagnostics?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
    diagnostics = parsed.diagnostics;
  } catch {
    // Non-JSON body — the raw text is the best available message.
  }
  if (status === 404 && hintOn404) {
    return new CliError(`${c.yellow}${OFF_HINT}${c.reset}`, EXIT_USER_ERROR);
  }
  const detail = Array.isArray(diagnostics)
    ? `\n${diagnostics
        .map((d) => {
          const record = d as { code?: string; path?: string; message?: string };
          return `  ${c.dim}${record.code ?? ""}${c.reset} ${record.path ?? ""}: ${record.message ?? ""}`;
        })
        .join("\n")}`
    : "";
  return new CliError(
    `${c.red}Failed: ${status} ${message}${c.reset}${detail}`,
    pickGatewayExitCode(status),
  );
}

/**
 * Ask for one watch, by id or by the name it is listed under.
 *
 * The routes are keyed by id, and an id is a UUID nobody holds in their head.
 * Every command that shows a watch shows its *name* — `list` is a table of them
 * — so a name is what an operator has to hand when they go to act on one, and
 * passing it earned a bare `404 no such watch`. That reads as "it is gone"
 * rather than "wrong kind of identifier", and a script that treats a 404 as
 * "not installed" will report a live watch as absent and sound certain doing it.
 *
 * The id is tried first and a name is resolved only when it misses, which keeps
 * the identity the fast path and avoids deciding by *shape* which kind of thing
 * was typed — the gateway has never promised the format of an id, and a CLI
 * that pattern-matched one would break quietly if it changed.
 *
 * A name that is not found is reported as a name. Names are not unique, so an
 * ambiguous one is refused with the ids to choose from rather than resolved to
 * whichever the listing happened to return first — picking one would pause,
 * remove or resume a watch the operator did not mean.
 */
async function watchRequest(
  idOrName: string,
  path: (id: string) => string,
  init?: RequestInit,
): Promise<Response> {
  const direct = await gw(path(encodeURIComponent(idOrName)), init);
  if (direct.status !== 404) return direct;

  const listed = await gw("/admin/watch/watches");
  // The listing 404s too when the whole surface is off, which is the one case
  // where the original 404 was telling the truth about something else.
  if (!listed.ok) return direct;
  const { watches } = (await listed.json()) as { watches: WatchSummary[] };

  const matches = watches.filter((watch) => watch.name === idOrName);
  if (matches.length === 1) return gw(path(encodeURIComponent(matches[0]!.id)), init);
  if (matches.length === 0) return direct;

  const ids = matches.map((watch) => `  ${watch.id}  ${c.dim}${watch.status}${c.reset}`).join("\n");
  throw new CliError(
    `${c.red}${matches.length} watches are named ${c.bold}${idOrName}${c.reset}${c.red}.${c.reset} Name the one you mean by id:\n${ids}`,
    EXIT_USER_ERROR,
  );
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List the watches the shadow runtime is running" },
  async run() {
    const res = await withSpinner("Loading watches", () => gw("/admin/watch/watches"));
    if (!res.ok) throw gatewayError(res.status, await res.text(), true);
    const { watches, journalHead } = (await res.json()) as {
      watches: WatchSummary[];
      journalHead: number;
    };

    if (isJSON) {
      console.log(JSON.stringify({ watches, journalHead }, null, 2));
      return;
    }
    if (watches.length === 0) {
      console.log("No watches. Add one with `omnesis watch add <file.json>`.");
      return;
    }
    console.log();
    for (const watch of watches) {
      const status =
        watch.status === "active"
          ? `${c.green}active${c.reset}`
          : `${c.yellow}${watch.status}${c.reset}`;
      console.log(`${c.bold}● ${watch.name}${c.reset}  ${status}`);
      console.log(
        `  ${c.dim}${watch.firings} firing(s) · from seq ${watch.fromSeq} · id ${watch.id}${c.reset}`,
      );
      // The line that says whether the numbers above amount to anything. It
      // is printed for every watch, including the ones that are fine: a report
      // that only spoke up about trouble would leave a reader unable to tell a
      // watch it had judged well from one it had not looked at.
      if (watch.verdict) console.log(`  ${verdictLine(watch.verdict)}`);
      if (watch.note) console.log(`  ${c.dim}${watch.note}${c.reset}`);
    }
    console.log(`\n${c.dim}journal head: ${journalHead}${c.reset}`);
  },
});

const addCommand = defineCommand({
  meta: { name: "add", description: "Add a watch from a DSL file" },
  args: {
    file: { type: "positional", description: "Path to the watch DSL JSON", required: true },
    "from-seq": {
      type: "string",
      description:
        "Start at this journal sequence instead of the head. For tests that want the past.",
    },
  },
  async run(ctx) {
    let dsl: unknown;
    try {
      dsl = JSON.parse(readFileSync(ctx.args.file, "utf8")) as unknown;
    } catch (err) {
      throw new CliError(
        `${c.red}Could not read ${ctx.args.file}: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const body: { dsl: unknown; fromSeq?: number } = { dsl };
    const fromSeq = ctx.args["from-seq"];
    if (typeof fromSeq === "string" && fromSeq !== "") {
      const parsed = Number(fromSeq);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new CliError(`${c.red}--from-seq needs a whole number${c.reset}`, EXIT_USER_ERROR);
      }
      body.fromSeq = parsed;
    }

    const res = await withSpinner("Adding watch", () =>
      gw("/admin/watch/watches", { method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), true);
    const { watch } = (await res.json()) as { watch: WatchSummary };

    if (isJSON) {
      console.log(JSON.stringify(watch, null, 2));
      return;
    }
    console.log(`${c.green}Added${c.reset} ${c.bold}${watch.name}${c.reset}`);
    console.log(
      `  ${c.dim}watching from seq ${watch.fromSeq} — everything before it is history · id ${watch.id}${c.reset}`,
    );
  },
});

const rmCommand = defineCommand({
  meta: { name: "rm", description: "Remove a watch" },
  args: { id: { type: "positional", description: "Watch name or id", required: true } },
  async run(ctx) {
    const res = await watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    console.log(`${c.green}Removed${c.reset} ${ctx.args.id}`);
  },
});

/** One leaf of a spec: where it sits, and what is there. */
interface Leaf {
  /** The path as a person reads it. Display only — never an identity. */
  readonly path: string;
  /** The value, JSON-encoded, so `1` and `"1"` are not the same leaf. */
  readonly value: string;
}

/** A difference at one path, absent on a side where the leaf does not exist. */
interface Difference {
  readonly path: string;
  readonly stored?: string;
  readonly local?: string;
}

/**
 * Every leaf in a value, keyed by where it sits.
 *
 * A structural walk rather than a text diff, because the two sides are JSON
 * that has been through a database and two serializers: key order and
 * whitespace differ constantly and mean nothing, while a changed threshold or a
 * dropped filter clause is a single leaf and would be lost in a line diff.
 * Arrays are indexed rather than compared as sets — order in a DSL array is
 * meaning, as `order` on a sequence gate shows.
 *
 * The key is the JSON-encoded *segments*, not the slash-joined path, and that
 * distinction is what stops a false "identical" — the one answer this must
 * never give, because it tells an operator their file matches what is running
 * when it does not. A joined path cannot tell `{"a/b": 1}` from
 * `{"a": {"b": 1}}`, nor `{"0": "x"}` from `["x"]`. Encoded segments can:
 * quoting distinguishes an object key from an array index, and JSON escaping
 * handles a key containing the separator. The stored side is validated against
 * a strict schema and could not produce either shape, but the local side is a
 * file this command was handed and never validates — and a file that is not a
 * valid spec is exactly the case an operator is asking about.
 */
function leaves(
  value: unknown,
  segments: (string | number)[] = [],
  into = new Map<string, Leaf>(),
): Map<string, Leaf> {
  const at = (): Leaf["path"] => (segments.length === 0 ? "/" : `/${segments.join("/")}`);
  const record = (encoded: string): void => {
    into.set(JSON.stringify(segments), { path: at(), value: encoded });
  };

  if (value !== null && typeof value === "object") {
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((held, index) => [index, held])
      : Object.entries(value as Record<string, unknown>);
    // An empty container is a leaf of its own. Without this it contributes no
    // path at all, and a spec that dropped an empty `filter: {}` would compare
    // identical to one that still has it.
    if (entries.length === 0) record(Array.isArray(value) ? "[]" : "{}");
    for (const [key, held] of entries) leaves(held, [...segments, key], into);
    return into;
  }

  // `undefined` gets its own encoding rather than borrowing null's: neither can
  // reach here from `JSON.parse`, and a coalesce that quietly merged them would
  // read as handling a case it was actually hiding.
  if (value === undefined) record("undefined");
  // JSON has no spelling for these, and `JSON.stringify` renders every one of
  // them as something they are not — `null` for a non-finite, `0` for negative
  // zero — which is a difference silently reported as a match.
  else if (typeof value === "number" && !Number.isFinite(value)) record(String(value));
  else if (Object.is(value, -0)) record("-0");
  else record(JSON.stringify(value));
  return into;
}

/** What differs between the stored spec and a local file, by path. */
function differences(stored: unknown, local: unknown): Difference[] {
  const a = leaves(stored);
  const b = leaves(local);
  const out: Difference[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])]) {
    const x = a.get(key);
    const y = b.get(key);
    if (x?.value === y?.value) continue;
    out.push({
      path: (x ?? y)!.path,
      ...(x === undefined ? {} : { stored: x.value }),
      ...(y === undefined ? {} : { local: y.value }),
    });
  }
  // Sorted by the readable path, so a listing reads top-down through the spec
  // rather than in whatever order the walk happened to reach things.
  return out.sort((l, r) => (l.path < r.path ? -1 : l.path > r.path ? 1 : 0));
}

/**
 * The difference listing as a person reads it.
 *
 * Separated from the printing so it can be tested: the command runs in JSON
 * mode almost everywhere it is exercised, and prose nobody executes is prose
 * nobody has checked.
 */
export function renderDifferences(
  diffs: readonly Difference[],
  name: string,
  file: string,
): string[] {
  if (diffs.length === 0) {
    return [`${c.green}identical${c.reset} — ${c.bold}${name}${c.reset} matches ${file}`];
  }
  const absent = `${c.dim}(absent)${c.reset}`;
  const lines = [
    `${c.yellow}${diffs.length} ${diffs.length === 1 ? "difference" : "differences"}${c.reset} between ${c.bold}${name}${c.reset} (stored) and ${file}`,
    "",
  ];
  for (const d of diffs) {
    lines.push(`  ${c.bold}${d.path}${c.reset}`);
    lines.push(`    ${c.dim}stored${c.reset} ${d.stored ?? absent}`);
    lines.push(`    ${c.dim}file  ${c.reset} ${d.local ?? absent}`);
  }
  return lines;
}

const restampCommand = defineCommand({
  meta: {
    name: "restamp",
    description:
      "Re-validate every watch against the current ontology and re-stamp what still holds",
  },
  async run() {
    const res = await withSpinner("Re-stamping", () =>
      gw("/admin/watch/restamp", { method: "POST" }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), true);
    const out = (await res.json()) as {
      fingerprint: string;
      restamped: { name: string; resumed: boolean }[];
      refused: { name: string; diagnostics: { code?: string; message?: string }[] }[];
      skipped: { name: string; reason: string }[];
    };

    if (isJSON) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    const resumed = out.restamped.filter((w) => w.resumed).length;
    console.log(
      `\n${c.green}${out.restamped.length} re-stamped${c.reset} to ${c.dim}${out.fingerprint}${c.reset}` +
        (resumed > 0 ? ` ${c.dim}(${resumed} resumed)${c.reset}` : ""),
    );
    for (const watch of out.restamped) {
      console.log(`  ${c.dim}·${c.reset} ${watch.name}${watch.resumed ? " (resumed)" : ""}`);
    }
    // The half worth reading. A bulk operation that only reported its successes
    // would let a watch that no longer validates sit paused and unmentioned.
    for (const watch of out.refused) {
      console.log(`\n${c.yellow}refused${c.reset} ${c.bold}${watch.name}${c.reset} — left paused`);
      for (const d of watch.diagnostics.slice(0, 3)) {
        console.log(`    ${c.dim}${d.code ?? ""}${c.reset} ${d.message ?? ""}`);
      }
    }
    for (const watch of out.skipped) {
      console.log(`${c.dim}skipped ${watch.name} (${watch.reason})${c.reset}`);
    }
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "The spec a watch is actually running" },
  args: {
    id: { type: "positional", description: "Watch id", required: true },
    diff: {
      type: "string",
      description: "Compare the stored spec against a local DSL file rather than printing it",
    },
  },
  async run(ctx) {
    const res = await withSpinner("Loading watch", () =>
      watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}`),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const { watch } = (await res.json()) as { watch: StoredWatch };

    if (typeof ctx.args.diff !== "string" || ctx.args.diff === "") {
      // JSON mode prints the whole stored record because a script wants the
      // status and cursor alongside the spec; a person asked to see the spec is
      // shown the spec.
      console.log(JSON.stringify(isJSON ? watch : watch.dsl, null, 2));
      return;
    }

    // Read here and compared here. The file is never sent anywhere — the only
    // request this command makes is the GET above.
    let local: unknown;
    try {
      local = JSON.parse(readFileSync(ctx.args.diff, "utf8")) as unknown;
    } catch (err) {
      throw new CliError(
        `${c.red}Could not read ${ctx.args.diff}: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const diffs = differences(watch.dsl, local);
    if (isJSON) {
      console.log(JSON.stringify({ id: watch.id, name: watch.name, differences: diffs }, null, 2));
      return;
    }
    for (const line of renderDifferences(diffs, watch.name, ctx.args.diff)) console.log(line);
  },
});

/** Send a status change and report what came back. Shared by `pause` and `resume`. */
async function setStatus(
  idOrName: string,
  status: "paused" | "active",
  skip: boolean,
): Promise<void> {
  const res = await watchRequest(idOrName, (id) => `/admin/watch/watches/${id}`, {
    method: "PATCH",
    body: JSON.stringify(skip ? { status, skip: true } : { status }),
  });
  if (!res.ok) throw gatewayError(res.status, await res.text(), false);
  const { watch, skipped } = (await res.json()) as {
    watch: WatchSummary;
    skipped?: { what: string; seq: number } | null;
  };
  console.log(
    `${status === "active" ? `${c.green}Resumed` : `${c.yellow}Paused`}${c.reset} ${c.bold}${watch.name}${c.reset}`,
  );
  // Named out loud, because it is the one part of a resume that changes what
  // the watch will have seen. Everything else leaves its history alone.
  if (skipped) {
    console.log(
      `  ${c.yellow}${skipped.what} ${skipped.seq} was skipped, and the trace says so${c.reset}`,
    );
  }
}

/**
 * The shape of a reaction binding, as the gateway will accept it.
 *
 * Checked here as well as at the route so an operator who typed a 700-character
 * value learns which pair was refused rather than reading a field name out of a
 * 400. The numbers match the schema the gateway validates against; a binding
 * that passes here and fails there is a version skew, not a silent truncation.
 */
const BINDING_KEY_MAX = 64;
const BINDING_VALUE_MAX = 512;
const BINDING_MAX = 32;

/**
 * `key=value` pairs as the map a wake carries.
 *
 * Bindings are opaque referents: the value is whatever the woken agent needs to
 * resolve what the instruction is about, and nothing here reads it. Split on
 * the first `=` only, so a value may contain one.
 */
export function parseBindings(raw: unknown): Record<string, string> {
  // citty gives one value for a flag passed once and an array for a flag passed
  // several times; both are the operator writing the same thing.
  const entries = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
  const bindings: Record<string, string> = {};
  for (const entry of entries) {
    const split = entry.indexOf("=");
    const key = split === -1 ? "" : entry.slice(0, split);
    const value = split === -1 ? "" : entry.slice(split + 1);
    if (key === "" || value === "") {
      throw new CliError(
        `${c.red}--binding must be key=value; got ${c.bold}${entry}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (key.length > BINDING_KEY_MAX) {
      throw new CliError(
        `${c.red}--binding key '${key}' is longer than ${BINDING_KEY_MAX} characters${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (value.length > BINDING_VALUE_MAX) {
      throw new CliError(
        `${c.red}--binding value for '${key}' is longer than ${BINDING_VALUE_MAX} characters${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    // A repeated key would otherwise overwrite the earlier one and take the
    // last-written value with no sign that the operator asked for two things.
    if (key in bindings) {
      throw new CliError(
        `${c.red}--binding ${c.bold}${key}${c.reset}${c.red} was given twice${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    bindings[key] = value;
  }
  if (Object.keys(bindings).length > BINDING_MAX) {
    throw new CliError(`${c.red}at most ${BINDING_MAX} --binding pairs${c.reset}`, EXIT_USER_ERROR);
  }
  return bindings;
}

/**
 * Turn delivery on or off for an installed watch.
 *
 * Off is the default and stays the default. A firing is a row and a trace; a
 * notification interrupts a person, and that is a decision made per watch
 * rather than once for all of them.
 */
const deliverCommand = defineCommand({
  meta: { name: "deliver", description: "Send a watch's firings somewhere, or nowhere" },
  args: {
    id: { type: "positional", description: "Watch name or id", required: true },
    to: {
      type: "string",
      description: "Where firings go: `omnesis-notify`, `agent-wake`, or `none` to stop delivering",
      default: "omnesis-notify",
    },
    integration: {
      type: "string",
      description: "With --to agent-wake: which agent to wake (e.g. `openclaw`)",
    },
    instruction: {
      type: "string",
      description: "With --to agent-wake: what to tell it to do, in your own words",
    },
    binding: {
      type: "string",
      description:
        "With --to agent-wake: a referent the instruction names, as key=value; repeatable",
    },
  },
  async run(ctx) {
    // The old spelling of the notify kind still works. An operator has it in
    // an alias or a note, and breaking that to rename a value they never
    // chose would be a poor trade. It is normalised here so everything below
    // — and everything the gateway is told — speaks one vocabulary.
    const to = ctx.args.to === "ios-push" ? "omnesis-notify" : ctx.args.to;
    if (to !== "omnesis-notify" && to !== "agent-wake" && to !== "none") {
      throw new CliError(
        `${c.red}--to must be 'omnesis-notify', 'agent-wake' or 'none'${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    // Checked here as well as at the gateway so the message names the flag the
    // operator is missing rather than the field the route wanted.
    if (to === "agent-wake" && (!ctx.args.integration || !ctx.args.instruction)) {
      throw new CliError(
        `${c.red}waking an agent needs --integration (which one) and --instruction (what to tell it)${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const bindings = parseBindings(ctx.args.binding);
    // Refused rather than dropped. A binding on a notify delivery has nothing
    // to resolve it, and a flag that is quietly ignored reads as one that took.
    if (to !== "agent-wake" && Object.keys(bindings).length > 0) {
      throw new CliError(
        `${c.red}--binding only means something with --to agent-wake — nothing else resolves a referent${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const body =
      to === "none"
        ? { kind: null }
        : to === "agent-wake"
          ? {
              kind: "agent-wake",
              integration: ctx.args.integration,
              instruction: ctx.args.instruction,
              // Omitted when empty rather than sent as `{}`: a wake with no
              // referents and one that carries an empty map are the same wake,
              // and the anchor they reconcile against must agree they are.
              ...(Object.keys(bindings).length > 0 ? { bindings } : {}),
            }
          : { kind: "omnesis-notify" };
    const res = await watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}/delivery`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const { watch } = (await res.json()) as { watch: WatchSummary };
    console.log(
      to === "none"
        ? `${c.dim}${watch.name} delivers nowhere — its firings are rows and traces${c.reset}`
        : to === "agent-wake"
          ? `${c.green}${watch.name} will wake ${String(ctx.args.integration)} when it fires${c.reset}`
          : `${c.green}${watch.name} will notify you when it fires${c.reset}`,
    );
  },
});

const pauseCommand = defineCommand({
  meta: { name: "pause", description: "Hold a watch without removing it" },
  args: { id: { type: "positional", description: "Watch name or id", required: true } },
  run: (ctx) => setStatus(ctx.args.id, "paused", false),
});

/**
 * Let a held watch run again.
 *
 * Worth more than it looks: the runtime holds a watch on its own when the
 * ontology it validated against moves or one of its nodes throws, and without a
 * way back the only recovery is to delete it and add it again — which starts it
 * at the journal head and loses everything it had already said.
 */
const resumeCommand = defineCommand({
  meta: { name: "resume", description: "Let a held watch run again" },
  args: {
    id: { type: "positional", description: "Watch name or id", required: true },
    skip: {
      type: "boolean",
      description: "Move past the one thing the watch failed on, recording the skip",
    },
  },
  run: (ctx) => setStatus(ctx.args.id, "active", ctx.args.skip === true),
});

/**
 * Whether two timestamps name the same second.
 *
 * For most watches the subject's time and the moment it was noticed are the
 * same instant, and printing both would be noise on every line. They diverge
 * only when a watch is about something that already had a date of its own.
 */
function sameSecond(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return a === b;
  return Math.floor(left / 1000) === Math.floor(right / 1000);
}

/** How far back `firings --all` looks when given no window. */
const DEFAULT_FIRINGS_SINCE_MS = 24 * 3_600_000;

const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `24h`, `90m`, `7d` as milliseconds.
 *
 * A span rather than a timestamp, because the question this window is opened to
 * answer — did last night's firing reach its workflow — is asked in "how long
 * ago", and nobody holds an ISO instant to hand.
 */
export function parseDuration(raw: string, flag: string): number {
  const match = /^(\d+)([a-z])$/.exec(raw.trim().toLowerCase());
  const unit = match ? DURATION_UNITS[match[2]!] : undefined;
  const count = match ? Number(match[1]) : Number.NaN;
  if (unit === undefined || !Number.isInteger(count) || count < 1) {
    throw new CliError(
      `${c.red}${flag} must be a whole number of seconds, minutes, hours or days — 90m, 24h, 7d${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return count * unit;
}

/**
 * What a firing did, on one line: when, which watch, whether it was delivered,
 * and what the woken workflow reported.
 *
 * The last column is the point of the view. A delivery receipt says a wake was
 * accepted; it says nothing about whether the work happened, and a ledger that
 * stopped at "delivered" would answer the easy half of the question an audit
 * is opened to settle. So the outcome is printed on every row, including the
 * rows that have none — a firing whose workflow never reported back and one
 * that reported "nothing to do" are the same silence anywhere else.
 */
export function renderCrossWatchFiring(firing: CrossWatchFiring): string {
  const spoke = firing.noticedAt ?? firing.firedAt;
  const byHand = firing.forced ? ` ${c.dim}(by hand)${c.reset}` : "";
  const delivery = firing.delivery;
  const lesser = delivery?.degraded
    ? ` ${c.yellow}(plain banner — ${DEGRADE_PROSE[delivery.degraded] ?? delivery.degraded})${c.reset}`
    : "";
  const delivered =
    delivery === undefined
      ? `${c.dim}delivers nowhere${c.reset}`
      : delivery.delivered > 0
        ? `${c.dim}${delivery.kind}: delivered${c.reset}${lesser}`
        : `${c.yellow}${delivery.kind}: not delivered${delivery.error ? ` — ${delivery.error}` : ""}${c.reset}${lesser}`;
  const status = firing.workflow?.outcome?.status;
  // A short table rather than an exhaustive one: a status a newer gateway
  // learned to report lands in the quiet colour, which is the safe direction.
  // Louder would be a CLI shouting about a word it does not know.
  const outcome =
    status === undefined
      ? `${c.yellow}no outcome reported${c.reset}`
      : status === "failed"
        ? `${c.red}${status}${c.reset}`
        : status === "deferred"
          ? `${c.yellow}${status}${c.reset}`
          : `${c.green}${status}${c.reset}`;
  return `${c.dim}${spoke}${c.reset}  ${c.bold}${firing.watchName}${c.reset}${byHand}  ${delivered}  ${outcome}`;
}

/**
 * Every watch's recent firings on one page.
 *
 * The chain a wake makes — a watch fired, a delivery was attempted, a workflow
 * ran and said what it did — spans three records, and the per-watch ledger
 * answers for one watch at a time. This is the view for the question that names
 * no watch: whether anything fired in the last day, and whether it caused
 * anything.
 */
async function listAllFirings(sinceRaw: unknown, limitRaw: unknown): Promise<void> {
  const sinceMs =
    typeof sinceRaw === "string" && sinceRaw !== ""
      ? parseDuration(sinceRaw, "--since")
      : DEFAULT_FIRINGS_SINCE_MS;
  const query = new URLSearchParams({ since: String(Date.now() - sinceMs) });
  if (typeof limitRaw === "string" && limitRaw !== "") {
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError(`${c.red}--limit must be a whole number${c.reset}`, EXIT_USER_ERROR);
    }
    query.set("limit", String(limit));
  }
  const res = await withSpinner("Loading firings", () => gw(`/admin/watch/firings?${query}`));
  // The collection, so a 404 is the whole surface being off rather than a
  // mistyped id — there is no id here to mistype.
  if (!res.ok) throw gatewayError(res.status, await res.text(), true);
  const body = (await res.json()) as { firings?: CrossWatchFiring[] };

  if (isJSON) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  const firings = body.firings ?? [];
  if (firings.length === 0) {
    console.log(`No watch has fired in the last ${humanDuration(sinceMs)}.`);
    return;
  }
  console.log();
  for (const firing of firings) console.log(renderCrossWatchFiring(firing));
}

/** A span as the operator asked for it, read back to them. */
function humanDuration(ms: number): string {
  for (const [unit, size] of [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ] as const) {
    if (ms % size === 0 && ms >= size) {
      const count = ms / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 1000)} seconds`;
}

const firingsCommand = defineCommand({
  meta: { name: "firings", description: "What a watch has said, and what its wake did about it" },
  args: {
    id: { type: "positional", description: "Watch name or id", required: false },
    all: {
      type: "boolean",
      description: "Every watch's firings rather than one watch's, newest first",
    },
    since: {
      type: "string",
      description: "With --all: how far back to look — 90m, 24h, 7d (default 24h)",
    },
    limit: { type: "string", description: "With --all: most firings to show" },
  },
  async run(ctx) {
    const all = ctx.args.all === true;
    const id = typeof ctx.args.id === "string" ? ctx.args.id : "";
    if (all && id !== "") {
      throw new CliError(
        `${c.red}Name a watch or pass --all, not both.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (!all) {
      // Refused rather than ignored: the per-watch route has no window, and a
      // flag that silently did nothing would report a quiet day as a wide one.
      for (const flag of ["since", "limit"] as const) {
        if (typeof ctx.args[flag] === "string" && ctx.args[flag] !== "") {
          throw new CliError(`${c.red}--${flag} applies to --all${c.reset}`, EXIT_USER_ERROR);
        }
      }
      if (id === "") {
        throw new CliError(
          `${c.red}Name a watch, or pass --all for every watch's firings.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
    }
    if (all) return listAllFirings(ctx.args.since, ctx.args.limit);

    const res = await withSpinner("Loading firings", () =>
      watchRequest(id, (encoded) => `/admin/watch/watches/${encoded}/firings`),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const { watch, firings } = (await res.json()) as { watch: string; firings: Firing[] };

    if (isJSON) {
      console.log(JSON.stringify({ watch, firings }, null, 2));
      return;
    }
    if (firings.length === 0) {
      console.log(`${watch} has not fired.`);
      return;
    }
    console.log();
    for (const firing of firings) {
      // The heading is when the watch spoke, because that is the question a
      // ledger is read to answer. A firing is stamped with the *subject's*
      // time — the engine runs on journal time so replays agree — and the two
      // can be far apart: a calendar event created months ago and moved today
      // fires with the creation date on it. Showing only that reads as a watch
      // that fired in the past.
      const spoke = firing.noticedAt ?? firing.firedAt;
      // A firing an operator asked for is not something the watch caught, and
      // a ledger that showed the two alike would credit a watch with work it
      // never did.
      const byHand = firing.forced ? ` ${c.dim}(by hand)${c.reset}` : "";
      console.log(`${c.bold}● ${spoke}${c.reset} ${c.dim}seq ${firing.seq}${c.reset}${byHand}`);
      if (firing.noticedAt && !sameSecond(firing.noticedAt, firing.firedAt)) {
        console.log(`  ${c.dim}about something dated ${firing.firedAt}${c.reset}`);
      }
      console.log(`  ${JSON.stringify(firing.payload)}`);
      const delivery = firing.delivery;
      if (delivery) {
        // A degrade rides on the delivered line rather than replacing it: the
        // notification did arrive, and saying only "delivered" hides that the
        // operator got the plain banner instead of the agent's account.
        const lesser = delivery.degraded
          ? ` ${c.yellow}(plain banner — ${DEGRADE_PROSE[delivery.degraded] ?? delivery.degraded})${c.reset}`
          : "";
        console.log(
          delivery.delivered > 0
            ? `  ${c.dim}${delivery.kind}: delivered${c.reset}${lesser}`
            : `  ${c.yellow}${delivery.kind}: not delivered${delivery.error ? ` — ${delivery.error}` : ""}${c.reset}${lesser}`,
        );
      }
    }
  },
});

const traceCommand = defineCommand({
  meta: { name: "trace", description: "Why a watch said what it said — or why it did not" },
  args: {
    id: { type: "positional", description: "Watch id", required: true },
    limit: { type: "string", description: "How many records to show (default 200)" },
  },
  async run(ctx) {
    const limit =
      typeof ctx.args.limit === "string" ? `?limit=${encodeURIComponent(ctx.args.limit)}` : "";
    const res = await withSpinner("Loading trace", () =>
      watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}/trace${limit}`),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const { watch, records, judgeExchanges } = (await res.json()) as {
      watch: string;
      records: TraceRecord[];
      /** Absent from a gateway that predates the exchanges. */
      judgeExchanges?: boolean;
    };

    if (isJSON) {
      console.log(JSON.stringify({ watch, records }, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log(`${watch} has done nothing yet.`);
      return;
    }
    console.log();
    for (const record of records) {
      const key = record.key === "singleton" ? "" : ` ${c.dim}${record.key}${c.reset}`;
      console.log(
        `${c.dim}seq ${String(record.seq).padStart(6)}${c.reset}  ${record.nodeId}${key}  ${c.bold}${record.transition}${c.reset}` +
          (record.detail ? `  ${c.dim}${record.detail}${c.reset}` : ""),
      );
    }
    // A judge leaves no transition of its own — its decision surfaces as the
    // node firing or holding — so a reader looking at these records has no way
    // to tell that the words behind them were kept. The gateway says so.
    if (judgeExchanges === true) {
      console.log(
        `\n${c.dim}A judge decided some of these. \`omnesis watch judge ${ctx.args.id}\` shows what it was asked and what it answered.${c.reset}`,
      );
    }
  },
});

interface JudgeExchange {
  nodeId: string;
  key: string;
  subject: string;
  verdict: string;
  prompt: string;
  reply: string;
  ms: number;
  at: string;
}

const judgeCommand = defineCommand({
  meta: {
    name: "judge",
    description: "What the judge was asked about a watch, and what it answered",
  },
  args: {
    id: { type: "positional", description: "Watch id", required: true },
    limit: { type: "string", description: "How many exchanges to show (default 20)" },
    full: { type: "boolean", description: "Show each prompt in full rather than its opening" },
  },
  async run(ctx) {
    const limit =
      typeof ctx.args.limit === "string" ? `?limit=${encodeURIComponent(ctx.args.limit)}` : "";
    const res = await withSpinner("Loading judge exchanges", () =>
      watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}/judge-exchanges${limit}`),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const { watch, exchanges } = (await res.json()) as {
      watch: { id: string; name: string };
      exchanges: JudgeExchange[];
    };

    if (isJSON) {
      console.log(JSON.stringify({ watch, exchanges }, null, 2));
      return;
    }
    if (exchanges.length === 0) {
      // Two different silences, and the operator can act on only one of them.
      console.log(
        `${watch.name} has no judge exchanges. Either no judge has run for it, or none has since this gateway started keeping them.`,
      );
      return;
    }
    console.log();
    for (const exchange of exchanges) {
      const verdict =
        exchange.verdict === "matched"
          ? `${c.bold}matched${c.reset}`
          : exchange.verdict === "unreadable"
            ? `${c.yellow}unreadable${c.reset}`
            : `${c.dim}declined${c.reset}`;
      console.log(
        `${c.dim}${exchange.at}${c.reset}  ${exchange.nodeId}  ${verdict}  ${c.dim}${exchange.ms}ms${c.reset}`,
      );
      // The prompt is the long half and mostly the same each time; the reply is
      // what differs and what a wrong verdict is read off. So the reply is
      // always whole and the prompt opens unless it is asked for.
      console.log(
        `  ${c.dim}asked:${c.reset} ${ctx.args.full ? exchange.prompt : opening(exchange.prompt)}`,
      );
      console.log(`  ${c.dim}said:${c.reset}  ${exchange.reply.trim()}`);
    }
  },
});

/** The first line of a prompt, clipped — enough to tell two propositions apart. */
function opening(prompt: string): string {
  const first = prompt.split("\n").find((line) => line.trim().length > 0) ?? "";
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

/**
 * "4 stopped (2 drifted, 1 failed, 1 held)" — only the causes that occurred.
 *
 * Read from what the gateway sent rather than from a list repeated here. The
 * server's classification is exhaustive so a cause cannot fall out of the
 * count; a second list on this side would let one fall out of the sentence,
 * which is the same failure one layer further out.
 */
function describeStopped(stopped: Record<string, number>): string {
  return Object.entries(stopped)
    .filter(([cause, count]) => cause !== "total" && count > 0)
    .map(([cause, count]) => `${count} ${cause}`)
    .join(", ");
}

/** A duration a person reads, or the fact that it has never happened. */
function ago(ms: number | null): string {
  if (ms === null) return "never, since this gateway started";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * Fire a watch by hand.
 *
 * A watch's condition is the half you can read. Where its firings go only runs
 * when the world produces the condition, so a broken delivery path stays
 * broken silently until the day it was needed. This runs that half now.
 */
const fireCommand = defineCommand({
  meta: {
    name: "fire",
    description: "Fire a watch by hand, to prove where its firings actually go",
  },
  args: {
    id: { type: "positional", description: "Watch name or id", required: true },
    doc: {
      type: "string",
      description:
        "A document id this firing is about; repeatable. What a woken agent may be answered from",
    },
    payload: {
      type: "string",
      description: "What the firing carries, as JSON. Nothing reads it but `watch firings`",
    },
  },
  async run(ctx) {
    // citty gives one value for a flag passed once and an array for a flag
    // passed several times; both are the operator writing the same thing.
    const raw: unknown = ctx.args.doc;
    const documentIds = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
    let payload: Record<string, unknown> | undefined;
    if (typeof ctx.args.payload === "string" && ctx.args.payload.length > 0) {
      // Parsed here so a typo is a message about the flag rather than a 400
      // from the route about a field the operator did not name.
      let parsed: unknown;
      try {
        parsed = JSON.parse(ctx.args.payload);
      } catch {
        throw new CliError(`${c.red}--payload must be JSON${c.reset}`, EXIT_USER_ERROR);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new CliError(`${c.red}--payload must be a JSON object${c.reset}`, EXIT_USER_ERROR);
      }
      payload = parsed as Record<string, unknown>;
    }
    const res = await withSpinner("Firing", () =>
      watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}/fire`, {
        method: "POST",
        body: JSON.stringify({
          ...(documentIds.length > 0 ? { documentIds } : {}),
          ...(payload === undefined ? {} : { payload }),
        }),
      }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const body = (await res.json()) as {
      watch: { name: string };
      seq: number;
      delivered: number;
      suppressed: number;
      error?: string;
    };
    if (isJSON) return void console.log(JSON.stringify(body, null, 2));
    console.log(
      `Fired ${c.bold}${body.watch.name}${c.reset} by hand ${c.dim}(seq ${body.seq})${c.reset}`,
    );
    // Said either way. A cap is the ordinary reason a firing goes nowhere, and
    // an operator proving a delivery path needs to know that is what happened
    // rather than concluding the path is broken.
    // Three outcomes, and the operator has to be able to tell them apart: a
    // cap is the ordinary reason a firing goes nowhere, and reading that as a
    // broken delivery path is exactly the confusion this verb exists to end.
    if (body.delivered > 0) {
      console.log(`  delivered`);
    } else if (body.suppressed > 0) {
      console.log(
        `  ${c.yellow}not delivered — a daily cap is spent${c.reset}; see \`watch trace ${body.watch.name}\``,
      );
    } else {
      // Named here rather than left on a row. A transport that is not wired is
      // the answer an operator ran this to get, and sending them somewhere
      // else to read it would be most of the way back to the silence this verb
      // exists to break.
      console.log(
        `  ${c.yellow}nothing accepted it${c.reset}${body.error ? `: ${body.error}` : ""}`,
      );
    }
  },
});

/**
 * How far back `--days` goes when given no number.
 *
 * Ninety, because the question it asks — would this have fired lately — is
 * about the scale on which the conditions worth watching for happen: a
 * completion, a renewal, an instalment. Declared here rather than taken from
 * the gateway: this is the operator surface, and it is the only place a
 * default can be true, since the route deliberately has none and answers a
 * body with neither field on the recent-traffic path.
 */
const DEFAULT_TRY_DAYS = 90;

/**
 * Try a candidate before storing it.
 *
 * The question `probe` answers narrowly — is my threshold right — asked about
 * the whole watch, and asked before there is a watch to name. A watch starts
 * at the journal head, so its first evidence arrives with its first match: a
 * condition that admits nothing produces exactly the silence of a quiet week,
 * for as long as you are willing to wait.
 */
const preflightCommand = defineCommand({
  meta: {
    name: "try",
    description: "Try a candidate watch against the past, before storing it",
  },
  args: {
    file: { type: "positional", description: "Path to the watch JSON", required: true },
    events: {
      type: "string",
      description: "How many recent journal events to replay (default 500)",
    },
    days: {
      type: "string",
      description:
        "Replay a span instead: how many days back to go (90 if given no number, max 365)",
    },
  },
  async run(ctx) {
    let dsl: unknown;
    try {
      dsl = JSON.parse(readFileSync(ctx.args.file, "utf8")) as unknown;
    } catch (err) {
      throw new CliError(
        `${c.red}Could not read ${ctx.args.file}: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const events = ctx.args.events === undefined ? undefined : Number(ctx.args.events);
    if (events !== undefined && (!Number.isInteger(events) || events < 1)) {
      throw new CliError(`${c.red}--events must be a whole number${c.reset}`, EXIT_USER_ERROR);
    }
    // `--days` with no number means the default span rather than an error: the
    // question it asks — "would this have fired lately" — has an obvious
    // answer for how far back, and making everyone type it invites nobody.
    const days =
      ctx.args.days === undefined
        ? undefined
        : ctx.args.days === "" || ctx.args.days === "true"
          ? DEFAULT_TRY_DAYS
          : Number(ctx.args.days);
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
      throw new CliError(`${c.red}--days must be a whole number${c.reset}`, EXIT_USER_ERROR);
    }
    if (events !== undefined && days !== undefined) {
      throw new CliError(
        `${c.red}Ask for --events or --days, not both: one replays recent traffic, the other a span.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const res = await withSpinner("Trying it", () =>
      gw("/admin/watch/preflight", {
        method: "POST",
        body: JSON.stringify({
          dsl,
          ...(events === undefined ? {} : { events }),
          ...(days === undefined ? {} : { days }),
        }),
      }),
    );
    if (!res.ok) {
      // The route answers an invalid candidate with the validator's own
      // diagnostics rather than a message, and those are the useful part —
      // they name what about the watch does not hold against this install.
      const text = await res.text();
      const invalid = ((): string[] | null => {
        try {
          const parsed = JSON.parse(text) as { valid?: boolean; diagnostics?: unknown };
          return parsed.valid === false && Array.isArray(parsed.diagnostics)
            ? parsed.diagnostics.map(String)
            : null;
        } catch {
          return null;
        }
      })();
      if (invalid) {
        throw new CliError(
          `${c.red}That candidate does not hold against this install:${c.reset}\n  ${invalid.join("\n  ")}`,
          EXIT_USER_ERROR,
        );
      }
      throw gatewayError(res.status, text, false);
    }
    const body = (await res.json()) as {
      window: {
        events: number;
        offered: number;
        from: string | null;
        to: string | null;
        observedMs: number;
        daysRequested?: number;
        truncated?: true;
        ended?: string;
      };
      firings: number;
      failed?: Array<{ nodeId: string; failure: string; detail?: string }>;
      judgeGated: boolean;
      nodes: Array<{
        nodeId: string;
        type: string;
        evaluated: number;
        matched: number;
        wouldAsk: number;
        diagnostics: string[];
        samples: Array<{ seq: number; transition: string; detail?: string }>;
      }>;
    };
    if (isJSON) return void console.log(JSON.stringify(body, null, 2));

    // A span and a slice of recent traffic are different questions, and a
    // reach read against the wrong one is read wrong. The span is what was
    // CONSUMED: a ninety-day request against a younger journal is a younger
    // answer, and saying ninety would hand the reader the wrong denominator.
    const spanDays = Math.round(body.window.observedMs / 86_400_000);
    const over =
      body.window.daysRequested === undefined
        ? `Over ${body.window.events} recent event(s)`
        : `Over ${body.window.events} event(s) spanning ${spanDays} day(s)` +
          (spanDays < body.window.daysRequested
            ? body.window.truncated
              ? ` of the ${body.window.daysRequested} asked for — the rest did not fit in one replay`
              : ` of the ${body.window.daysRequested} asked for — the journal goes back no further`
            : "");

    console.log(
      `\n${c.bold}${over}${c.reset}` +
        (body.window.from ? ` ${c.dim}${body.window.from} → ${body.window.to}${c.reset}` : "") +
        // Said whenever it stopped early, because otherwise the numbers below
        // are read against a window the watch never saw.
        (body.window.ended
          ? ` ${c.dim}(stopped after ${body.window.events} of ${body.window.offered}: ${body.window.ended})${c.reset}`
          : ""),
    );
    // First, and loudly. A candidate that broke and one that catches nothing
    // are the same zero everywhere else.
    for (const failure of body.failed ?? []) {
      console.log(
        `${c.red}${failure.nodeId} failed (${failure.failure})${c.reset}${failure.detail ? ` — ${failure.detail}` : ""}`,
      );
    }
    for (const node of body.nodes) {
      // Matched OF evaluated, always. A bare "0" is the answer to two
      // different questions, and only one of them is about the condition.
      console.log(
        `\n${c.bold}${node.nodeId}${c.reset} ${c.dim}(${node.type})${c.reset}  ` +
          `${node.matched} of ${node.evaluated} taken up` +
          (node.wouldAsk > 0 ? `  ${c.dim}· ${node.wouldAsk} would reach a model${c.reset}` : ""),
      );
      for (const line of node.diagnostics) console.log(`  ${c.yellow}${line}${c.reset}`);
      for (const sample of node.samples) {
        console.log(
          `  ${c.dim}seq ${sample.seq}  ${sample.transition}${sample.detail ? ` — ${sample.detail}` : ""}${c.reset}`,
        );
      }
    }
    console.log(
      `\n${body.firings} firing(s) over the window.` +
        (body.judgeGated
          ? ` ${c.dim}A judge sits on the path, and a try never asks one — so this counts only what the deterministic half decided.${c.reset}`
          : ""),
    );
  },
});

/**
 * Ask a watch's recall arm what it would have caught.
 *
 * The only way to find out whether a threshold is right without waiting for a
 * month of silence to mean something. A watch starts at the journal head, so
 * its first evidence arrives with its first match — and a watch whose
 * threshold is slightly too high never produces any.
 */
const probeCommand = defineCommand({
  meta: {
    name: "probe",
    description: "What a watch's recall arm would have caught in documents you already have",
  },
  args: {
    id: { type: "positional", description: "Watch name or id", required: true },
    days: { type: "string", description: "How far back to look (default 90)", default: "90" },
    limit: {
      type: "string",
      description: "Most documents to score (default 2000)",
      default: "2000",
    },
  },
  async run(ctx) {
    const windowDays = Number(ctx.args.days);
    const limit = Number(ctx.args.limit);
    if (!Number.isInteger(windowDays) || windowDays < 1) {
      throw new CliError(
        `${c.red}--days must be a whole number of days${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CliError(`${c.red}--limit must be a whole number${c.reset}`, EXIT_USER_ERROR);
    }
    const res = await withSpinner("Scoring", () =>
      watchRequest(ctx.args.id, (id) => `/admin/watch/watches/${id}/probe`, {
        method: "POST",
        body: JSON.stringify({ windowDays, limit }),
      }),
    );
    if (!res.ok) throw gatewayError(res.status, await res.text(), false);
    const body = (await res.json()) as {
      watch: { name: string };
      arms: {
        nodeId: string;
        considered: number;
        nominated: number;
        threshold: number;
        best: number;
        p95: number;
        median: number;
        shortfall: number | null;
        nextThreshold: number | null;
        windowDays: number;
        capped: boolean;
      }[];
    };
    if (isJSON) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    if (body.arms.length === 0) {
      console.log(
        `${c.dim}${body.watch.name} has no semantic arm — nothing here is threshold-dependent${c.reset}`,
      );
      return;
    }
    console.log(`\n${c.bold}${body.watch.name}${c.reset}`);
    for (const arm of body.arms) {
      const verdict =
        arm.considered === 0
          ? `${c.yellow}nothing to score — no document in the window passed the filter${c.reset}`
          : arm.nominated === 0
            ? `${c.red}would have nominated nothing${c.reset} ${c.dim}· best ${fixed(arm.best)} is ${fixed(arm.shortfall ?? 0)} under the threshold${c.reset}`
            : `${c.green}would have nominated ${arm.nominated}${c.reset} ${c.dim}of ${arm.considered}${c.reset}`;
      console.log(
        `  ${arm.nodeId} ${c.dim}(threshold ${fixed(arm.threshold)})${c.reset}  ${verdict}`,
      );
      if (arm.considered > 0) {
        console.log(
          `${c.dim}    scores: best ${fixed(arm.best)} · p95 ${fixed(arm.p95)} · median ${fixed(arm.median)}` +
            (arm.nextThreshold !== null
              ? ` · the next document down sits at ${fixed(arm.nextThreshold)}`
              : "") +
            `${c.reset}`,
        );
      }
      console.log(
        `${c.dim}    over ${arm.windowDays} day(s)${arm.capped ? ", capped — raise --limit for more" : ""}${c.reset}`,
      );
    }
    console.log(
      `${c.dim}\nNomination is not firing: a judge still decides. This is the arm that puts documents in front of it.${c.reset}`,
    );
  },
});

function fixed(value: number): string {
  return value.toFixed(3);
}

/**
 * The verdict, coloured by whether it asks for anything.
 *
 * Both the word and the asking are the gateway's, carried on the wire. A table
 * here would be a table of the verdicts this build was written against, so a
 * verdict a newer gateway learned to raise would print in the quiet colour —
 * which is the one direction that matters. An older gateway sends neither, and
 * the bare name in the quiet colour is what it always printed.
 */
function verdictLine(verdict: WatchVerdictLine): string {
  const label = verdict.label && verdict.label.length > 0 ? verdict.label : verdict.name;
  return `${verdict.actionable ? c.yellow : c.dim}${label} — ${verdict.because}${c.reset}`;
}

export function watchJudgeNeedsAttention(report: {
  judge: { loadable?: boolean };
  watches: readonly {
    status: string;
    judgeRequired?: boolean;
    pendingNominations: number;
  }[];
}): boolean {
  return (
    report.judge.loadable === false &&
    report.watches.some(
      (watch) =>
        watch.pendingNominations > 0 || (watch.status === "active" && watch.judgeRequired === true),
    )
  );
}

const reportCommand = defineCommand({
  meta: { name: "report", description: "The shadow period in one command" },
  async run() {
    const res = await withSpinner("Loading report", () => gw("/admin/watch/report"));
    if (!res.ok) throw gatewayError(res.status, await res.text(), true);
    const report = (await res.json()) as {
      journalHead: number;
      journalEvents: number;
      judge: {
        loadable?: boolean;
        reason?: string | null;
        calls: number;
        deferrals: number;
        errors: number;
      };
      health: {
        active: number;
        stopped: { total: number; failed: number; drifted: number; held: number; retired: number };
        liveness: {
          lastEvaluatedAt: string | null;
          lastEvaluatedAgeMs: number | null;
          journalHead: number;
          journalHeadAt: string | null;
          journalHeadAgeMs: number | null;
          staleAfterMs: number;
          stalled: boolean;
        };
        alarm: string | null;
      } | null;
      delivery: {
        dailyCap: number;
        perWatchDailyCap: number;
        attempted: number;
        /** Absent from a gateway older than the field. */
        degraded?: number;
      } | null;
      evaluation: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
      ontology: {
        tablesDescribed: number;
        tablesTotal: number;
        sourcesDescribed: number;
        sourcesTotal: number;
        unknownColumnKeys: string[];
        complete: boolean;
        regressed: boolean;
      } | null;
      watches: {
        name: string;
        status: string;
        note: string | null;
        judgeRequired?: boolean;
        firings: number;
        traceRecords: number;
        judge: { calls: number; deferrals: number };
        pendingNominations: number;
        verdict?: WatchVerdictLine | null;
        failure: { seq: number; nodeId: string; failure: string } | null;
        delivery: string | null;
        attemptedToday: number;
      }[];
    };

    if (isJSON) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`\n${c.bold}Watches — shadow period${c.reset}`);
    console.log(
      `${c.dim}journal: ${report.journalEvents} event(s), head ${report.journalHead}${c.reset}`,
    );
    console.log(
      `${c.dim}judge: ${report.judge.calls} call(s), ${report.judge.deferrals} deferred, ${report.judge.errors} error(s)${c.reset}`,
    );
    if (watchJudgeNeedsAttention(report)) {
      console.log(
        `${c.yellow}judge model: cannot be loaded — ${report.judge.reason ?? "check the watch-judge assignment and backend"}; semantic nominations remain parked${c.reset}`,
      );
    }
    // A stopped watch is silent, and silence is indistinguishable from nothing
    // having happened. Once a watch delivers, that difference is the whole
    // product — so the count leads the report rather than sitting in a note.
    // Only for an install that delivers. On a shadow-only one the line would
    // read "0 of 20" every day and train the reader to skip it.
    if (report.delivery && report.watches.some((w) => w.delivery !== null)) {
      const { attempted, dailyCap, degraded } = report.delivery;
      // A degrade is invisible in the count beside it — those notifications
      // went out and were accepted — so it is said here or nowhere.
      const lesser = degraded ? `, ${degraded} as a plain banner` : "";
      console.log(
        `${attempted >= dailyCap ? c.yellow : c.dim}notifications: ${attempted} of ${dailyCap} sent today${lesser}${c.reset}`,
      );
    }
    // The layer's own state, before any per-watch detail. This is the line the
    // report exists for: an install where nothing is evaluating looks exactly
    // like a quiet week from every other number on the page.
    // A gateway older than this CLI has no health block. That costs the reader
    // one section; reading through it would cost them the entire report.
    if (!report.health) {
      console.log(
        `${c.dim}this gateway does not report watch-layer health — update it to see whether anything is evaluating${c.reset}`,
      );
    } else {
      const { active, stopped, liveness, alarm } = report.health;
      console.log(
        `${stopped.total > 0 ? c.yellow : c.dim}watches: ${active} evaluating` +
          (stopped.total > 0 ? `, ${stopped.total} stopped (${describeStopped(stopped)})` : "") +
          `${c.reset}`,
      );
      console.log(
        `${liveness.stalled ? c.red : c.dim}last evaluated ${ago(liveness.lastEvaluatedAgeMs)} · ` +
          `journal head seq ${liveness.journalHead} ${ago(liveness.journalHeadAgeMs)}${c.reset}`,
      );
      if (alarm) console.log(`${c.red}${alarm}${c.reset}`);
      if (stopped.drifted > 0) {
        console.log(
          `${c.dim}· \`watch restamp\` re-validates every watch and resumes what still holds` +
            (stopped.held > 0
              ? ` — including the ${stopped.held} you held, so resume those deliberately instead`
              : "") +
            `${c.reset}`,
        );
      }
      if (stopped.failed > 0) {
        console.log(
          `${c.dim}· \`watch trace <name>\` for the message, ` +
            `\`watch resume <name> --skip\` to move past it${c.reset}`,
        );
      }
    }
    console.log(
      `${c.dim}evaluation: p50 ${report.evaluation.p50Ms}ms · p95 ${report.evaluation.p95Ms}ms · ` +
        `max ${report.evaluation.maxMs}ms over ${report.evaluation.samples} pass(es)${c.reset}`,
    );
    // How much of the install a watch can be written against. Printed as a
    // fraction rather than left to a log line, and coloured when it is short:
    // an install whose DSL cannot see most of its own tables should say so
    // where someone reading the week will notice.
    if (report.ontology) {
      const { tablesDescribed, tablesTotal, sourcesDescribed, sourcesTotal } = report.ontology;
      // A fall is louder than a shortfall. An install that has always been
      // short of full is a known limitation someone chose to live with; one
      // that described more yesterday than it does today has lost something,
      // and the fingerprint cannot say so — it is hashed before the parse that
      // does the losing.
      const colour = report.ontology.regressed
        ? c.red
        : report.ontology.complete
          ? c.dim
          : c.yellow;
      const unknown = report.ontology.unknownColumnKeys;
      // Named rather than counted, but not without limit: the list rides in a
      // report someone reads, and a source shipping a wide new column spec
      // should not push everything else off the screen.
      const named = unknown.slice(0, 8).join(", ");
      const rest = unknown.length > 8 ? ` and ${unknown.length - 8} more` : "";
      console.log(
        `${colour}ontology: ${tablesDescribed}/${tablesTotal} table(s) and ` +
          `${sourcesDescribed}/${sourcesTotal} source(s) describable${c.reset}` +
          (unknown.length > 0
            ? ` ${c.dim}· ${unknown.length} unmodelled column key(s): ${named}${rest}${c.reset}`
            : ""),
      );
      if (report.ontology.regressed) {
        console.log(
          `  ${c.red}coverage fell since this gateway started — part of the install ` +
            `stopped being addressable and no watch was paused for it${c.reset}`,
        );
      }
    } else {
      // Absence is what the log line this replaces amounted to. Say it instead.
      console.log(`${c.dim}ontology: not yet assembled${c.reset}`);
    }
    console.log("");
    for (const watch of report.watches) {
      console.log(`${c.bold}● ${watch.name}${c.reset} ${c.dim}${watch.status}${c.reset}`);
      console.log(
        `  ${watch.firings} firing(s) · ${watch.traceRecords} trace record(s) · ` +
          `judge ${watch.judge.calls} call(s), ${watch.judge.deferrals} deferred`,
      );
      // Only when there are any. A line reading "0 parked" on every watch
      // trains the reader to skip the line that matters.
      if (watch.pendingNominations > 0) {
        console.log(
          `  ${c.yellow}${watch.pendingNominations} nomination(s) parked, waiting on judge budget${c.reset}`,
        );
      }
      if (watch.delivery) {
        console.log(
          `  ${c.dim}delivers by ${watch.delivery} · ${watch.attemptedToday} sent today${c.reset}`,
        );
      }
      if (watch.failure) {
        console.log(
          `  ${c.red}stopped: a ${watch.failure.failure} failure in node ` +
            `'${watch.failure.nodeId}' at event ${watch.failure.seq}${c.reset}`,
        );
      }
      // Printed for every watch, including the ones that are fine: a line that
      // only spoke up about trouble would leave a reader unable to tell a watch
      // judged well from one nothing had looked at.
      if (watch.verdict) console.log(`  ${verdictLine(watch.verdict)}`);
      if (watch.note) console.log(`  ${c.dim}${watch.note}${c.reset}`);
    }
  },
});

export const watchCommand = defineCommand({
  meta: {
    name: "watch",
    description: "The watch runtime (experimental)",
  },
  subCommands: {
    list: listCommand,
    add: addCommand,
    rm: rmCommand,
    show: showCommand,
    restamp: restampCommand,
    pause: pauseCommand,
    resume: resumeCommand,
    try: preflightCommand,
    probe: probeCommand,
    deliver: deliverCommand,
    fire: fireCommand,
    firings: firingsCommand,
    trace: traceCommand,
    judge: judgeCommand,
    report: reportCommand,
  },
});
