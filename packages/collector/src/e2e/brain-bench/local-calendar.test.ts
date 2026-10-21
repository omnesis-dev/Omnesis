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
