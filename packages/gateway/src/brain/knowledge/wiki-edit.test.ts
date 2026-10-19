// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import { applyWikiEdits, listWikiHeadings, WikiEditError, type WikiEditOp } from "./wiki-edit.js";

/** A page laid out the way the authoring guidance asks: one claim per section. */
const PAGE = [
  '<claim id="overview" refs="source:doc-a">',
  "The community garden runs three raised beds and a seed library.",
  "</claim>",
  "",
  '<claim id="beds" refs="source:doc-a">',
  "## Beds",
  "",
  "Three raised beds sit along the south fence.",
  "</claim>",
  '<claim id="bed-soil" refs="source:doc-b">',
  "### Soil",
  "",
  "Each bed was refilled with 40 litres of compost.",
  "</claim>",
  "",
  '<claim id="costs" refs="source:doc-b">',
  "## Costs",
  "",
  "The annual plot fee is 25 credits.",
  "</claim>",
  "",
  '<claim id="seeds" refs="source:doc-c">',
  "## Seed library",
  "",
  "Members may borrow two packets a month.",
  "</claim>",
  "",
].join("\n");

const apply = (markdown: string, ...edits: WikiEditOp[]) => applyWikiEdits(markdown, edits);
const refusal = (markdown: string, ...edits: WikiEditOp[]): WikiEditError => {
  try {
    applyWikiEdits(markdown, edits);
  } catch (error) {
    if (error instanceof WikiEditError) return error;
    throw error;
  }
  throw new Error("expected the edit to be refused");
};
const claimIds = (markdown: string) => parseClaimMarkup(markdown).claims.map((claim) => claim.id);

describe("listWikiHeadings", () => {
  it("finds headings at every level, inside or after claim tags, never in fenced code", () => {
    const markdown = [
      "# Title",
      '<claim id="a" refs="">## Inline ## </claim>',
      "```",
      "## Not a heading",
      "```",
      "~~~~",
      "# Also not",
      "~~~",
      "still code",
      "~~~~",
      "#### Deep",
      "#hashtag is not a heading",
      "#",
    ].join("\n");
    expect(listWikiHeadings(markdown).map((heading) => heading.label)).toEqual([
      "# Title",
      "## Inline",
      "#### Deep",
    ]);
  });

  it("reads CRLF lines and trailing whitespace off heading text", () => {
    expect(listWikiHeadings("## Costs   \r\nbody\r\n### Fees\t\r\n")).toMatchObject([
      { label: "## Costs", lineStart: 0 },
      { label: "### Fees", lineStart: 19 },
    ]);
  });
});

describe("listWikiHeadings around claim tags and code", () => {
  it("treats a fence that carries claim tags as a fence", () => {
    const markdown = [
      '<claim id="a" refs="">```sh',
      "# a shell comment",
      "```</claim>",
      "## Real",
    ].join("\n");
    expect(listWikiHeadings(markdown).map((heading) => heading.label)).toEqual(["## Real"]);
  });

  it("never reads an indented code line as a heading", () => {
    expect(listWikiHeadings("    # not a heading\n   ### Shallow")).toMatchObject([
      { label: "### Shallow" },
    ]);
  });

  it("names a heading without the claim tags around or inside it", () => {
    const markdown = [
      '## <claim id="a" refs="">Costs</claim>',
      '</claim><claim id="c" refs="">## Beds',
    ].join("\n");
    expect(listWikiHeadings(markdown).map((heading) => heading.label)).toEqual([
      "## Costs",
      "## Beds",
    ]);
  });
});

describe("replace_section", () => {
  it("replaces a section with its opening claim tag, leaving every other byte untouched", () => {
    const replacement = [
      '<claim id="costs" refs="source:doc-b source:doc-d">',
      "## Costs",
      "",
      "The annual plot fee rose to 30 credits.",
      "</claim>",
    ].join("\n");
    const result = apply(PAGE, { op: "replace_section", heading: "Costs", markdown: replacement });
    const start = PAGE.indexOf('<claim id="costs"');
    const end = PAGE.indexOf('<claim id="seeds"');
    expect(result.markdown).toBe(PAGE.slice(0, start) + replacement + "\n\n" + PAGE.slice(end));
    expect(result.changedSections).toEqual(["## Costs"]);
    expect(claimIds(result.markdown)).toEqual(claimIds(PAGE));
  });

  it("includes subsections up to the next heading of the same or a higher level", () => {
    const result = apply(PAGE, {
      op: "replace_section",
      heading: "Beds",
      markdown: '<claim id="beds" refs="source:doc-a">\n## Beds\n\nFour beds now.\n</claim>',
    });
    expect(result.markdown).not.toContain("### Soil");
    expect(result.markdown).toContain('Four beds now.\n</claim>\n\n<claim id="costs"');
    expect(claimIds(result.markdown)).toEqual(["overview", "beds", "costs", "seeds"]);
  });

  it("replaces a nested subsection alone", () => {
    const result = apply(PAGE, {
      op: "replace_section",
      heading: "### Soil",
      markdown:
        '<claim id="bed-soil" refs="source:doc-b">\n### Soil\n\nEach bed took 45 litres.\n</claim>',
    });
    expect(result.markdown).toContain("Three raised beds sit along the south fence.\n</claim>\n");
    expect(result.markdown).toContain("Each bed took 45 litres.");
    expect(result.markdown).toContain("## Costs");
  });

  it("replaces the first and the last section", () => {
    const first = apply(PAGE, {
      op: "replace_section",
      heading: "Beds",
      markdown: '<claim id="beds" refs="">\n## Beds\n\nX\n</claim>',
    }).markdown;
    expect(first.startsWith(PAGE.slice(0, PAGE.indexOf('<claim id="beds"')))).toBe(true);
    const last = apply(PAGE, {
      op: "replace_section",
      heading: "Seed library",
      markdown: '<claim id="seeds" refs="">\n## Seed library\n\nThree packets.\n</claim>\n\n\n',
    }).markdown;
    expect(last).toBe(
      PAGE.slice(0, PAGE.indexOf('<claim id="seeds"')) +
        '<claim id="seeds" refs="">\n## Seed library\n\nThree packets.\n</claim>\n',
    );
  });

  it("replaces an empty section", () => {
    const markdown = "## Empty\n## Next\n\ntext\n";
    expect(
      apply(markdown, {
        op: "replace_section",
        heading: "Empty",
        markdown: "## Empty\n\nNow filled.",
      }).markdown,
    ).toBe("## Empty\n\nNow filled.\n## Next\n\ntext\n");
  });

  it("strips leading blank lines and keeps the section's own trailing whitespace", () => {
    const markdown = "## A\n\none\n\n\n## B\n\ntwo";
    expect(
      apply(markdown, { op: "replace_section", heading: "A", markdown: "\n\n## A\n\nuno  \n" })
        .markdown,
    ).toBe("## A\n\nuno\n\n\n## B\n\ntwo");
  });

  it("keeps CRLF line endings in the replacement", () => {
    const markdown = "## A\r\n\r\none\r\n## B\r\n\r\ntwo\r\n";
    expect(
      apply(markdown, { op: "replace_section", heading: "A", markdown: "## A\n\nuno" }).markdown,
    ).toBe("## A\r\n\r\nuno\r\n## B\r\n\r\ntwo\r\n");
  });

  it("matches a heading written on the same line as its claim tag", () => {
    const markdown =
      '<claim id="a" refs="">## Alpha\n\nfirst</claim>\n<claim id="b" refs="">## Beta\n\nsecond</claim>\n';
    expect(
      apply(markdown, {
        op: "replace_section",
        heading: "Alpha",
        markdown: '<claim id="a" refs="">## Alpha\n\nupdated</claim>',
      }).markdown,
    ).toBe(
      '<claim id="a" refs="">## Alpha\n\nupdated</claim>\n<claim id="b" refs="">## Beta\n\nsecond</claim>\n',
    );
  });

  it("moves over nested opening tags before a heading", () => {
    const markdown =
      '<claim id="outer" refs="">\n<claim id="inner" refs="">\n## Nested\n\nbody\n</claim>\n</claim>\n## Next\n\ntail\n';
    const result = apply(markdown, {
      op: "replace_section",
      heading: "Nested",
      markdown: '<claim id="outer" refs="">\n## Nested\n\nnew body\n</claim>',
    });
    expect(result.markdown).toBe(
      '<claim id="outer" refs="">\n## Nested\n\nnew body\n</claim>\n## Next\n\ntail\n',
    );
  });

  it("refuses a section whose edge falls inside a claim", () => {
    const whole = '<claim id="page" refs="">\nIntro.\n\n## Part\n\nBody.\n</claim>\n';
    const error = refusal(whole, {
      op: "replace_section",
      heading: "Part",
      markdown: "## Part\n\nx",
    });
    expect(error.code).toBe("edit_section_boundary");
    expect(error.message).toContain('"page"');
    expect(error.message).toContain("replace_text");
    const straddling = '## One\n\n<claim id="span" refs="">first\n\n## Two\n\nsecond</claim>\n';
    expect(refusal(straddling, { op: "delete_section", heading: "One" }).code).toBe(
      "edit_section_boundary",
    );
  });

  it("lists the available headings when none matches", () => {
    const error = refusal(PAGE, { op: "replace_section", heading: "Fees", markdown: "x" });
    expect(error.code).toBe("edit_target_not_found");
    expect(error.message).toContain("edits[0] (replace_section)");
    expect(error.message).toContain("## Beds | ### Soil | ## Costs | ## Seed library");
    expect(refusal("plain text", { op: "delete_section", heading: "Any" }).message).toContain(
      "the page has no headings",
    );
  });

  it("distinguishes the same heading text at different levels by its # marks", () => {
    const markdown = "## Notes\n\npage notes\n## Beds\n\nbeds\n### Notes\n\nbed notes\n";
    const ambiguous = refusal(markdown, { op: "delete_section", heading: "Notes" });
    expect(ambiguous.code).toBe("edit_target_ambiguous");
    expect(ambiguous.message).toContain("## Notes, ### Notes");
    expect(ambiguous.message).toContain("Prefix the heading with its # marks");
    expect(apply(markdown, { op: "delete_section", heading: "### Notes" }).markdown).toBe(
      "## Notes\n\npage notes\n## Beds\n\nbeds\n",
    );
    expect(apply(markdown, { op: "delete_section", heading: "## Notes" }).markdown).toBe(
      "## Beds\n\nbeds\n### Notes\n\nbed notes\n",
    );
  });

  it("refuses duplicate headings at the same level", () => {
    const error = refusal("## Notes\n\na\n## Notes\n\nb\n", {
      op: "replace_section",
      heading: "## Notes",
      markdown: "## Notes\n\nc",
    });
    expect(error.code).toBe("edit_target_ambiguous");
    expect(error.message).toContain("use replace_text");
  });

  it("refuses a replacement that does not open with a heading", () => {
    const error = refusal(PAGE, {
      op: "replace_section",
      heading: "Costs",
      markdown: '<claim id="costs" refs="source:doc-b">The fee is 30 credits.</claim>',
    });
    expect(error.code).toBe("edit_invalid");
    expect(error.message).toContain("must open with the section's heading");
    expect(
      refusal(PAGE, {
        op: "replace_section",
        heading: "Costs",
        markdown: "Intro first.\n## Costs\n\nx",
      }).code,
    ).toBe("edit_invalid");
  });

  it("refuses an empty replacement", () => {
    expect(refusal(PAGE, { op: "replace_section", heading: "Costs", markdown: " \n " }).code).toBe(
      "edit_invalid",
    );
  });
});

describe("delete_section", () => {
  it("removes the section, its claims and its trailing blank lines", () => {
    const result = apply(PAGE, { op: "delete_section", heading: "Costs" });
    expect(result.markdown).toBe(
      PAGE.slice(0, PAGE.indexOf('<claim id="costs"')) +
        PAGE.slice(PAGE.indexOf('<claim id="seeds"')),
    );
    expect(claimIds(result.markdown)).toEqual(["overview", "beds", "bed-soil", "seeds"]);
    expect(result.changedSections).toEqual(["## Costs"]);
  });

  it("keeps the preamble before the first heading", () => {
    const result = apply(PAGE, { op: "delete_section", heading: "Beds" });
    expect(result.markdown.startsWith(PAGE.slice(0, PAGE.indexOf('<claim id="beds"')))).toBe(true);
    expect(claimIds(result.markdown)).toEqual(["overview", "costs", "seeds"]);
  });
});

describe("insert_section", () => {
  const section =
    '<claim id="tools" refs="source:doc-e">\n## Tools\n\nA shared shed holds the tools.\n</claim>';

  it("inserts after a section and its subsections", () => {
    const result = apply(PAGE, { op: "insert_section", after: "Beds", markdown: section });
    expect(result.markdown).toBe(
      PAGE.slice(0, PAGE.indexOf('<claim id="costs"')) +
        section +
        "\n\n" +
        PAGE.slice(PAGE.indexOf('<claim id="costs"')),
    );
    expect(result.changedSections).toEqual(["## Tools"]);
  });

  it("inserts before a section", () => {
    const result = apply(PAGE, { op: "insert_section", before: "Costs", markdown: section });
    expect(result.markdown.indexOf("## Tools")).toBeLessThan(result.markdown.indexOf("## Costs"));
    expect(result.markdown.indexOf("## Tools")).toBeGreaterThan(
      result.markdown.indexOf("### Soil"),
    );
    expect(claimIds(result.markdown)).toEqual([
      "overview",
      "beds",
      "bed-soil",
      "tools",
      "costs",
      "seeds",
    ]);
  });

  it("inserts at the start, before the preamble, and at the end", () => {
    expect(apply(PAGE, { op: "insert_section", at: "start", markdown: section }).markdown).toBe(
      section + "\n\n" + PAGE,
    );
    expect(apply(PAGE, { op: "insert_section", at: "end", markdown: section }).markdown).toBe(
      PAGE + "\n" + section + "\n",
    );
    expect(
      apply("no newline", { op: "insert_section", at: "end", markdown: "## Next" }).markdown,
    ).toBe("no newline\n\n## Next\n");
    expect(apply("", { op: "insert_section", at: "start", markdown: "## First" }).markdown).toBe(
      "## First\n",
    );
  });

  it("needs exactly one position", () => {
    expect(refusal(PAGE, { op: "insert_section", markdown: section }).code).toBe("edit_invalid");
    expect(
      refusal(PAGE, { op: "insert_section", after: "Beds", at: "end", markdown: section }).code,
    ).toBe("edit_invalid");
    expect(refusal(PAGE, { op: "insert_section", after: "Fees", markdown: section }).code).toBe(
      "edit_target_not_found",
    );
  });

  it("names the surrounding section for an insertion without a heading", () => {
    const result = apply(PAGE, {
      op: "insert_section",
      after: "Costs",
      markdown: '<claim id="fee-note" refs="">Fees are due in spring.</claim>',
    });
    expect(result.changedSections).toEqual(["## Costs"]);
  });
});

describe("replace_text", () => {
  it("replaces a single exact occurrence", () => {
    const result = apply(PAGE, {
      op: "replace_text",
      old: "The annual plot fee is 25 credits.",
      new: "The annual plot fee is 30 credits.",
    });
    expect(result.markdown).toBe(PAGE.replace("25 credits", "30 credits"));
    expect(result.changedSections).toEqual(["## Costs"]);
  });

  it("reports the occurrence count when the text is not unique", () => {
    const error = refusal(PAGE, { op: "replace_text", old: "</claim>", new: "" });
    expect(error.code).toBe("edit_target_ambiguous");
    expect(error.message).toContain("occurs 5 times");
  });

  it("refuses text that does not occur, and says when it spans claim tags", () => {
    const missing = refusal(PAGE, { op: "replace_text", old: "40 credits", new: "x" });
    expect(missing.code).toBe("edit_target_not_found");
    expect(missing.message).not.toContain("span claim tags");
    const spanning = refusal(
      '<claim id="a" refs="">One.</claim><claim id="b" refs="">Two.</claim>',
      {
        op: "replace_text",
        old: "One.Two.",
        new: "x",
      },
    );
    expect(spanning.message).toContain("span claim tags");
  });

  it("refuses an empty or unchanged replacement", () => {
    expect(refusal(PAGE, { op: "replace_text", old: "", new: "x" }).code).toBe("edit_invalid");
    expect(refusal(PAGE, { op: "replace_text", old: "fee", new: "fee" }).code).toBe("edit_invalid");
  });

  it("edits a claim tag's refs like any other text", () => {
    const result = apply(PAGE, {
      op: "replace_text",
      old: '<claim id="costs" refs="source:doc-b">',
      new: '<claim id="costs" refs="source:doc-b source:doc-d">',
    });
    expect(
      parseClaimMarkup(result.markdown).claims.find((claim) => claim.id === "costs")?.refs,
    ).toHaveLength(2);
  });

  it("matches LF text against a CRLF page and writes CRLF back", () => {
    const markdown = "## A\r\n\r\nfirst line\r\nsecond line\r\n";
    expect(
      apply(markdown, { op: "replace_text", old: "first line\nsecond line", new: "one\ntwo" })
        .markdown,
    ).toBe("## A\r\n\r\none\r\ntwo\r\n");
  });

  it("writes a multi-line replacement with the page's CRLF endings", () => {
    expect(
      apply("## A\r\n\r\none\r\n", { op: "replace_text", old: "one", new: "uno\ndos" }).markdown,
    ).toBe("## A\r\n\r\nuno\r\ndos\r\n");
  });

  it("names the preamble when the text sits before the first heading", () => {
    expect(
      apply(PAGE, { op: "replace_text", old: "three raised beds", new: "four raised beds" })
        .changedSections,
    ).toEqual(["(before the first heading)"]);
  });
});

describe("a sequence of edits", () => {
  it("applies each edit to the result of the previous one", () => {
    const result = apply(
      PAGE,
      { op: "replace_text", old: "25 credits", new: "30 credits" },
      { op: "insert_section", after: "Costs", markdown: "## Discounts\n\nStudents pay half." },
      { op: "replace_text", old: "Students pay half.", new: "Students pay 15 credits." },
      { op: "delete_section", heading: "Seed library" },
    );
    expect(result.markdown).toContain("The annual plot fee is 30 credits.");
    expect(result.markdown).toContain("## Discounts\n\nStudents pay 15 credits.\n");
    expect(result.markdown).not.toContain("Seed library");
    expect(result.changedSections).toEqual(["## Costs", "## Discounts", "## Seed library"]);
  });

  it("names the failing edit by its position", () => {
    const error = refusal(
      PAGE,
      { op: "replace_text", old: "25 credits", new: "30 credits" },
      { op: "replace_text", old: "25 credits", new: "35 credits" },
    );
    expect(error.message).toContain("edits[1] (replace_text)");
  });

  it("refuses a section edit after an earlier edit unbalanced the claim tags", () => {
    const error = refusal(
      PAGE,
      { op: "replace_text", old: '</claim>\n\n<claim id="costs"', new: '\n\n<claim id="costs"' },
      { op: "delete_section", heading: "Seed library" },
    );
    expect(error.code).toBe("edit_invalid");
    expect(error.message).toContain("edits[1]");
  });
});
