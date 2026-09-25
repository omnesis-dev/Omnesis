// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSweeps: vi.fn(),
  saveSweep: vi.fn(),
  forkSweep: vi.fn(),
  setSweepEnabled: vi.fn(),
  deleteSweepFile: vi.fn(),
}));

vi.mock("../api.js", () => api);

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { SweepsView } from "./sweeps.js";

const SHIPPED = {
  id: "loose-ends",
  name: "Loose ends",
  cadenceHours: 24,
  at: "07:30",
  anchorExplicit: true,
  enabled: true,
  hasSystemVersion: true,
  modified: false,
  steeringPrompt: "Surface commitments with no follow-up.",
  stats: {
    runs: 4,
    failedRuns: 0,
    promptTokens: 900,
    completionTokens: 100,
    briefsCreated: 1,
    briefsHeld: 2,
    loopsCreated: 3,
    loopsTouched: 5,
    annotationsCreated: 0,
    firstRunAt: "2026-01-02T07:30:00.000Z",
    lastRunAt: "2026-01-09T07:30:00.000Z",
  },
};

const OWN_AND_OFF = {
  ...SHIPPED,
  id: "quarter-close",
  name: "Quarter close",
  enabled: false,
  hasSystemVersion: false,
  modified: false,
};

/**
 * The sweeps table is the portal's reference table: the policy library and the
 * policy version history are built from the same primitives, and each pins the
 * vocabulary on its own side. Nothing here loads the stylesheet, so these
 * assertions catch a view that stopped naming a shared class — not a
 * stylesheet that stopped defining one.
 */
describe("SweepsView table", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLDivElement;
  });

  afterEach(() => {
    act(() => render(null, host));
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount(items: unknown[]) {
    api.getSweeps.mockResolvedValue({ directory: "/tmp/sweeps", items, issues: [], digestWindowConflicts: [] });
    await act(async () => { render(h(SweepsView, {}), host); });
    await act(async () => { await Promise.resolve(); });
  }

  it("renders one row per sweep on the shared table primitives", async () => {
    await mount([SHIPPED, OWN_AND_OFF]);

    expect(host.querySelector(".portal-table-wrap .portal-table")).not.toBeNull();
    const rows = [...host.querySelectorAll(".portal-table tbody tr")];
    expect(rows.map((row) => row.querySelector(".portal-table-name")?.textContent?.trim()))
      .toEqual(["Loose ends", "Quarter close"]);
    // Every column but the name and the actions is the shared numeric column.
    // Counting them exactly is what makes this catch a partial rename: two
    // schedule columns losing the class still leaves eight counters behind it.
    const cells = [...rows[0].querySelectorAll("td")];
    expect(cells).toHaveLength(12);
    expect(cells.filter((cell) => cell.classList.contains("portal-table-num"))).toHaveLength(10);
    expect(cells[1].classList.contains("portal-table-num")).toBe(true);
    expect(cells[2].classList.contains("portal-table-num")).toBe(true);
    expect(host.querySelectorAll("thead th.portal-table-num")).toHaveLength(10);
    // Each counter reads its own field off the stats block, so a fixture with a
    // field missing would render the string "undefined" into a cell.
    expect(cells.map((cell) => cell.textContent?.trim()).join("|")).not.toContain("undefined");
    expect(cells[3].textContent?.trim()).toBe("4");
    expect(cells[5].textContent?.trim()).toBe("2");
    // The row's origin and state read as pills under its name.
    expect(rows[0].querySelector(".portal-table-sub .portal-pill")?.textContent?.trim()).toBe("System");
    expect(rows[1].querySelector(".portal-table-sub .portal-pill")?.textContent?.trim()).toBe("Yours");
    expect([...rows[1].querySelectorAll(".portal-pill")].map((pill) => pill.textContent?.trim()))
      .toContain("Off");
  });

  it("dims a disabled sweep without hiding it, because it is still part of the set", async () => {
    await mount([SHIPPED, OWN_AND_OFF]);

    const rows = [...host.querySelectorAll(".portal-table tbody tr")];
    expect(rows[0].getAttribute("class") ?? "").not.toContain("sweep-row-off");
    expect(rows[1].getAttribute("class")).toContain("sweep-row-off");
  });
});
