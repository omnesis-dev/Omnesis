// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { renderActivityMarkdown } from "./markdown.js";
import type { StravaSummaryActivity, StravaDetailedActivity, StravaComment } from "./types.js";

const summary: StravaSummaryActivity = {
  id: 12345,
  athlete: { id: 99 },
  name: "Morning Run",
  distance: 21530,
  moving_time: 6635,
  elapsed_time: 6640,
  total_elevation_gain: 131,
  sport_type: "Run",
  type: "Run",
  start_date: "2026-05-03T09:31:00Z",
  start_date_local: "2026-05-03T10:31:00Z",
  average_heartrate: 158,
  max_heartrate: 178,
  kudos_count: 3,
  comment_count: 1,
};

describe("renderActivityMarkdown", () => {
  test("includes summary stats from the SummaryActivity alone", () => {
    const md = renderActivityMarkdown(summary);
    expect(md).toContain("**Sport:** Run");
    expect(md).toContain("21.53 km");
    expect(md).toContain("Heart rate:");
    expect(md).toContain("3 kudos");
  });

  test("folds the description into a quoted block when detail provides one", () => {
    const detail: StravaDetailedActivity = {
      ...summary,
      description: "Felt great today.\n\nNew route through the park.",
    };
    const md = renderActivityMarkdown(summary, detail);
    expect(md).toContain("> Felt great today.");
    expect(md).toContain("> New route through the park.");
  });

  test("renders a 'Top results' section when best efforts are present", () => {
    const detail: StravaDetailedActivity = {
      ...summary,
      best_efforts: [
        {
          id: 1,
          activity: { id: 12345 },
          name: "5K",
          distance: 5000,
          elapsed_time: 1325,
          moving_time: 1325,
          pr_rank: 1,
        },
        {
          id: 2,
          activity: { id: 12345 },
          name: "10K",
          distance: 10000,
          elapsed_time: 2750,
          moving_time: 2750,
          pr_rank: null,
        },
      ],
    };
    const md = renderActivityMarkdown(summary, detail);
    expect(md).toContain("**Top results:**");
    expect(md).toContain("5K");
    expect(md).toContain("(PR)");
    expect(md).toContain("10K");
  });

  test("folds comments as blockquotes with attribution", () => {
    const comments: StravaComment[] = [
      {
        id: 1,
        activity_id: 12345,
        text: "Strong run!",
        created_at: "2026-05-03T10:00:00Z",
        athlete: { firstname: "Sarah", lastname: "Smith" },
      },
    ];
    const md = renderActivityMarkdown(summary, undefined, { comments });
    expect(md).toContain("**Comments (1):**");
    expect(md).toContain("> **Sarah Smith:** Strong run!");
  });

  test("emits gear name when provided", () => {
    const md = renderActivityMarkdown(summary, undefined, { gearName: "Nike Pegasus 41" });
    expect(md).toContain("**Gear:** Nike Pegasus 41");
  });

  test("only spells out kudoer names when there are 1-5", () => {
    const kudoers = [
      { firstname: "Alice" },
      { firstname: "Bob", lastname: "Jones" },
      { firstname: "Carol" },
    ];
    const md = renderActivityMarkdown(summary, undefined, { kudoers });
    expect(md).toContain("Kudos from: Alice, Bob Jones, Carol");
  });

  test("hides kudoer names when more than five", () => {
    const kudoers = Array.from({ length: 12 }, (_, i) => ({ firstname: `K${i}` }));
    const md = renderActivityMarkdown(summary, undefined, { kudoers });
    expect(md).not.toContain("Kudos from:");
  });

  test("includes calories + perceived exertion + device name from detail", () => {
    const detail: StravaDetailedActivity = {
      ...summary,
      calories: 1482,
      perceived_exertion: 6,
      device_name: "Apple Watch Ultra 2",
    };
    const md = renderActivityMarkdown(summary, detail);
    expect(md).toContain("**Calories:** 1482");
    expect(md).toContain("**Perceived exertion:** 6/10");
    expect(md).toContain("**Device:** Apple Watch Ultra 2");
  });

  test("fall back gracefully when detail/comments/kudoers are undefined", () => {
    expect(() => renderActivityMarkdown(summary)).not.toThrow();
  });
});
