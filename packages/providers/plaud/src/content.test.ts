// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { inlineContent, parseSummary, parseTranscript, selectContent } from "./content.js";

describe("selectContent", () => {
  test("picks the finished transcript and prefers the primary summary", () => {
    const picked = selectContent({
      content_list: [
        { data_id: "sum_multi:1", data_type: "sum_multi_note", task_status: 1, data_link: "x" },
        { data_id: "source_transaction:1", data_type: "transaction", task_status: 1 },
        { data_id: "auto_sum:1", data_type: "auto_sum_note", task_status: 1 },
        { data_id: "outline:1", data_type: "outline", task_status: 1 },
      ],
    });
    expect(picked.transcript?.data_id).toBe("source_transaction:1");
    expect(picked.summary?.data_id).toBe("auto_sum:1");
  });

  test("matches on the id prefix when the type string drifts, and skips unfinished items", () => {
    const picked = selectContent({
      content_list: [
        { data_id: "source_transaction:1", data_type: "something_new", task_status: 0 },
        { data_id: "sum_multi:2", data_type: "renamed", task_status: 1 },
      ],
    });
    expect(picked.transcript).toBeUndefined();
    expect(picked.summary?.data_id).toBe("sum_multi:2");
  });

  test("reads the inline copy of an item, parsed when it is JSON", () => {
    const detail = {
      pre_download_content_list: [
        { data_id: "a", data_content: '{"ai_content":"Short"}' },
        { data_id: "b", data_content: "plain words" },
      ],
    };
    expect(inlineContent(detail, { data_id: "a" })).toEqual({ ai_content: "Short" });
    expect(inlineContent(detail, { data_id: "b" })).toBe("plain words");
    expect(inlineContent(detail, { data_id: "c" })).toBeUndefined();
  });
});

describe("parseTranscript", () => {
  test("reads segments with named and numbered speakers", () => {
    expect(
      parseTranscript([
        { start_time: 0, end_time: 1500, speaker: "Maya", content: " Morning. " },
        { start_time: 61_000, speaker: 2, text: "Shall we start?" },
        { start_time: 62_000, content: "" },
      ]),
    ).toEqual([
      { startMs: 0, speaker: "Maya", text: "Morning." },
      { startMs: 61_000, speaker: "Speaker 2", text: "Shall we start?" },
    ]);
  });

  test("unwraps a wrapper object", () => {
    expect(parseTranscript({ segments: [{ content: "Hi" }] })).toEqual([{ text: "Hi" }]);
    expect(parseTranscript({ data: [{ content: "Hi" }] })).toEqual([{ text: "Hi" }]);
  });

  test.each([null, "a string", 42, { other: [] }, [1, 2, "x"]])(
    "yields nothing for an unrecognised shape: %j",
    (raw) => expect(parseTranscript(raw)).toEqual([]),
  );
});

describe("parseSummary", () => {
  test("a bare string is the summary", () => {
    expect(parseSummary(" Budget review. ")).toEqual({
      text: "Budget review.",
      keyPoints: [],
      actionItems: [],
    });
  });

  test("reads the text, key points and action items of an object", () => {
    expect(
      parseSummary({
        summary: "Q4 budget review.",
        key_points: ["Travel is over plan", 3],
        action_items: ["Send the revised sheet"],
      }),
    ).toEqual({
      text: "Q4 budget review.",
      keyPoints: ["Travel is over plan"],
      actionItems: ["Send the revised sheet"],
    });
  });

  test.each([null, "", "   ", {}, [], { ai_content: "" }])("yields nothing for %j", (raw) =>
    expect(parseSummary(raw)).toBeUndefined(),
  );
});
