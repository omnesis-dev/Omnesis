// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi, afterEach } from "vitest";
import { groupRemediations, renderStatus } from "./status-render.js";
import type { StatusData } from "./status-types.js";
import type { CliFx } from "../utils.js";

const fx: CliFx = { images: false, hyperlinks: false, meta: {} };

function captureRender(data: StatusData): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  });
  try {
    renderStatus(data, fx);
  } finally {
    spy.mockRestore();
  }
  // Strip ANSI so assertions are color-agnostic.
  return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

function baseData(): StatusData {
  return {
    statuses: [],
    sourceStats: {},
    analyticsRecordCounts: {},
    dbSizeBytes: null,
    indexStats: null,
    processVitals: null,
    configHealth: null,
    timestamp: new Date().toISOString(),
  };
}

function statusRow(over: Partial<StatusData["statuses"][number]>): StatusData["statuses"][number] {
  return {
    sourceId: "web",
    providerId: "web",
    sourceName: "web",
    state: "idle",
    unitName: "web pages",
    ...over,
  };
}

const sourceStat = {
  documentCount: 1122,
  earliestSourceDate: null,
  latestSourceDate: null,
  totalUnitCount: null,
  dataSizeBytes: 0,
};

afterEach(() => vi.restoreAllMocks());

test("successful sources display persistent warning age and remedy", () => {
  const out = captureRender({
    ...baseData(),
    statuses: [
      statusRow({
        state: "idle",
        issues: [
          {
            code: "snapshot-withheld",
            scope: "partition",
            kind: "unknown",
            count: 1,
            message: "Example enumeration incomplete",
            since: 1000,
            remediation: {
              summary: "Restore access",
              steps: ["Check the example folder permission."],
              restartRequired: false,
            },
          },
        ],
      }),
    ],
  });
  expect(out).toContain("Example enumeration incomplete");
  expect(out).toContain("1970-01-01T00:00:01.000Z");
  expect(out).toContain("Check the example folder permission.");
});

describe("renderStatus count column", () => {
  test("primaryCount 'documents' shows the document total, not the analytics rows", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [statusRow({ primaryCount: "documents" })],
      sourceStats: { web: sourceStat },
      analyticsRecordCounts: { web: 32 },
    });
    expect(out).toContain("1,122 web pages");
    expect(out).not.toContain("32 web pages");
  });

  test("without primaryCount, the heuristic still prefers analytics rows", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [statusRow({ unitName: "visits" })],
      sourceStats: { web: sourceStat },
      analyticsRecordCounts: { web: 32 },
    });
    expect(out).toContain("32 visits");
  });

  test("primaryCount 'analytics' forces the analytics row count", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [statusRow({ unitName: "visits", primaryCount: "analytics" })],
      sourceStats: { web: { ...sourceStat, totalUnitCount: 9999 } },
      analyticsRecordCounts: { web: 32 },
    });
    expect(out).toContain("32 visits");
    expect(out).not.toContain("9,999");
  });
});

describe("renderStatus mobile permission states", () => {
  test.each(["permission-degraded", "background-access-missing"])(
    "renders %s as an attention state",
    (state) => {
      const out = captureRender({ ...baseData(), statuses: [statusRow({ state })] });
      expect(out).toMatch(new RegExp(`⚠ web\\s+${state}`));
    },
  );

  test("renders unavailable as a hard degraded state", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [statusRow({ state: "unavailable" })],
    });
    expect(out).toMatch(/✗ web\s+unavailable/);
  });
});

// Status two-readout: a graceful embedder swap must surface as an
// upgrade-in-flight — search live on the active model + a separate migration
// progress line — never as the existing index regressing.
describe("renderStatus index migration", () => {
  function indexStatsWith(
    indexVersions: NonNullable<NonNullable<StatusData["indexStats"]>["indexVersions"]>,
  ): NonNullable<StatusData["indexStats"]> {
    return {
      enabled: true,
      totalIndexed: 1000,
      totalChunks: 5000,
      totalGatewayDocs: 1000,
      watermark: null,
      indexVersions,
      bySource: {},
    };
  }

  test("graceful swap: shows the migration with progress + 'search live' on the active model", () => {
    const out = captureRender({
      ...baseData(),
      indexStats: indexStatsWith({
        active: { version: 1, embedModel: "text-embedding-3-small", embedDim: 1536 },
        building: {
          version: 2,
          embedModel: "text-embedding-3-large",
          embedDim: 3072,
          docsBuilt: 250,
          docsTotal: 1000,
          percent: 25,
        },
      }),
    });
    expect(out).toContain("Index Migration");
    expect(out).toContain("text-embedding-3-large");
    expect(out).toContain("25% (250/1000 docs)");
    expect(out).toContain("search live on text-embedding-3-small");
    expect(out).toContain("switches automatically when ready");
  });

  test("no build in flight: renders nothing about migration", () => {
    const out = captureRender({
      ...baseData(),
      indexStats: indexStatsWith({
        active: { version: 1, embedModel: "text-embedding-3-small", embedDim: 1536 },
        building: null,
      }),
    });
    expect(out).not.toContain("Index Migration");
    expect(out).not.toContain("Index Build");
  });

  test("first build / no complete active: frames the build as the primary search readiness", () => {
    const out = captureRender({
      ...baseData(),
      indexStats: indexStatsWith({
        active: null,
        building: {
          version: 1,
          embedModel: "first-model",
          embedDim: 768,
          docsBuilt: 4,
          docsTotal: 10,
          percent: 40,
        },
      }),
    });
    expect(out).toContain("Index Build");
    expect(out).toContain("semantic search limited until the build completes");
    expect(out).not.toContain("Index Migration");
  });

  test("older gateway without indexVersions renders nothing about migration", () => {
    const out = captureRender({
      ...baseData(),
      indexStats: {
        enabled: true,
        totalIndexed: 10,
        totalChunks: 20,
        totalGatewayDocs: 10,
        watermark: null,
        bySource: {},
      },
    });
    expect(out).not.toContain("Index Migration");
    expect(out).not.toContain("Index Build");
  });
});

describe("renderStatus configHealth (C15a)", () => {
  test("renders a named degraded-role line for a typo'd assignment", () => {
    const out = captureRender({
      ...baseData(),
      configHealth: {
        degradedRoles: [{ role: "agent", reason: 'Unknown backend "missing-backend"' }],
        lastConfigError: 'Inference config degraded: agent (Unknown backend "missing-backend")',
      },
    });
    expect(out).toContain("Inference Config Degraded");
    // Names which role and why — not a generic "something degraded".
    expect(out).toContain("agent");
    expect(out).toContain("missing-backend");
  });

  test("renders nothing about config health when degradedRoles is empty (normal state)", () => {
    const out = captureRender({
      ...baseData(),
      configHealth: { degradedRoles: [], lastConfigError: null },
    });
    expect(out).not.toContain("Inference Config Degraded");
  });

  test("renders nothing about config health when an older gateway omits configHealth", () => {
    const out = captureRender(baseData());
    expect(out).not.toContain("Inference Config Degraded");
  });
});

// A failure the operator has to act on is rendered as its remedy: the row
// points at it, the steps are printed once under the table, and the raw
// message — the diagnostic — is left to `sources debug`.
describe("renderStatus structured remediation", () => {
  const remediation = {
    summary: "Disk access is required",
    steps: ["Open the privacy settings pane.", "Add the executable."],
    executable: "/opt/example/bin/node",
    restartRequired: true,
  };

  test("an errored row points at its remedy and the steps print once under the table", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [
        statusRow({
          sourceId: "apple-notes:local",
          sourceName: "apple-notes:local",
          state: "error",
          lastError: "Cannot open the notes database — disk access is required.",
          remediation,
        }),
        statusRow({
          sourceId: "apple-imessage:local",
          sourceName: "apple-imessage:local",
          state: "error",
          lastError: "Cannot open the messages database — disk access is required.",
          remediation,
        }),
      ],
    });
    expect(out).toContain("↳ Disk access is required (2 sources affected) — see below");
    expect(out).not.toContain("Cannot open the notes database");
    expect(out).toMatch(/Access\s+Required/);
    expect(
      out.match(/⚠ Disk access is required — apple-notes:local, apple-imessage:local/g),
    ).toHaveLength(1);
    expect(out).toContain("1. Open the privacy settings pane.");
    expect(out).toContain("2. Add the executable.");
    expect(out).toContain("3. Restart the collector.");
    expect(out).toContain("executable: /opt/example/bin/node");
  });

  test("an error without a remedy still prints its message and no section", () => {
    const out = captureRender({
      ...baseData(),
      statuses: [statusRow({ state: "error", lastError: "connection refused" })],
    });
    expect(out).toContain("connection refused");
    expect(out).not.toMatch(/Access\s+Required/);
  });

  test("groupRemediations keys on the summary and the executable, in error state only", () => {
    const other = { ...remediation, executable: "/usr/local/bin/node" };
    const groups = groupRemediations([
      { sourceId: "a", state: "error", remediation },
      { sourceId: "b", state: "error", remediation },
      { sourceId: "c", state: "error", remediation: other },
      { sourceId: "d", state: "synced", remediation },
      { sourceId: "e", state: "error" },
    ]);
    expect(groups.map((g) => g.sourceIds)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("renderStatus header size", () => {
  test("shows the gateway's whole footprint when it reports one", () => {
    const out = captureRender({
      ...baseData(),
      dbSizeBytes: 1024 * 1024,
      diskUsageBytes: 3 * 1024 * 1024,
    });
    expect(out).toMatch(/omnesis status \(on disk: 3(\.0)? MB\)/i);
    expect(out).not.toContain("DB:");
  });

  test("falls back to the main database on a gateway without diskUsage", () => {
    const out = captureRender({ ...baseData(), dbSizeBytes: 1024 * 1024 });
    expect(out).toMatch(/omnesis status \(db: 1(\.0)? MB\)/i);
  });
});
