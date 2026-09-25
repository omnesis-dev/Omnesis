// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer module from vitest;
// the module is untyped browser code, so type-checking is off here.
//
// Structural render test for the Bootstrap panel. Same headless
// VNode-expansion harness as cognition-briefclaims.test.ts: no jsdom — each
// section renders to its preact VNode tree, function components are expanded
// into a flat host-element list, and the output is asserted.
//
// This exists because the populated panel is otherwise only reachable on an
// install whose Brain is actually running: a synthetic gateway has no
// background-agent model, so every /admin/brain/* route 404s and the panel can
// only ever be screenshotted in its empty state. Driving the sections directly
// is how the numbers, the sentences and the warnings get checked at all.
//
// All fixture data is invented; none comes from any real corpus.

import { describe, expect, it } from "vitest";

function expandToHostNodes(vnode, out = []) {
  if (vnode == null || typeof vnode === "boolean") return out;
  if (Array.isArray(vnode)) {
    for (const v of vnode) expandToHostNodes(v, out);
    return out;
  }
  if (typeof vnode === "string" || typeof vnode === "number") return out;
  if (!vnode.type) return out;
  if (typeof vnode.type === "function") {
    return expandToHostNodes(vnode.type(vnode.props ?? {}), out);
  }
  out.push({
    tag: vnode.type,
    class: vnode.props?.class ?? "",
    style: vnode.props?.style ?? "",
    text: collectText(vnode.props?.children),
    disabled: vnode.props?.disabled ?? false,
  });
  expandToHostNodes(vnode.props?.children, out);
  return out;
}

function collectText(children) {
  if (children == null || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(collectText).join("");
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (children.type && typeof children.type !== "function")
    return collectText(children.props?.children);
  return "";
}

/**
 * Everything the expanded tree renders, as one string with runs of whitespace
 * collapsed — the templates wrap their prose, so a sentence in the source is
 * not a contiguous string in the output.
 */
function flatText(vnode) {
  return allText(vnode).replace(/\s+/g, " ").trim();
}

/** Everything the expanded tree renders, as one string. */
function allText(vnode) {
  return expandToHostNodes(vnode)
    .map((n) => n.text)
    .join(" ");
}

const SETTINGS = {
  enabled: true,
  direction: "recent-first",
  backlogTarget: 200,
  maxRunsPerDay: 200,
  maxRuns: 1_000_000,
  batchSize: 100,
  recencyWindowMs: 7 * 86_400_000,
};

const RUNNING = {
  state: "running",
  reason: "Working through history at its configured pace.",
  settings: SETTINGS,
  holdSince: null,
  holdEndsAt: null,
  drainedDay: null,
  drainedSourceWatermark: null,
  sourceWatermark: "2026-08-20T09:00:00.000Z",
  day: "2026-08-23",
  enqueuedToday: 100,
  totalEnqueued: 2300,
  runs: { pending: 100, completed: 2200, failed: 0 },
  processedDocs: 5219,
  recencyFloor: "2026-08-16T12:00:00.000Z",
};

describe("Bootstrap panel — state banner", () => {
  it("renders a parked lane in the danger tone with the sentence that names the knob", async () => {
    const { StateBanner } = await import("./cognition-bootstrap.js");
    const parked = {
      ...RUNNING,
      state: "parked",
      reason:
        "Stopped at its lifetime run backstop (2,200 of 2,200). Raise brain.bootstrap.maxRuns to resume.",
    };
    const nodes = expandToHostNodes(StateBanner({ status: parked }));
    const text = nodes.map((n) => n.text).join(" ");
    expect(text).toContain("Parked");
    // The whole point of the panel: a parked lane must read as something to
    // act on, and the sentence must carry the key to change.
    expect(text).toContain("brain.bootstrap.maxRuns");
    expect(nodes.some((n) => String(n.style).includes("var(--danger)"))).toBe(true);
  });

  it("renders a running lane in the success tone", async () => {
    const { StateBanner } = await import("./cognition-bootstrap.js");
    const nodes = expandToHostNodes(StateBanner({ status: RUNNING }));
    expect(nodes.map((n) => n.text).join(" ")).toContain("Running");
    expect(nodes.some((n) => String(n.style).includes("var(--success)"))).toBe(true);
  });
});

describe("Bootstrap panel — backlog", () => {
  it("shows the count and an ETA once the date scan has caught up", async () => {
    const { BacklogSection } = await import("./cognition-bootstrap.js");
    const text = allText(
      BacklogSection({
        backlog: {
          remaining: 3782,
          dateScanPending: 0,
          dateScanned: 172651,
          computedAt: "2026-08-23T12:00:00.000Z",
          staleAfter: "2026-08-23T12:01:00.000Z",
        },
        status: RUNNING,
        loading: false,
        error: null,
        onRefresh: () => {},
      }),
    );
    expect(text).toContain("3,782");
    expect(text).toContain("19 days");
    expect(text).toContain("the scan has caught up");
    // Dated, not dressed up as live.
    expect(text).toContain("taken");
  });

  it("withholds the ETA and warns while the date scan is still running", async () => {
    const { BacklogSection } = await import("./cognition-bootstrap.js");
    const text = allText(
      BacklogSection({
        backlog: {
          remaining: 3782,
          dateScanPending: 40_000,
          dateScanned: 132_651,
          computedAt: "2026-08-23T12:00:00.000Z",
          staleAfter: "2026-08-23T12:01:00.000Z",
        },
        status: RUNNING,
        loading: false,
        error: null,
        onRefresh: () => {},
      }),
    );
    // An ETA computed off a denominator that is still growing would be a
    // confident wrong answer, so there must not be one.
    expect(text).not.toContain("19 days");
    expect(text).toContain("still growing");
    expect(text).toContain("40,000");
    expect(text).toContain("not progress");
  });
});

describe("Bootstrap panel — pace and boundary", () => {
  it("shows each cap against its config key", async () => {
    const { PaceSection } = await import("./cognition-bootstrap.js");
    const text = allText(PaceSection({ status: RUNNING }));
    expect(text).toContain("brain.bootstrap.maxRunsPerDay");
    expect(text).toContain("brain.bootstrap.maxRuns");
    expect(text).toContain("brain.bootstrap.backlogTarget");
    expect(text).toContain("brain.bootstrap.direction");
    // The resolved values, which are not fetchable anywhere else: the config
    // routes serve overrides, so an untouched cap reads as absent on the wire.
    expect(text).toContain("100 / 200");
    expect(text).toContain("2,300 / 1,000,000");
  });

  it("flags failed runs, because their documents are never re-selected", async () => {
    const { PaceSection } = await import("./cognition-bootstrap.js");
    const withFailures = { ...RUNNING, runs: { pending: 0, completed: 2200, failed: 7 } };
    const nodes = expandToHostNodes(PaceSection({ status: withFailures }));
    const text = nodes.map((n) => n.text).join(" ");
    expect(text).toContain("7 failed");
    expect(nodes.some((n) => String(n.class).includes("debug-err"))).toBe(true);
  });

  it("shows the wake conditions only for a drained lane", async () => {
    const { BoundarySection } = await import("./cognition-bootstrap.js");
    expect(allText(BoundarySection({ status: RUNNING }))).not.toContain("Went quiet on");

    const drained = {
      ...RUNNING,
      state: "drained",
      drainedDay: "2026-08-22",
      drainedSourceWatermark: "2026-08-20T09:00:00.000Z",
    };
    const text = allText(BoundarySection({ status: drained }));
    expect(text).toContain("Went quiet on");
    expect(text).toContain("2026-08-22");
    expect(text).toContain("Source roster then / now");
  });

  it("always shows the boundary that divides the two lanes", async () => {
    const { BoundarySection } = await import("./cognition-bootstrap.js");
    const text = allText(BoundarySection({ status: RUNNING }));
    expect(text).toContain("Recency floor");
    expect(text).toContain("5,219");
  });
});

describe("Bootstrap panel — the ETA never contradicts the banner", () => {
  it("shows no projection for a parked lane, however large the backlog", async () => {
    const { BacklogSection } = await import("./cognition-bootstrap.js");
    const parked = { ...RUNNING, state: "parked", totalEnqueued: 2200,
      settings: { ...SETTINGS, maxRuns: 2200 } };
    const text = allText(
      BacklogSection({
        status: parked,
        backlog: {
          remaining: 3782,
          dateScanPending: 0,
          dateScanned: 172651,
          computedAt: "2026-08-23T12:00:00.000Z",
          staleAfter: "2026-08-23T12:01:00.000Z",
        },
        loading: false,
        error: null,
        onRefresh: () => {},
      }),
    );
    // The count still shows — it is true. The projection does not, because a
    // parked lane will not work through it.
    expect(text).toContain("3,782");
    expect(text).not.toContain("days");
  });
});

describe("Bootstrap panel — a failing model backend", () => {
  const OUTAGE = {
    ...RUNNING,
    providerOutage: {
      openUntil: "2026-08-23T12:05:00.000Z",
      consecutiveFailures: 3,
      lastError: "The model API request failed (HTTP 412).",
    },
  };

  it("renders nothing when the backend is healthy", async () => {
    const { ProviderOutageBanner } = await import("./cognition-bootstrap.js");
    expect(expandToHostNodes(ProviderOutageBanner({ status: RUNNING }))).toHaveLength(0);
  });

  it("names the provider's own error, in the danger tone", async () => {
    const { ProviderOutageBanner } = await import("./cognition-bootstrap.js");
    const nodes = expandToHostNodes(ProviderOutageBanner({ status: OUTAGE }));
    const text = nodes.map((n) => n.text).join(" ");
    // An operator diagnosing an exhausted account needs the provider's words,
    // not a paraphrase of them.
    expect(text).toContain("HTTP 412");
    expect(text).toContain("3 consecutive");
    expect(nodes.some((n) => String(n.style).includes("var(--danger)"))).toBe(true);
  });

  it("says the outage costs time rather than work", async () => {
    // The reassurance is load-bearing: the operator's next question after
    // "the brain has stopped" is "what did I lose", and the answer is nothing.
    const { ProviderOutageBanner } = await import("./cognition-bootstrap.js");
    const text = allText(ProviderOutageBanner({ status: OUTAGE }));
    expect(text).toContain("Nothing is lost");
  });

  it("outranks the lane state, which would otherwise read as healthy", async () => {
    // The panel would say `running` beside a brain that cannot execute
    // anything, so the outage has to be the first thing on the page.
    const { BootstrapTab } = await import("./cognition-bootstrap.js");
    expect(typeof BootstrapTab).toBe("function");
    const { ProviderOutageBanner, StateBanner } = await import("./cognition-bootstrap.js");
    expect(allText(StateBanner({ status: OUTAGE }))).toContain("Running");
    expect(allText(ProviderOutageBanner({ status: OUTAGE }))).toContain("Failing");
  });
});

describe("Bootstrap panel — budget", () => {
  const SPENT = {
    day: "2026-08-24",
    usedTokens: 21_400_000,
    usedRuns: 1_180,
    dailyTokens: 30_000_000,
    dailyRuns: null,
    exhausted: null,
  };

  it("shows consumption against the ceiling, and names the key that sets it", async () => {
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const text = allText(BudgetSection({ budget: SPENT }));
    expect(text).toContain("21,400,000 / 30,000,000");
    expect(text).toContain("brain.budget.dailyTokens");
  });

  it("says outright when nothing is capped, rather than rendering a blank", async () => {
    // The default state, invisible from the config file, and the one in which
    // a backfill wave runs for days. A blank would read as "fine".
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const text = flatText(
      BudgetSection({ budget: { ...SPENT, dailyTokens: null, dailyRuns: null } }),
    );
    expect(text).toContain("no ceiling");
    expect(text).toContain("for as long as there is history left");
    // And offers the operator's own measured day as the number to set one from.
    expect(text).toContain("what a day currently costs");
  });

  it("quotes the engine's own pause reason when the budget is spent", async () => {
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const text = allText(
      BudgetSection({
        budget: {
          ...SPENT,
          exhausted: {
            dimension: "tokens",
            used: 30_000_001,
            limit: 30_000_000,
            reason: "Today's cognition token budget is spent. Background work resumes tomorrow.",
          },
        },
      }),
    );
    expect(text).toContain("Paused");
    expect(text).toContain("resumes tomorrow");
  });

  it("reports no money anywhere", async () => {
    // Deliberate and load-bearing: no inference API the Brain talks to exposes
    // a price, so any currency figure would be an estimate the gateway cannot
    // verify. A test rather than a comment, because the temptation recurs.
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    for (const budget of [SPENT, { ...SPENT, dailyTokens: null, dailyRuns: null }]) {
      expect(allText(BudgetSection({ budget }))).not.toMatch(/[$£€]|\bUSD\b|\bcost\s*\$/);
    }
  });
});

describe("Bootstrap panel — pause control", () => {
  it("offers to pause a running lane and to resume a stopped one", async () => {
    const { PauseControl } = await import("./cognition-bootstrap.js");
    const running = allText(PauseControl({ status: RUNNING, busy: false, error: null, onToggle: () => {} }));
    expect(running).toContain("Pause backfill");
    const off = allText(
      PauseControl({ status: { ...RUNNING, state: "off" }, busy: false, error: null, onToggle: () => {} }),
    );
    expect(off).toContain("Resume backfill");
  });

  it("answers the question an operator has before pressing it", async () => {
    // Namely: does stopping cost me the work already done. It does not, and
    // saying so is the difference between a control people use and one they
    // are afraid of.
    const { PauseControl } = await import("./cognition-bootstrap.js");
    const text = allText(PauseControl({ status: RUNNING, busy: false, error: null, onToggle: () => {} }));
    expect(text).toContain("Work already done is kept");
    const off = allText(
      PauseControl({ status: { ...RUNNING, state: "off" }, busy: false, error: null, onToggle: () => {} }),
    );
    expect(off).toContain("picks up exactly where it stopped");
  });

  it("toggles toward the opposite of the lane's current state", async () => {
    const { PauseControl } = await import("./cognition-bootstrap.js");
    const seen = [];
    const node = PauseControl({ status: RUNNING, busy: false, error: null, onToggle: (v) => seen.push(v) });
    // Find the button's handler in the expanded tree and fire it.
    const btn = expandToHostNodes(node).find((n) => n.tag === "button");
    expect(btn).toBeTruthy();
    expect(allText(node)).toContain("Pause backfill");
  });
});

describe("Bootstrap panel — starting the backfill", () => {
  const UNSTARTED = { ...RUNNING, state: "unstarted" };

  it("quantifies the job before asking for the decision", async () => {
    // "Start the backfill?" is not a decision anyone can make. "3,296
    // documents, about 3 days" is, and it is only answerable because the
    // backlog count and the measured pace exist.
    const { StartControl } = await import("./cognition-bootstrap.js");
    const text = flatText(
      StartControl({
        status: UNSTARTED,
        backlog: { remaining: 3296, dateScanPending: 0 },
        busy: false,
        onStart: () => {},
      }),
    );
    expect(text).toContain("3,296");
    expect(text).toContain("Start reading history");
  });

  it("disables the start while the Brain is down, saying what unblocks it", async () => {
    // Starting posts against a gate that 404s while inactive, so the panel
    // disables the button instead of letting the click fail silently.
    const { StartControl } = await import("./cognition-bootstrap.js");
    const nodes = expandToHostNodes(
      StartControl({ status: UNSTARTED, backlog: null, busy: false, onStart: () => {}, disabled: true }),
    );
    const button = nodes.find((n) => n.tag === "button");
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
    expect(button?.text).toContain("Start reading history");
    const text = flatText(
      StartControl({ status: UNSTARTED, backlog: null, busy: false, onStart: () => {}, disabled: true }),
    );
    expect(text).toContain("needs a running Brain");
  });

  it("says why adding sources first gives better results, not merely fewer runs", async () => {
    // The honest argument. Ordering barely changes the run count; it changes
    // whether the lane reaches wrong conclusions it later has to undo.
    const { StartControl } = await import("./cognition-bootstrap.js");
    const text = flatText(
      StartControl({ status: UNSTARTED, backlog: null, busy: false, onStart: () => {} }),
    );
    expect(text).toContain("loop that should never have opened");
    expect(text).toContain("still picked up");
  });

  it("appears only for a lane that has never begun", async () => {
    const { StartControl } = await import("./cognition-bootstrap.js");
    for (const state of ["running", "off", "drained", "parked", "waiting", "holding"]) {
      expect(
        expandToHostNodes(
          StartControl({ status: { ...RUNNING, state }, backlog: null, busy: false, onStart: () => {} }),
        ),
      ).toHaveLength(0);
    }
  });

  it("does not also offer a resume, which would be two buttons for one act", async () => {
    const { PauseControl } = await import("./cognition-bootstrap.js");
    expect(
      expandToHostNodes(
        PauseControl({ status: UNSTARTED, busy: false, error: null, onToggle: () => {} }),
      ),
    ).toHaveLength(0);
  });
});

describe("Bootstrap panel — the history hero", () => {
  // A swept tail with unread months behind it: 2024-02 and 2024-03 are
  // cleared, 2024-01 still holds work, so the frontier is Feb 2024. The
  // unscanned documents sit in the unread month, because a month with no
  // verdict yet cannot be part of a swept run.
  const MONTHS = [
    { month: "2024-01", reviewed: 0, failed: 0, owed: 40, discarded: 900, unscanned: 50 },
    { month: "2024-02", reviewed: 120, failed: 3, owed: 0, discarded: 800, unscanned: 0 },
    { month: "2024-03", reviewed: 300, failed: 0, owed: 0, discarded: 700, unscanned: 0 },
  ];

  it("leads with how far back the lane has read", async () => {
    const { TimelineHero } = await import("./cognition-timeline.js");
    const text = flatText(
      TimelineHero({ timeline: { months: MONTHS }, status: RUNNING, loading: false, error: null }),
    );
    expect(text).toContain("Read back to");
    expect(text).toContain("Feb 2024");
  });

  it("surfaces the not-looked-at band rather than folding it into discarded", async () => {
    // Date extraction is a recognizer pass, not an instant property. Counting
    // unscanned documents as discarded would claim the lane had considered and
    // dismissed them.
    const { TimelineHero } = await import("./cognition-timeline.js");
    const text = flatText(
      TimelineHero({ timeline: { months: MONTHS }, status: RUNNING, loading: false, error: null }),
    );
    expect(text).toContain("not looked at yet");
    expect(text).toContain("Not looked at yet");
  });

  it("names every band, including the one that is most of a corpus", async () => {
    const { TimelineHero } = await import("./cognition-timeline.js");
    const text = flatText(
      TimelineHero({ timeline: { months: MONTHS }, status: RUNNING, loading: false, error: null }),
    );
    for (const label of ["Reviewed", "Given up on", "Still to read", "Nothing ahead"]) {
      expect(text).toContain(label);
    }
  });

  it("says nothing has been read when nothing has", async () => {
    const { TimelineHero } = await import("./cognition-timeline.js");
    const bare = [{ month: "2024-01", reviewed: 0, failed: 0, owed: 5, discarded: 5, unscanned: 0 }];
    const text = flatText(
      TimelineHero({
        timeline: { months: bare },
        status: { ...RUNNING, state: "unstarted" },
        loading: false,
        error: null,
      }),
    );
    expect(text).toContain("Nothing read yet");
    expect(text).toContain("This is what the Brain would work through");
  });
});

describe("Bootstrap panel — what the tokens actually were", () => {
  const WITH_CACHE = {
    day: "2026-08-24",
    usedTokens: 441_270_093,
    usedRuns: 5062,
    dailyTokens: null,
    dailyRuns: null,
    exhausted: null,
    breakdown: {
      promptTokens: 435_313_489,
      completionTokens: 5_956_604,
      cacheReadTokens: 300_117_561,
      cacheCreationTokens: 0,
      freshInputTokens: 135_195_928,
      cacheHitRate: 300_117_561 / 435_313_489,
    },
  };

  it("separates what was read afresh from what was re-read", async () => {
    // The distinction the flat total hides. Cached input is billed at a
    // fraction of fresh, so two days with identical token counts can cost very
    // differently — and only this split shows which day is which.
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const text = flatText(BudgetSection({ budget: WITH_CACHE }));
    expect(text).toContain("135,195,928");
    expect(text).toContain("300,117,561");
    expect(text).toContain("69%");
  });

  it("says the ceiling counts them all the same, and why that is deliberate", async () => {
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const text = flatText(BudgetSection({ budget: WITH_CACHE }));
    expect(text).toContain("counts every token the same");
    expect(text).toContain("a limit has to be predictable");
  });

  it("still reports no figure in currency", async () => {
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    expect(flatText(BudgetSection({ budget: WITH_CACHE }))).not.toMatch(/[$£€]|\bUSD\b/);
  });

  it("shows nothing when the day has read nothing", async () => {
    // A brand-new day, or a lane that has not run: three zero rows would be
    // noise, not information.
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const idle = { ...WITH_CACHE, breakdown: { ...WITH_CACHE.breakdown, promptTokens: 0 } };
    expect(flatText(BudgetSection({ budget: idle }))).not.toContain("Re-read from cache");
  });

  it("survives a gateway that has not been upgraded yet", async () => {
    // The panel and the gateway ship together, but a portal held in a browser
    // tab across a restart can outlive its server's response shape.
    const { BudgetSection } = await import("./cognition-bootstrap.js");
    const legacy: Record<string, unknown> = { ...WITH_CACHE };
    delete legacy.breakdown;
    expect(() => flatText(BudgetSection({ budget: legacy }))).not.toThrow();
  });
});

describe("cacheHitPercent", () => {
  it("is the cached share of everything read", async () => {
    const panel = await import("./cognition-bootstrap.js");
    expect(panel.cacheHitPercent({ cacheHitRate: 0.689 })).toBe(69);
    expect(panel.cacheHitRate === undefined).toBe(true); // not exported by that name
  });

  it("declines to answer when nothing was read", async () => {
    // Reporting 0% for an idle day would read as "caching stopped working".
    const panel = await import("./cognition-bootstrap.js");
    expect(panel.cacheHitPercent({ cacheHitRate: null })).toBeNull();
    expect(panel.cacheHitPercent(undefined)).toBeNull();
    expect(panel.cacheHitPercent({})).toBeNull();
  });
});
