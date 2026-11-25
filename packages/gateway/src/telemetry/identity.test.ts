// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installationId, loadTelemetrySecret, telemetryPeriod } from "./identity.js";

describe("telemetry installation identity", () => {
  it("survives restarts and version changes without borrowing another identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnesis-telemetry-"));
    try {
      const first = await loadTelemetrySecret(directory);
      const second = await loadTelemetrySecret(directory);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toBe(first);
      expect(installationId(first, "2026-11")).toBe(installationId(second, "2026-11"));
      expect((await stat(join(directory, "telemetry-secret-v1"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rotates at UTC month boundaries, including the year", () => {
    const before = telemetryPeriod(new Date("2026-12-31T23:59:59.999Z"));
    const after = telemetryPeriod(new Date("2027-01-01T00:00:00.000Z"));
    expect(before).toBe("2026-12");
    expect(after).toBe("2027-01");
    expect(installationId("01".repeat(32), before)).not.toBe(
      installationId("01".repeat(32), after),
    );
    expect(telemetryPeriod(new Date("2026-12-31T19:00:00-05:00"))).toBe("2027-01");
  });

  it("keeps different installations distinct", async () => {
    const directories = await Promise.all(
      [1, 2].map(() => mkdtemp(join(tmpdir(), "omnesis-telemetry-"))),
    );
    try {
      const [first, second] = await Promise.all(directories.map(loadTelemetrySecret));
      expect(installationId(first!, "2026-11")).not.toBe(installationId(second!, "2026-11"));
    } finally {
      await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    }
  });
});
