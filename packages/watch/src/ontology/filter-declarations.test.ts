// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source's filter declarations change nothing a watch can see.
 *
 * A profile may mark a metadata field as one an access filter can match on,
 * and declare how a filter matches people. Sources gain those declarations
 * over time, on profiles watches were already compiled against. So every case
 * here holds the same watch against the same ontology twice, once with the
 * declarations and once without, and asks for the same bytes: the same prompt,
 * the same validation, the same compilation, and the same hashes, because a
 * hash that moved would pause the watch for a change it cannot observe.
 *
 * Fixture data is invented — no corpus content.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../compiler/compile.js";
import { examplesFor } from "../compiler/examples.js";
import { loadLoops } from "../compiler/loops.js";
import { ScriptedModel } from "../compiler/model.js";
import { ontologyDigest } from "../compiler/ontology-digest.js";
import { promptPrefix } from "../compiler/prompt.js";
import { loadOntology, universeDir } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { canonicalJson, declaredSource } from "./canonical.js";
import { RecordingOntology } from "./recording.js";
import { Ontology } from "./snapshot.js";

const plain = loadOntology();

interface RawSource {
  sourceId: string;
  profile: {
    personRoles?: string[];
    metadataFields?: Record<string, unknown>[];
    personFilter?: unknown;
  };
}

/** The raw snapshot with every string field marked filterable and every profile given a person filter. */
function annotatedSnapshot(): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(plain.snapshot)) as { sources: RawSource[] };
  for (const source of copy.sources) {
    for (const field of source.profile.metadataFields ?? []) {
      if (field["type"] !== "string" && field["type"] !== "string-array") continue;
      field["filter"] = {
        capability: "tree",
        minVersion: 2,
        scope: "global",
        noun: { one: "folder", many: "folders" },
        levels: [{ one: "drive", many: "drives" }],
        picker: "tree",
        inside: { one: "folder", many: "folders" },
        listsMembers: true,
      };
    }
    source.profile.personFilter = {
      minVersion: 0,
      roles: (source.profile.personRoles ?? []).filter((role) => role !== "mentioned"),
      identifiers: ["phone", "email"],
      maxPeople: 1000,
    };
  }
  return copy;
}

const annotated = Ontology.parse(annotatedSnapshot());

const WATCHES = readdirSync(join(universeDir(), "watches"))
  .filter((file) => file.endsWith(".json"))
  .sort();

function watchFile(file: string): unknown {
  return JSON.parse(readFileSync(join(universeDir(), "watches", file), "utf8"));
}

describe("the fixture", () => {
  it("really carries the declarations it claims to", () => {
    const fields = annotated
      .sourceIds()
      .flatMap((id) => annotated.source(id)!.profile.metadataFields ?? []);
    expect(fields.filter((field) => field.filter !== undefined).length).toBeGreaterThan(3);
    expect(
      annotated.sourceIds().every((id) => annotated.source(id)!.profile.personFilter !== undefined),
    ).toBe(true);
    expect(
      plain.sourceIds().flatMap((id) => plain.source(id)!.profile.metadataFields ?? []),
    ).toSatisfy((all: { filter?: unknown }[]) => all.every((field) => field.filter === undefined));
  });
});

describe("what the compiler is shown", () => {
  it("is the same ontology digest", () => {
    expect(ontologyDigest(annotated, [])).toBe(ontologyDigest(plain, []));
  });

  it("is the same prompt prefix", () => {
    const context = { loops: loadLoops(), examples: examplesFor(["important-email-unanswered"]) };
    expect(promptPrefix({ ...context, ontology: annotated })).toEqual(
      promptPrefix({ ...context, ontology: plain }),
    );
  });
});

describe("every corpus watch", () => {
  it.each(WATCHES)("%s validates the same and consults the same surface", (file) => {
    const watch = watchFile(file);
    const before = new RecordingOntology(plain);
    const after = new RecordingOntology(annotated);

    expect(validateWatch(watch, after)).toEqual(validateWatch(watch, before));
    expect(after.digest()).toBe(before.digest());
  });

  it("compiles to the same result", async () => {
    const name = "mum-call-rhythm-stopped";
    const watch = (watchFile(`${name}.json`) as { watch: unknown }).watch;
    const reply = "```json\n" + JSON.stringify({ decision: "compile", watch }) + "\n```";
    const context = { loops: loadLoops(), examples: examplesFor(["important-email-unanswered"]) };

    const before = await compile(
      "anything",
      { ...context, ontology: plain },
      new ScriptedModel([reply]),
    );
    const after = await compile(
      "anything",
      { ...context, ontology: annotated },
      new ScriptedModel([reply]),
    );

    expect(before.status).toBe("compiled");
    expect(after).toEqual(before);
  });
});

describe("the declared half of a source, which both ontology hashes are taken over", () => {
  const source = {
    sourceId: "fictional-files",
    semanticallyIndexed: true,
    profile: {
      documentTypes: ["file"],
      personRoles: ["owner"],
      metadataFields: [{ path: "extra.folderId", type: "string", description: "Folder id." }],
    },
  };

  function withFilters(): typeof source {
    const copy = JSON.parse(JSON.stringify(source)) as typeof source;
    Object.assign(copy.profile.metadataFields[0]!, {
      filter: { capability: "tree", minVersion: 2, scope: "global" },
    });
    Object.assign(copy.profile, {
      personFilter: { minVersion: 0, roles: ["owner"], identifiers: ["email"] },
    });
    return copy;
  }

  it("is byte-identical with and without filter declarations", () => {
    expect(canonicalJson(declaredSource(withFilters()))).toBe(
      canonicalJson(declaredSource(source)),
    );
  });

  it("is the profile untouched when there is nothing to leave out", () => {
    expect(canonicalJson(declaredSource(source))).toBe(
      canonicalJson({
        sourceId: source.sourceId,
        semanticallyIndexed: true,
        profile: source.profile,
      }),
    );
  });

  it("still moves for any other key a field or a profile gains", () => {
    const grownField = JSON.parse(JSON.stringify(source)) as typeof source;
    Object.assign(grownField.profile.metadataFields[0]!, { unit: "bytes" });
    const grownProfile = JSON.parse(JSON.stringify(source)) as typeof source;
    Object.assign(grownProfile.profile, { retention: "complete" });

    const base = canonicalJson(declaredSource(source));
    expect(canonicalJson(declaredSource(grownField))).not.toBe(base);
    expect(canonicalJson(declaredSource(grownProfile))).not.toBe(base);
  });

  it("passes through a profile that is not an object", () => {
    expect(declaredSource({ ...source, profile: null })).toEqual({
      sourceId: source.sourceId,
      semanticallyIndexed: true,
      profile: null,
    });
  });
});

describe("a declaration this build cannot read", () => {
  /** One source whose field and profile declare something from a later contract. */
  function snapshotWith(filter: unknown, personFilter: unknown): unknown {
    return {
      fingerprint: "an-install-fingerprint",
      sources: [
        {
          sourceId: "fictional-files",
          providerId: "fictional",
          semanticallyIndexed: true,
          profile: {
            documentTypes: ["file"],
            personRoles: ["owner"],
            metadataFields: [
              { path: "extra.folderId", type: "string", description: "Folder id.", filter },
            ],
            personFilter,
          },
        },
      ],
      unwatchableSources: [],
      analyticsTables: [],
      people: [],
    };
  }

  it("does not cost the source its place in the ontology", () => {
    const parsed = Ontology.parse(
      snapshotWith(
        { capability: "date-range", minVersion: 3, from: "extra.sentAt" },
        { minVersion: 0, roles: ["owner"], identifiers: ["handle"] },
      ),
    );

    const source = parsed.source("fictional-files");
    expect(source, "an unreadable filter declaration dropped its source").toBeDefined();
    expect(source!.profile.metadataFields?.[0]?.path).toBe("extra.folderId");
    expect(source!.profile.metadataFields?.[0]?.filter).toBeUndefined();
    expect(source!.profile.personFilter).toBeUndefined();
  });

  it("is kept when this build can read it", () => {
    const filter = {
      capability: "membership",
      minVersion: 1,
      scope: "device",
      noun: { one: "folder", many: "folders" },
      picker: "search",
    };
    const personFilter = { minVersion: 0, roles: ["owner"], identifiers: ["email", "domain"] };
    const source = Ontology.parse(snapshotWith(filter, personFilter)).source("fictional-files")!;

    expect(source.profile.metadataFields?.[0]?.filter).toEqual(filter);
    expect(source.profile.personFilter).toEqual(personFilter);
  });
});
