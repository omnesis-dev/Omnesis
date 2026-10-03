// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import realBrowserHistory from "@omnesis/provider-browser-history";
import { buildUniverse } from "./build.mjs";

it("attributes generated browser analytics to the exact discovered browser account", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "fictional-browser-identity-"));
  try {
    const { manifest } = await buildUniverse({ outDir, media: false });
    const entry = manifest.sources.find((source) => source.descriptorId === "browser-history");
    const fixture = JSON.parse(
      await readFile(join(outDir, "sources", "browser-history", "visits.json"), "utf8"),
    );
    expect(entry.accountIds).toEqual([fixture.browser]);
    expect(fixture.browser).toBe("safari");
    expect(fixture.profile).toBe("Personal");
    expect(realBrowserHistory.analyticsSchemas).toHaveLength(3);
    for (const schema of realBrowserHistory.analyticsSchemas)
      expect(schema.sharedDiscriminatorColumn).toBe("browser");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
