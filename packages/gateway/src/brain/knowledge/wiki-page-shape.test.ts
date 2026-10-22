// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import {
  assertSubjectTitle,
  chronologicalLogGrowth,
  chronologicalLogRefusal,
  headingNamesDate,
  wikiSectionShape,
} from "./wiki-page-shape.js";
import { KnowledgeStorageError } from "./types.js";

const page = (overview: string, headings: string[]) =>
  [overview, "", ...headings.flatMap((heading) => [`## ${heading}`, "", "Body.", ""])].join("\n");

describe("headingNamesDate", () => {
  it.each([
    "7 September validation failures",
    "21–24 August deployment snapshot",
    "September 7 outage",
    "Aug 24th alerts",
    "August 2026 statements",
    "Alerts on 2026-09-07",
    "Parcel updates 07/09/2026",
    "1er août : livraison",
    "Lieferungen am 3. März",
    "Alertas del 5 de mayo",
    "Avvisi del 12 settembre",
    "Meldingen van 4 mei",
  ])("dates %j", (heading) => expect(headingNamesDate(heading)).toBe(true));

  it.each([
    "Current status",
    "Recurring failures",
    "2026 budget",
    "Q4 review",
    "May deploys need approval",
    "Version 2.4.1 changes",
    "Top 10 checks",
    "Billing account",
  ])("does not date %j", (heading) => expect(headingNamesDate(heading)).toBe(false));
});

describe("wikiSectionShape", () => {
  it("reads level 2–6 headings outside fenced code", () => {
    const shape = wikiSectionShape(
      [
        "# Title line",
        "## Current state",
        "### 3 March alert",
        "```",
        "## 4 March not a heading",
        "```",
        "#### Patterns ##",
      ].join("\n"),
    );
    expect(shape.headings).toEqual(["Current state", "3 March alert", "Patterns"]);
    expect(shape.dated).toEqual(["3 March alert"]);
  });
});

describe("chronologicalLogGrowth", () => {
  const three = page("Overview.", ["3 March failures", "4 March recovery", "5 March failures"]);

  it("refuses the save that adds another dated section to a mostly dated page", () => {
    const next = page("Overview.", [
      "3 March failures",
      "4 March recovery",
      "5 March failures",
      "6 March recovery",
    ]);
    expect(chronologicalLogGrowth(three, next)).toEqual({
      added: ["6 March recovery"],
      dated: 4,
      sections: 4,
    });
  });

  it("allows an in-place update that keeps the number of dated sections", () => {
    const next = three.replace("Overview.", "Overview, updated with the 6 March recovery.");
    expect(chronologicalLogGrowth(three, next)).toBeNull();
    const renamed = three.replace("5 March failures", "5–6 March failures and recovery");
    expect(chronologicalLogGrowth(three, renamed)).toBeNull();
  });

  it("allows a consolidation that lowers the number of dated sections", () => {
    const next = page("Overview.", ["Current state", "Recurring causes", "6 March recovery"]);
    expect(chronologicalLogGrowth(three, next)).toBeNull();
  });

  it("allows dated sections that stay a minority or below the floor", () => {
    const subject = page("Overview.", [
      "Current state",
      "Recurring causes",
      "Owners",
      "Escalation",
      "3 March failures",
      "4 March recovery",
      "5 March failures",
    ]);
    const grown = subject + "\n## 6 March recovery\n\nBody.\n";
    expect(chronologicalLogGrowth(subject, grown)).toBeNull();
    const small = page("Overview.", ["3 March failures", "4 March recovery"]);
    expect(chronologicalLogGrowth(small, small + "\n## 5 March failures\n\nBody.\n")).toBeNull();
  });

  it("never applies to a new page", () => {
    const next = page("Overview.", ["1 May", "2 May", "3 May", "4 May"]);
    expect(chronologicalLogGrowth(null, next)).toBeNull();
  });

  it("refuses with guidance to update the current state in place", () => {
    const error = chronologicalLogRefusal({ added: ["6 March recovery"], dated: 4, sections: 4 });
    expect(error).toBeInstanceOf(KnowledgeStorageError);
    expect(error.code).toBe("claim_invalid");
    expect(error.message).toContain('["6 March recovery"]');
    expect(error.message).toContain("4 of the page's 4 sections");
    expect(error.message).toContain("in place");
    expect(error.message).toContain("queued for a whole-page review");
  });
});

describe("assertSubjectTitle", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT)");
    const insert = db.prepare("INSERT INTO documents (id,title) VALUES (?,?)");
    insert.run("booking", "Confirmation de votre séjour au Domaine des Hêtres");
    insert.run("issue", "[example/atlas] Nightly build fails on runner timeouts (Issue #42)");
    insert.run("note", "Kitchen renovation");
    insert.run("thread", "Re: Lakeside unit lease renewal — signed copy attached");
  });
  afterEach(() => db.close());

  const cited = (...ids: string[]) =>
    parseClaimMarkup(
      `<claim id="a" refs="${ids.map((id) => `source:${id}`).join(" ")}">Text.</claim>`,
    );
  const check =
    (title: string, ids: string[], expectedRevision = 0, previous: string | null = null) =>
    () =>
      assertSubjectTitle(db, { title, expectedRevision }, cited(...ids), previous);

  it("refuses a new title that repeats a cited document's subject line", () => {
    expect(check("Confirmation de votre séjour au Domaine des Hêtres", ["booking"])).toThrow(
      /repeats the title of cited source booking/,
    );
    expect(
      check("Nightly build fails on runner timeouts · example/atlas#42", ["issue", "note"]),
    ).toThrow(KnowledgeStorageError);
  });

  it("refuses a changed title that repeats one, but not an unchanged one", () => {
    const title = "Confirmation de votre séjour au Domaine des Hêtres";
    expect(check(title, ["booking"], 3, "Domaine des Hêtres stay")).toThrow(KnowledgeStorageError);
    expect(check(title, ["booking"], 3, title)).not.toThrow();
  });

  it("allows a name for the subject", () => {
    expect(check("August 2026 stay at the Domaine des Hêtres", ["booking"])).not.toThrow();
    expect(check("Atlas nightly build pipeline", ["issue"])).not.toThrow();
    expect(check("Lakeside unit lease renewal", ["thread"])).not.toThrow();
  });

  it("never compares a short title, or a document the page does not cite", () => {
    expect(check("Kitchen renovation", ["note"])).not.toThrow();
    expect(check("Confirmation de votre séjour au Domaine des Hêtres", ["issue"])).not.toThrow();
  });
});
