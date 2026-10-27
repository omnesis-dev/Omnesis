// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps fixture clock hours on both daylight-saving transition days", () => {
  const helper = new URL("./local-calendar.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { localHour } from ${JSON.stringify(helper)};
    const days = ["2026-03-29T12:00:00Z", "2026-10-25T12:00:00Z"];
    console.log(JSON.stringify(days.map(day => [5, 7, 12].map(hour =>
      new Date(localHour(Date.parse(day), hour)).toISOString()))));
  `,
    ],
    { env: { ...process.env, TZ: "Europe/London" }, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    ["2026-03-29T04:00:00.000Z", "2026-03-29T06:00:00.000Z", "2026-03-29T11:00:00.000Z"],
    ["2026-10-25T05:00:00.000Z", "2026-10-25T07:00:00.000Z", "2026-10-25T12:00:00.000Z"],
  ]);
});

it("daily calendar boundaries span 23 or 25 hours when daylight saving changes", () => {
  const helper = new URL("./local-calendar.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { localHour } from ${JSON.stringify(helper)};
    const days = ["2026-03-28T12:00:00Z", "2026-10-24T12:00:00Z"];
    console.log(JSON.stringify(days.map(day => {
      const noon = localHour(Date.parse(day), 12);
      const previous = localHour(noon, 5);
      const next = localHour(noon + 86400000, 5);
      return { previous: new Date(previous).toISOString(), next: new Date(next).toISOString(), hours: (next - previous) / 3600000 };
    })));
  `,
    ],
    { env: { ...process.env, TZ: "Europe/London" }, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { previous: "2026-03-28T05:00:00.000Z", next: "2026-03-29T04:00:00.000Z", hours: 23 },
    { previous: "2026-10-24T04:00:00.000Z", next: "2026-10-25T05:00:00.000Z", hours: 25 },
  ]);
});
