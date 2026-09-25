// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The prompt's two properties: it is complete, and its expensive half never
 * changes.
 *
 * Completeness is not a nicety. A source, table, column or person the digest
 * omits is one the model will invent a name for, and the validator will then
 * reject the invention — a compiler failure caused by the prompt, scored
 * against the model.
 *
 * The static prefix matters for a different reason: every call in a run
 * repeats it, and a provider that caches a common prefix charges for it once
 * per run instead of once per turn. That only holds if the bytes are
 * identical, which is a property worth asserting rather than intending.
 */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { examplesFor } from "./examples.js";
import { loadLoops } from "./loops.js";
import {
  CORPUS_CONTENT_IS_DATA,
  OPERATIONAL_BOUNDS,
  promptPrefix,
  queryMessage,
  unparseableMessage,
  type CompilerContext,
} from "./prompt.js";
import { MODEL_REFUSAL_CODES } from "./refusal.js";

const ontology = loadOntology();

function context(withhold: readonly string[] = []): CompilerContext {
  return { ontology, loops: loadLoops(), examples: examplesFor(withhold) };
}

describe("the operational-bounds checklist, as an A/B arm", () => {
  it("is the only difference between the arms", () => {
    // Not "the off arm lacks this heading" and "some other headings survive" —
    // those hold for an arm that also dropped the worked examples. Deleting
    // exactly this block from the treatment must reproduce the control
    // character for character, which is the property an A/B rests on: whatever
    // separates the two arms is the thing being measured.
    const withBounds = promptPrefix(context())[0]!.content;
    const without = promptPrefix({ ...context(), operationalBounds: false })[0]!.content;

    expect(withBounds).toContain(OPERATIONAL_BOUNDS);
    expect(without, "the control carries the section it is meant to drop").not.toContain(
      OPERATIONAL_BOUNDS,
    );
    expect(
      withBounds.replace(`${OPERATIONAL_BOUNDS}\n\n`, ""),
      "the arms differ by something other than the checklist",
    ).toBe(without);
  });
});

describe("the static prefix", () => {
  it("is one message, so a cache can key on it", () => {
    const prefix = promptPrefix(context());
    expect(prefix).toHaveLength(1);
    expect(prefix[0]!.role).toBe("system");
  });

  it("is byte-identical between builds", () => {
    expect(promptPrefix(context())[0]!.content).toBe(promptPrefix(context())[0]!.content);
  });

  it("does not depend on the query, which is the whole point of the layout", () => {
    // The query is a separate message appended after the prefix. If any part of
    // it leaked into the prefix, every call would miss the cache.
    const prefix = promptPrefix(context())[0]!.content;
    const first = [...promptPrefix(context()), queryMessage("tell me about invoices")];
    const second = [...promptPrefix(context()), queryMessage("warn me about my heart rate")];
    expect(first[0]!.content).toBe(prefix);
    expect(second[0]!.content).toBe(prefix);
    expect(first.at(-1)!.content).not.toBe(second.at(-1)!.content);
  });
});

describe("the world the prefix describes", () => {
  const content = promptPrefix(context())[0]!.content;

  it("keeps propositions portable while allowing hosted disambiguation", () => {
    expect(content).toContain('{ "docId": "<the document\'s id>", "title"');
    expect(content).toContain("disambiguating context only");
    expect(content).toContain("same plan remains valid on every Watch host");
    expect(content).toContain("Do not infer ownership, authorship, tenancy, or relationships");
  });

  it("names every source, and says which can be matched semantically", () => {
    for (const id of ontology.sourceIds()) expect(content, id).toContain(id);

    // A `semantic_match` on an unindexed source can never fire, so the model
    // has to tell them apart before it writes one — which means both branches
    // have to be reachable and both have to be said. Printing "indexed" for
    // everything would actively mis-teach, and asserting only the positive
    // branch would not notice.
    const indexed = ontology.sourceIds().filter((id) => ontology.source(id)!.semanticallyIndexed);
    const unindexed = ontology
      .sourceIds()
      .filter((id) => !ontology.source(id)!.semanticallyIndexed);
    expect(indexed.length, "no source is indexed, so this asserts nothing").toBeGreaterThan(0);
    expect(unindexed.length, "every source is indexed, so this asserts nothing").toBeGreaterThan(0);

    const lineFor = (id: string) =>
      content.split("\n").find((line) => line.startsWith(`- ${id} `))!;
    for (const id of indexed) expect(lineFor(id), id).toContain("semantically indexed");
    for (const id of unindexed) expect(lineFor(id), id).toContain("NOT indexed");
  });

  it("names every analytics table and every column in it", () => {
    for (const table of ontology.tableNames()) {
      expect(content, table).toContain(table);
      for (const column of ontology.table(table)!.columns) {
        expect(content, `${table}.${column.name}`).toContain(column.name);
      }
    }
  });

  it("names every declared metadata path and person role", () => {
    for (const id of ontology.sourceIds()) {
      const profile = ontology.source(id)!.profile;
      for (const field of profile.metadataFields ?? []) {
        expect(content, `${id} metadata.${field.path}`).toContain(`metadata.${field.path}`);
      }
      for (const role of profile.personRoles ?? [])
        expect(content, `${id} ${role}`).toContain(role);
    }
  });

  it("names every unmerged person by id, since a DSL carries ids and not names", () => {
    for (const person of ontology.snapshot.people) {
      if (person.mergedInto !== null) continue;
      expect(content, person.canonicalName).toContain(person.id);
    }
  });

  it("marks the user, so the inbound and outbound idioms can be written", () => {
    const self = ontology.snapshot.people.find((p) => p.isSelf)!;
    expect(content).toContain(`${self.id} ${self.canonicalName} `);
  });

  it("lists the loops that can be bound by id", () => {
    for (const loop of loadLoops()) expect(content).toContain(loop.loopId);
  });

  it("states the closed values an analytics column declares", () => {
    // Without them the model guesses at an enum and the validator rejects the
    // guess, which is a prompt failure wearing a model failure's clothes.
    const closed = ontology
      .tableNames()
      .flatMap((t) => ontology.table(t)!.columns)
      .flatMap((c) => c.allowedValues ?? c.canonicalValues ?? []);
    expect(closed.length, "the ontology declares no closed values at all").toBeGreaterThan(0);
    for (const value of closed) expect(content, value).toContain(value);
  });

  it("states the phrasings a metadata field declares, so a request's words map to a value", () => {
    // A phrasing the compiler never sees has to be guessed against a list of
    // values it does not resemble.
    const spoken = ontology
      .sourceIds()
      .flatMap((id) => ontology.source(id)!.profile.metadataFields ?? [])
      .flatMap((f) => Object.entries(f.valueAliases ?? {}));
    expect(spoken.length, "no metadata field declares phrasings").toBeGreaterThan(0);
    for (const [value, aliases] of spoken) {
      for (const alias of aliases) expect(content, alias).toContain(`"${alias}"`);
      expect(content, value).toContain(`→ ${value}`);
    }
  });

  it("states the closed values a metadata field declares", () => {
    // Asserted separately from the column case: they are rendered by different
    // code, and the two used to be checked by one loop that only walked tables.
    const closed = ontology
      .sourceIds()
      .flatMap((id) => ontology.source(id)!.profile.metadataFields ?? [])
      .flatMap((f) => f.allowedValues ?? f.canonicalValues ?? []);
    expect(closed.length, "no metadata field declares closed values").toBeGreaterThan(0);
    for (const value of closed) expect(content, value).toContain(value);
  });
});

describe("worked examples", () => {
  it("shows every corpus watch with the request it came from", () => {
    const examples = examplesFor();
    expect(examples.length).toBeGreaterThan(10);
    const content = promptPrefix(context())[0]!.content;
    for (const example of examples) {
      expect(content, example.name).toContain(example.nlQuery);
      expect(content, example.name).toContain(`"name": "${example.name}"`);
    }
  });

  it("withholds the one being compiled, so a paired score is not a lookup", () => {
    const held = "important-email-unanswered";
    const content = promptPrefix(context([held]))[0]!.content;
    expect(content).not.toContain(`"name": "${held}"`);
    expect(content).not.toContain(examplesFor().find((e) => e.name === held)!.nlQuery);
    // The rest are still there — withholding one must not empty the prompt.
    expect(content).toContain('"name": "restaurant-budget-500"');
  });
});

describe("the person directory a real install can afford to show", () => {
  // The whole directory is what a universe wants and what an install cannot
  // have: fifty thousand people rendered into the prefix put one request at
  // roughly 780,000 tokens, and the model answered with a bare 400.
  const invented = [
    { id: "8f14e45f-ceea-467a-9575-1e0b4f5a3c11", canonicalName: "Maya Reeves" },
    { id: "c9f0f895-fb98-4b1f-9f61-1c2b3d4e5f60", canonicalName: "Jamie Lopez" },
  ].map((p) => ({ ...p, aliases: [], isSelf: false, mergedInto: null }));

  const peopleSection = (text: string): string =>
    text.slice(text.indexOf("## People directory"), text.indexOf("## Open loops"));

  it("names the people it was handed instead of the whole ontology", () => {
    // Asserted against the section rather than the whole prefix: a worked
    // example is a real watch and carries the ids of the cast it was written
    // about, so those ids appear downstream whatever the directory says.
    const section = peopleSection(promptPrefix({ ...context(), people: invented })[0]!.content);

    for (const person of invented) expect(section, person.canonicalName).toContain(person.id);
    const universeCast = ontology.snapshot.people.filter((p) => p.mergedInto === null);
    expect(
      universeCast.length,
      "the fixture cast is empty, so this asserts nothing",
    ).toBeGreaterThan(0);
    for (const person of universeCast) {
      expect(section, `${person.canonicalName} was not in the selection`).not.toContain(person.id);
    }
  });

  it("still shows the whole directory when a caller names no selection", () => {
    // A universe passes nothing and must keep the behaviour it was measured
    // with — the bound belongs to installs, not to the compiler.
    const content = promptPrefix(context())[0]!.content;

    for (const person of ontology.snapshot.people) {
      if (person.mergedInto === null) expect(content, person.canonicalName).toContain(person.id);
    }
  });

  it("changes nothing else about the prefix", () => {
    // The selection is one section. If narrowing it also moved a table, a
    // column or an example, the prefix would stop being comparable between an
    // install and the universe the compiler was measured on.
    const full = promptPrefix(context())[0]!.content;
    const narrowed = promptPrefix({ ...context(), people: invented })[0]!.content;

    expect(peopleSection(full)).not.toBe(peopleSection(narrowed));
    expect(full.replace(peopleSection(full), "")).toBe(
      narrowed.replace(peopleSection(narrowed), ""),
    );
  });
});

describe("a compiler that can look things up", () => {
  const withTools = () =>
    promptPrefix({ ...context(), retrieval: ["lookup_people", "search_many"] })[0]!.content;

  it("says nothing about tools when the host attached none", () => {
    // A universe compile hands over one shot of text. Told it may look things
    // up while holding no tools, a compiler spends its turn calling functions
    // that do not exist.
    expect(promptPrefix(context())[0]!.content).not.toContain("# Finding out");
  });

  it("names what it may call, so it does not invent a tool", () => {
    expect(withTools()).toContain("lookup_people, search_many");
  });
});

describe("what the compiler is told about the text it reads", () => {
  /**
   * Stated whether or not tools are attached. Even a single-shot compile is
   * shown corpus-derived strings — person names, loop titles — in the digest,
   * so the rule cannot ride on the retrieval section.
   */
  const always = (): string => promptPrefix(context())[0]!.content;

  it("carries the prompt-injection rule", () => {
    // The whole rule, not its first sentence: what makes it useful is the list
    // of what counts as untrusted and the prohibition on routing any of it
    // onward, and a prompt that kept only the heading would still pass a
    // prefix check while the drift test stayed green on an unused constant.
    expect(always()).toContain(CORPUS_CONTENT_IS_DATA);
  });
});

describe("what a refusal may say", () => {
  const content = (): string => promptPrefix(context())[0]!.content;

  it("asks for a code from the closed vocabulary", () => {
    // The codes are the only part of a refusal an off-host caller is shown, so
    // a compiler that did not know to emit one leaves every refusal reaching
    // that caller as the general case.
    const text = content();
    expect(text).toContain('"codes": ["..."]');
    for (const code of MODEL_REFUSAL_CODES) expect(text).toContain(`\`${code}\``);
  });

  it("restates the whole grammar when a reply could not be read", () => {
    // The recovery path, which only runs after a malformed reply and is
    // therefore the least-observed message in the system. It restated `reasons`
    // without `codes`, so a compile that recovered came back as a refusal the
    // caller could not be told anything about: the codes are the only part an
    // off-host caller is shown.
    const recovery = unparseableMessage("trailing prose after the fence").content;

    expect(recovery).toContain('"decision": "refuse"');
    expect(recovery, "the recovery grammar drops the field a caller is shown").toContain('"codes"');
  });

  it("never offers the model the code that means 'try again'", () => {
    // `compiler_failed` is the host's, for a compile that produced nothing
    // legal after its repairs. Offered to the model, a deliberate refusal comes
    // back telling the caller to retry — and an agent retrying a settled
    // decision retries it forever, at a full compile each time.
    expect(content()).not.toContain("compiler_failed");
  });
});

describe("the judgement refusals the contract names", () => {
  const content = promptPrefix(context())[0]!.content;

  /**
   * Every failure the first eval found on this axis was a request the compiler
   * COULD write and should not have. The substrate-shaped duties were already
   * in the contract and were obeyed; these four were not stated at all, so the
   * model read the ontology clauses as the whole of it.
   */
  /**
   * Each duty, with a phrase only its own paragraph says.
   *
   * The `says` half is what makes the rest of this describe a contract rather
   * than four anonymous paragraphs. Without it the assertions pin arity, codes
   * and example count — every one of which survives replacing a duty's body
   * with a copy of another's, or swapping two duties, since the two duties that
   * share `unsupported_condition` are indistinguishable by code. The contract
   * could lose one of the four failures the eval measures with the suite green.
   */
  const DUTIES = [
    {
      what: "an ambiguous referent",
      code: "ambiguous_request",
      says: "Do not pick the most active one",
    },
    {
      what: "no checkable condition",
      code: "not_a_condition",
      says: "A proxy is not the request",
    },
    {
      what: "a source the install does not run",
      code: "unsupported_condition",
      says: "absent from the install",
    },
    {
      what: "a direction the documents cannot carry",
      code: "unsupported_condition",
      says: "needs a per-message sender",
    },
  ] as const;

  /**
   * The section, split into one string per numbered duty.
   *
   * Every assertion about a duty has to be made inside its own paragraph.
   * Searching the whole prompt for a code proves nothing: the reply grammar
   * interpolates all of `MODEL_REFUSAL_CODES` in backticks unconditionally, so
   * a whole-prompt `toContain` passed with this entire section deleted, and
   * passed again with every duty's code swapped for another duty's.
   */
  function duties(text = content): string[] {
    return judgementSection(text)
      .slice(0, judgementSection(text).indexOf("## And the reverse duty"))
      .split(/(?=\*\*\d\. )/)
      .slice(1);
  }

  /**
   * The four duties and the reverse duty, and nothing else.
   *
   * Counting worked examples over the whole prompt is satisfiable from outside:
   * the DSL walkthrough carries its own prose, and a `Wrong:`/`Right:` pair
   * added anywhere would let this section lose its only non-refusal example
   * while the arithmetic still came out right.
   */
  function judgementSection(text = content): string {
    const start = text.indexOf("Four requests you must refuse");
    const end = text.indexOf("`codes` is required when you refuse");
    expect(start, "the judgement-refusal section is gone").toBeGreaterThanOrEqual(0);
    expect(end, "the section no longer ends at the reply grammar").toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it("states all four, each mapped to a code the vocabulary already has", () => {
    // No new externally visible code: a code naming which sources are connected
    // would fingerprint the install for the one caller that cannot search.
    expect(content).toContain(
      "Four requests you must refuse even though you could write something",
    );
    const paragraphs = duties();
    expect(paragraphs, "the closed set changed size").toHaveLength(4);
    for (const [index, duty] of DUTIES.entries()) {
      expect(paragraphs[index], `${duty.what}: wrong or missing code`).toContain(
        `\`${duty.code}\``,
      );
      expect(paragraphs[index], `${duty.what}: this duty is no longer about that`).toContain(
        duty.says,
      );
    }
  });

  it("keeps each duty's code out of the duties it does not belong to", () => {
    // The discriminating half of the test above. `ambiguous_request` and
    // `not_a_condition` each belong to exactly one duty, so a swap between them
    // — the mistake a whole-prompt search cannot see — has to redden here.
    const paragraphs = duties();
    const owners = (code: string): number[] =>
      paragraphs.flatMap((p, i) => (p.includes(`\`${code}\``) ? [i] : []));

    expect(owners("ambiguous_request"), "the ambiguity code moved or spread").toEqual([0]);
    expect(owners("not_a_condition"), "the no-condition code moved or spread").toEqual([1]);
  });

  it("gives each one a worked wrong answer, not just a rule", () => {
    // The failures were all near-misses — a watch that reads correctly from
    // every angle except the asker's. A rule without the tempting wrong answer
    // beside it is one the model can satisfy while doing the wrong thing.
    // One per judgement refusal, and at least one for the reverse duty — whose
    // wrong answer is refusing rather than compiling. Without that last one the
    // strongest signals in the section all point one way, and fixing the
    // over-compiling makes the over-refusing worse.
    const section = judgementSection();
    const wrongs = section.match(/^ {4}Wrong: /gm) ?? [];
    const refusals = section.match(/^ {4}Right: refuse/gm) ?? [];

    expect(refusals, "a judgement refusal lost its worked example").toHaveLength(DUTIES.length);
    // A floor, not a ratio. The exact balance is a judgement nobody has evidence
    // for yet — the re-run is what will say whether the section still leans too
    // far toward refusing — and a test that pins today's arity would have to be
    // edited before that evidence could be acted on.
    expect(
      wrongs.length - refusals.length,
      "every worked example points at refusing, which is the thumb on the scale this section already had",
    ).toBeGreaterThanOrEqual(1);
  });

  it("states each example as a shape rather than as a request", () => {
    // A contract that quotes a request and attaches its verdict teaches that
    // request. Three of these examples were, in an earlier draft, near-verbatim
    // paraphrases of cases in the eval that measures this very boundary — one of
    // them from the HOLDOUT, which exists to be unseen by the fix and would have
    // scored a memorised answer as a generalised one.
    //
    // The placeholder is a proxy for the rule, not the rule: it catches a
    // wholesale quotation, which is how this went wrong, and it would pass an
    // otherwise-verbatim request with one word bracketed. The eval's cases live
    // outside this repo, so no in-tree test can do better — a reader who wants
    // certainty has to diff the examples against the case files by hand.
    const asked =
      judgementSection().match(/^ {4}Asked: .*(?:\n {4}(?! *(?:Wrong|Right):).*)*/gm) ?? [];

    expect(asked, "the worked examples went missing").toHaveLength(5);
    for (const line of asked) {
      expect(line, "a worked example quotes a request instead of naming its shape").toMatch(
        /<[^>]+>/,
      );
    }
  });

  it("states the reverse duty, so a hard binding is not grounds to refuse", () => {
    // Three compilable requests were refused over bindings the tools could have
    // settled. Without this the fix for one direction makes the other worse.
    const flat = content.replace(/\s+/g, " ");
    expect(flat).toContain("a hard binding is not a refusal");
    expect(flat).toContain("Refusing because a binding took effort is the mirror of the error");
  });

  it("tells a compiler to use its tools only where it has some", () => {
    // A compile with no tools — a universe run, or a host that hands over one
    // shot of text — must not be told to look things up: it would spend its
    // turn calling functions that do not exist. So the duty is stated twice,
    // once without tools and once with, and only the second names them.
    const withTools = promptPrefix({
      ...context(),
      retrieval: ["lookup_people", "search_many"],
    })[0]!.content.replace(/\s+/g, " ");
    const withoutTools = content.replace(/\s+/g, " ");

    expect(withTools).toContain("a binding you have not yet resolved is a lookup, not grounds");
    expect(withoutTools).not.toContain("is a lookup, not grounds");
  });

  it("does not license, elsewhere, the substitution the direction duty forbids", () => {
    // The contract is long and had already answered this question the other
    // way: "where a source does not declare `sender`, the nearest role it does
    // declare is the honest substitute" sat forty lines below the new duty, and
    // later in the same system message, which is the position recency favours.
    // A contract that says two things is worse than one that says one badly.
    const flat = content.replace(/\s+/g, " ");

    // Adjacent, not merely both present. The contradiction this prevents is a
    // local one — a reader reaches the substitute rule and acts on it — so a
    // carve-out that drifted into another section would leave the rule reading
    // exactly as it did when it licensed the wrong answer, with the test green.
    // Anchored at both ends of the carve-out's own sentence, because a tail is
    // all an exception needs: "…at all, except where nothing better exists"
    // restores the licence verbatim, and a pattern that only pins the opening
    // and the following period admits it. Pinning the categorical close —
    // "at all." — is what makes the sentence unhedgeable.
    expect(flat).toMatch(
      /the nearest role it does declare is the honest substitute[^.]*\.\s*It is not a substitute for direction[^.]*cannot be written against a source without `sender` at all\.\s*Refuse it/,
    );
  });

  it("does not route the no-condition duty's own example to the investigation", () => {
    // The escape hatch's discriminator — refuse when the data is absent, reach
    // for the investigation when only the trip-wire is — sent a request for a
    // verdict on a trajectory to an investigation, which is precisely the wrong
    // answer the second duty names. The two rules now share one line: what the
    // request names, stated with the same placeholder in both places so they
    // cannot drift apart.
    const flat = content.replace(/\s+/g, " ");
    const shape = "<a verdict on how the asker is doing overall>";

    expect(flat).toContain("refuse when there is no **event** to hang a trip-wire on");
    expect(flat).toContain(`"${shape}" names no event at all`);
    expect(
      duties()[1],
      "the no-condition duty and the escape hatch no longer describe the same shape",
    ).toContain(shape);
  });

  it("never asks the model to count what it found", () => {
    // The reasons rule forbids counting anything in the corpus, and an
    // ambiguity refusal is exactly where a count is tempting: "six people match"
    // is a corpus fact, and the operator does not need it to disambiguate.
    // Read with newlines flattened: the contract is prose wrapped at 80
    // columns, so an assertion on a phrase would break on a reflow rather than
    // on a change of meaning.
    const flat = content
      .slice(content.indexOf("Four requests you must refuse"))
      .replace(/\s+/g, " ");
    expect(flat).toContain("Never say how many candidates there were");
  });
});
