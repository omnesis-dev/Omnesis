// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import realBrowserHistory from "@omnesis/provider-browser-history";
import { assembleUniverse } from "./build.mjs";

it("attributes generated browser analytics to the exact discovered browser account", async () => {
  // In memory: the manifest and the fixture are what is checked, so nothing is written.
  const { manifest, sources } = await assembleUniverse();
  const entry = manifest.sources.find((source) => source.descriptorId === "browser-history");
  const fixture = sources["browser-history"]["visits.json"];
  expect(entry.accountIds).toEqual([fixture.browser]);
  expect(fixture.browser).toBe("safari");
  expect(fixture.profile).toBe("Personal");
  expect(realBrowserHistory.analyticsSchemas).toHaveLength(3);
  for (const schema of realBrowserHistory.analyticsSchemas)
    expect(schema.sharedDiscriminatorColumn).toBe("browser");
});
