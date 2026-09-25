// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Semantic search-quality regression net.
 *
 * This is the net the `golden-corpus` e2e deliberately omits: golden-corpus
 * asserts ranking/people/search over the LIKE-based `/documents/search`
 * because the synthetic universe ships no embedder model, so the vector index
 * is empty and the full `POST /search` pipeline would return nothing. Here we
 * wire a REAL embedder (the local `:8001` Qwen3-Embedding endpoint) and assert
 * absolute quality floors on the real `POST /search` pipeline (BM25 + vector +
 * fusion + MMR + ISF).
 *
 * The corpus is INVENTED (fictional docs/queries — no operator corpus, per the
 * repo privacy rules) and carries two judged query families, because search
 * runs ONE pipeline and there is no second, lexical-only mode to compare
 * against. Absolute floors therefore have to be chosen so that a pipeline
 * missing its vector lane cannot reach them:
 *
 *   SEMANTIC (9 GOLD/DECOY pairs) — measures RETRIEVAL BY MEANING via recall@10.
 *     Each query is worded in its DECOY's vocabulary: the decoy repeats the
 *     query's surface words but answers nothing, while the GOLD doc that does
 *     answer it shares no salient surface word with the query. A separate
 *     lexical-reach test asserts per run that BM25 matches only a handful of the
 *     48 documents for each of these queries, so the top-10 window is the vector
 *     lane's to fill — that is what keeps the recall floor from going vacuous.
 *
 *   DIRECT (8 plainly-worded queries) — measures ORDERING via hit@1. Their gold
 *     docs are ordinary background documents that any competent ranker should
 *     put first. This family is what catches a fusion / MMR / boost regression
 *     that shuffles a correct result off the top spot, which recall@10 on the
 *     semantic family is far too coarse to see.
 *
 * The two are deliberately complementary: the semantic family cannot assert
 * hit@1 (its decoys quote the query verbatim, so a lexical rank-1 for the decoy
 * is expected, not a defect) and the direct family cannot assert semantics.
 *
 * Dependency policy (FROZEN by epic #804 / C12): the `:8001` embedder is a
 * REQUIRED dependency. On a CI runner an unreachable `:8001` FAILS the job
 * loudly (never a silent skip); only on a developer's local machine does an
 * unreachable `:8001` skip the semantic assertions. The URL + model id read
 * from env with generic, non-operator-private defaults.
 */

import "./synth-env.js";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";

// Generic defaults — never an operator-private value. `:8001` / localhost is
// the conventional local embedder endpoint documented for this project; both
// are overridable so the lane works against any OpenAI-compatible embedder.
// The URL is the BARE base (no `/v1`): the gateway's HttpEmbedder appends the
// `/v1` api-path prefix itself, so passing it here would double it.
const EMBEDDER_URL = process.env.OMNESIS_TEST_EMBEDDER_URL ?? "http://localhost:8001";
const EMBEDDER_MODEL = process.env.OMNESIS_TEST_EMBEDDER_MODEL ?? "Qwen/Qwen3-Embedding-0.6B";

/**
 * A CI runner must FAIL on an unreachable required dependency; only a local
 * dev box may skip. GitHub Actions sets `CI` and `GITHUB_ACTIONS`; the
 * self-hosted runners additionally set `RUNNER_NAME`. Any of these flips us
 * into fail-loud mode.
 */
const IS_CI = Boolean(process.env.CI || process.env.GITHUB_ACTIONS || process.env.RUNNER_NAME);

interface SearchResult {
  documentId: string;
  title: string;
  score: number;
  sourceId?: string;
}
interface VectorStageReport {
  status?: "ran" | "skipped";
  candidates?: number;
  reason?: string;
}
interface Bm25StageReport {
  status?: "ran" | "skipped";
  /** Documents the lexical lane matched — the lexical-reach net reads this. */
  candidates?: number;
}
interface SearchResponse {
  results?: SearchResult[];
  stages?: { vector?: VectorStageReport; bm25?: Bm25StageReport };
}

/**
 * Probe `:8001` once. Reachable → run the semantic suite. Unreachable on a CI
 * runner → throw (fail the job loudly). Unreachable on a local box → skip.
 */
async function probeEmbedderReachable(): Promise<boolean> {
  const base = EMBEDDER_URL.replace(/\/+$/, "");
  try {
    // `/v1/models` — the same OpenAI-compatible listing the gateway's embedder
    // probe hits (the URL is the bare base; `/v1` is the api-path prefix).
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SeedDoc {
  externalId: string;
  title: string;
  content: string;
}

/**
 * One SEMANTIC judged query and the pair of documents it discriminates between.
 * `gold` is the only relevant document; `decoy` is the surface-word match a
 * term-matching ranker prefers. Titles are the relevance labels — they are
 * unique across the corpus and never a real-corpus string.
 */
interface JudgedPair {
  query: string;
  gold: SeedDoc;
  decoy: SeedDoc;
}

const SEMANTIC_PAIRS: ReadonlyArray<JudgedPair> = [
  {
    query: "what should I feed my hungry kitten",
    gold: {
      externalId: "gold-feline",
      title: "Whiskers Nutrition Guide",
      content:
        "A grown house cat thrives on a protein-rich diet. Offer small portions of cooked poultry " +
        "or quality wet kibble twice daily, always leave fresh water within reach, and keep the " +
        "feeding bowl spotless so your pet stays content and energetic.",
    },
    decoy: {
      externalId: "decoy-feline",
      title: "Office Pet Policy Draft",
      content:
        "The new office policy on what to feed a hungry kitten during long meetings is under review. " +
        "Staff keep asking what to feed the hungry kitten that wandered into reception last week.",
    },
  },
  {
    query: "should I bring an umbrella if it might rain",
    gold: {
      externalId: "gold-umbrella",
      title: "Forecast Companion Note",
      content:
        "Grey clouds gathering over the bay usually mean a downpour by afternoon. Pack a folding " +
        "parasol and waterproof boots before you head out, and the sudden cloudburst won't catch " +
        "you off guard on your walk home.",
    },
    decoy: {
      externalId: "decoy-umbrella",
      title: "Insurance Claim Summary",
      content:
        "Should I bring an umbrella when it might rain on the drive? The umbrella in the rain clause " +
        "of the policy covers weather damage; bring the umbrella receipt when you file in the rain.",
    },
  },
  {
    query: "how do I tune my guitar",
    gold: {
      externalId: "gold-tuning",
      title: "Six String Setup",
      content:
        "When a fretted instrument sounds sour, turn each peg slowly while plucking the open course " +
        "until the pitch matches a reference tone. Tighten to raise it and loosen to drop it, then " +
        "let the strings settle before you play a chord.",
    },
    decoy: {
      externalId: "decoy-tuning",
      title: "Radio Schedule Memo",
      content:
        "How do I tune my guitar before the show on the radio? The radio guitar segment needs you to " +
        "tune the guitar amp early so the tune stays clean on air.",
    },
  },
  {
    query: "how do I fix a flat bike tyre",
    gold: {
      externalId: "gold-puncture",
      title: "Two Wheel Roadside Repair",
      content:
        "When the rubber loses air on the trail, lever the casing off the rim, find the leak by " +
        "listening for a hiss or dunking the inner tube in water, seal the hole with a patch, then " +
        "pump it back to pressure and refit the wheel.",
    },
    decoy: {
      externalId: "decoy-puncture",
      title: "Courier Expense Note",
      content:
        "The invoice to fix a flat bike tyre for the courier fleet is still outstanding. Accounts " +
        "will process the flat bike tyre claim next quarter once the fix is approved.",
    },
  },
  {
    query: "what temperature should I roast a chicken at",
    gold: {
      externalId: "gold-poultry",
      title: "Sunday Bird Timings",
      content:
        "Set the oven to a hot one hundred and ninety degrees, allow twenty minutes per five hundred " +
        "grams plus twenty more, and rest the bird under foil for a quarter of an hour before carving " +
        "so the juices settle back into the meat.",
    },
    decoy: {
      externalId: "decoy-poultry",
      title: "Break Room Thermostat Ticket",
      content:
        "Someone asked what temperature should I roast a chicken at in the break room chat. The " +
        "thermostat temperature dispute and the roast chicken argument are logged as one ticket.",
    },
  },
  {
    query: "how do I get a stain out of a shirt",
    gold: {
      externalId: "gold-laundry",
      title: "Fabric Mark Removal",
      content:
        "Blot the fresh mark with cold water rather than rubbing it in, dab a little washing liquid " +
        "onto the fibres, leave it a quarter of an hour, then launder the garment at the warmest " +
        "setting the care label allows.",
    },
    decoy: {
      externalId: "decoy-laundry",
      title: "Gallery Opening Notes",
      content:
        "A visitor asked how do I get a stain out of a shirt during the stained glass tour. The shirt " +
        "and stain question came up twice on the walkaround.",
    },
  },
  {
    query: "when should I water my houseplants",
    gold: {
      externalId: "gold-plants",
      title: "Indoor Greenery Care",
      content:
        "Push a finger two centimetres into the compost. If it feels dry, give the pot a slow drink " +
        "until liquid runs from the drainage holes, then let it drain fully. Through the darker " +
        "months the roots need far less.",
    },
    decoy: {
      externalId: "decoy-plants",
      title: "Utility Billing Query",
      content:
        "The tenant asked when should I water my houseplants using the shared supply. The water " +
        "charge attributable to houseplants is not itemised on the bill.",
    },
  },
  {
    query: "how long should I boil an egg",
    gold: {
      externalId: "gold-breakfast",
      title: "Morning Timing Card",
      content:
        "Lower the shell gently into barely simmering liquid. Six minutes leaves the yolk runny, " +
        "eight gives a soft centre, ten sets it firm all the way through. Cool it under the cold tap " +
        "to stop the cooking.",
    },
    decoy: {
      externalId: "decoy-breakfast",
      title: "Hotplate Safety Memo",
      content:
        "Do not ask how long should I boil an egg on the laboratory hotplate. The boil notice and the " +
        "egg allergy notice are separate documents; boil times are posted elsewhere.",
    },
  },
  {
    query: "how do I change a lightbulb in the ceiling",
    gold: {
      externalId: "gold-fixture",
      title: "Overhead Fitting Swap",
      content:
        "Cut the power at the consumer unit first and let the old lamp cool. Twist it free of the " +
        "holder, seat the replacement squarely so the contacts meet, then restore the circuit and " +
        "test it from the wall switch.",
    },
    decoy: {
      externalId: "decoy-fixture",
      title: "Facilities Backlog Item",
      content:
        "A ticket asks how do I change a lightbulb in the ceiling tile store. The ceiling lightbulb " +
        "change request is queued behind the roof survey.",
    },
  },
];

/**
 * Background documents. Most are unjudged but load-bearing: with only the 18
 * paired docs, "gold in the top 10" would be nearly free, so this pool pushes
 * the corpus past 45 documents and makes a top-10 window a real selection. A
 * subset are also the gold docs of the DIRECT family below. Topics are invented
 * and deliberately disjoint from the nine semantic topics.
 */
const BACKGROUND: ReadonlyArray<SeedDoc> = [
  [
    "Weeknight Pasta Idea",
    "Toss cooked spaghetti with garlic, chilli flakes and grated cheese for a fast midweek dinner. Finish with chopped parsley and a squeeze of lemon.",
  ],
  [
    "Coastal Trip Plan",
    "We rented a small cottage near the harbour for the long weekend, walked the cliff path each morning, and watched the fishing boats come in at dusk.",
  ],
  [
    "Standup Recap",
    "Quick sync this morning: the design review slipped to Thursday, the analytics dashboard is in QA, and onboarding docs need one more pass.",
  ],
  [
    "Quarterly Budget Note",
    "Travel spend came in under forecast while contractor costs ran over. The reforecast lands with finance on the fifteenth.",
  ],
  [
    "Marathon Training Block",
    "Twelve weeks out the long run steps up to eighteen miles, with one tempo session and two easy recovery jogs each week.",
  ],
  [
    "Loft Insulation Quote",
    "The installer quoted for two hundred millimetres of mineral wool across the joists, with the hatch draught-sealed separately.",
  ],
  [
    "Book Club Shortlist",
    "Three titles made the shortlist: a translated crime novel, a history of canals, and a short story collection about migration.",
  ],
  [
    "Server Migration Runbook",
    "Drain traffic from the old pool, snapshot the volumes, cut DNS with a sixty second TTL, then verify checksums before decommissioning.",
  ],
  [
    "Allotment Rota",
    "Watering duty rotates weekly through the summer; the shed key lives in the combination box on the gate post.",
  ],
  [
    "Cycling Club Ride Report",
    "Forty riders took the northern loop in blustery conditions, splitting into three groups at the first climb.",
  ],
  [
    "Piano Lesson Notes",
    "Practise the left hand alone at half speed, count the syncopation out loud, and revisit the scale sheet before the next lesson.",
  ],
  [
    "Camera Settings Cheat Sheet",
    "For low light, open the aperture wide, lift the sensitivity to sixteen hundred, and keep the shutter above a sixtieth of a second.",
  ],
  [
    "Board Game Night Plan",
    "Two short games to open, one long strategy game after food, and a card game to finish if anyone is still awake.",
  ],
  [
    "Bathroom Regrouting Steps",
    "Rake out the old grout, vacuum the joints, work the new mix in diagonally, then polish the haze off once it has firmed up.",
  ],
  [
    "Language Exchange Schedule",
    "Half an hour of conversation in each language, alternating who leads, with a shared vocabulary sheet after every session.",
  ],
  [
    "Winter Tyre Storage",
    "Stack them flat in a cool dry place away from sunlight, marked with the corner they came from so the rotation stays even.",
  ],
  [
    "Sourdough Starter Log",
    "Fed at eight each morning with equal weights of flour and water; it doubles in about five hours at room temperature.",
  ],
  [
    "Home Network Layout",
    "The router sits in the hallway cupboard, with a wired link to the study and a mesh node covering the upstairs rooms.",
  ],
  [
    "Charity Run Registration",
    "Entries close at the end of the month; the fee includes a timing chip and a place in the second start wave.",
  ],
  [
    "Chess Club Notice",
    "Ladder matches run on alternate Tuesdays; report results on the board within two days or the fixture is void.",
  ],
  [
    "Attic Conversion Enquiry",
    "The surveyor flagged the head height at the ridge and the position of the water tank as the two constraints.",
  ],
  [
    "Wildlife Pond Notes",
    "Shallow shelves on one side let frogs climb out; oxygenating plants went in during the first warm week of spring.",
  ],
  [
    "Podcast Editing Workflow",
    "Level the two tracks separately, cut the long pauses, add the intro bed, then export at a consistent loudness target.",
  ],
  [
    "Museum Visit Plan",
    "Start on the top floor and work down, book the special exhibition slot for after lunch, and leave time for the sculpture garden.",
  ],
  [
    "Kayak Storage Rack",
    "Two padded arms bolted into the studs, angled slightly upwards so the hull sits on its side and keeps its shape.",
  ],
  [
    "Community Choir Rehearsal",
    "Warm-ups at seven, new piece from bar forty, and the concert running order confirmed before we finish.",
  ],
  [
    "Vegetable Box Subscription",
    "Deliveries land on Thursday evenings; the contents rotate seasonally and swaps must be logged by Tuesday noon.",
  ],
  [
    "Woodworking Bench Build",
    "Laminated beech top on a trestle base, with a face vice at the left end and dog holes across the front edge.",
  ],
  [
    "Photography Walk Route",
    "The route follows the canal to the old bridge, doubles back through the market, and finishes at the viewpoint for sunset.",
  ],
  [
    "Roof Gutter Clearing",
    "Scoop the debris into a bucket rather than flushing it down, then run water through to check the fall towards the downpipe.",
  ],
].map(([title, content], i) => ({
  externalId: `background-${i}`,
  title: title!,
  content: content!,
}));

const CORPUS: ReadonlyArray<SeedDoc> = [
  ...SEMANTIC_PAIRS.flatMap((p) => [p.gold, p.decoy]),
  ...BACKGROUND,
];

/**
 * DIRECT family: plainly-worded query → the background document that plainly
 * answers it. No adversarial decoy; the point is that a correct result stays at
 * rank 1 through fusion, MMR, dedup and the boost passes.
 */
const DIRECT_QUERIES: ReadonlyArray<{ query: string; goldTitle: string }> = [
  { query: "how often should I feed my sourdough starter", goldTitle: "Sourdough Starter Log" },
  {
    query: "steps for cutting over DNS during a server migration",
    goldTitle: "Server Migration Runbook",
  },
  {
    query: "how many miles is the long run in marathon training",
    goldTitle: "Marathon Training Block",
  },
  {
    query: "editing a podcast and exporting at a consistent loudness",
    goldTitle: "Podcast Editing Workflow",
  },
  { query: "quote for mineral wool loft insulation", goldTitle: "Loft Insulation Quote" },
  { query: "camera settings for shooting in low light", goldTitle: "Camera Settings Cheat Sheet" },
  { query: "how do I regrout the bathroom tiles", goldTitle: "Bathroom Regrouting Steps" },
  { query: "what is the rota for watering the allotment", goldTitle: "Allotment Rota" },
];

/**
 * Absolute quality floors on the single search pipeline. These are MEASURED
 * numbers with deliberate headroom, not aspirations. Measured on
 * Qwen3-Embedding-0.6B over the 48-document corpus above:
 *
 *   family    metric      measured   floor
 *   semantic  recall@10   9/9        8/9 ≈ 0.88
 *   direct    hit@1       8/8        6/8 = 0.75
 *
 * The floors assume the DEFAULT embedder model (Qwen3-Embedding-0.6B). A runner
 * that substitutes another model via `OMNESIS_TEST_EMBEDDER_MODEL` is measuring
 * that model against numbers calibrated for this one; a red build there is a
 * statement about the substituted model, not necessarily a pipeline regression.
 *
 * What keeps the semantic floor from going quietly vacuous is the lexical-reach
 * net rather than a control arm: see {@link MAX_LEXICAL_REACH} for why a per-run
 * BM25-only gateway is not reachable through any config knob, and what was
 * measured off-line instead.
 *
 * Margins. Each floor sits one or two judged queries below what the pipeline
 * actually delivers, which is the useful band: a floor AT the measured value
 * turns any single embedding wobble into a red build, while a floor far below it
 * stays green through a real regression. Semantic recall gets one query of slack
 * because it is a near-binary property of the vector lane — losing two at once is
 * a fault, not noise. Direct hit@1 gets two because exact rank-1 ordering is the
 * most sensitive thing here to legitimate fusion/MMR/boost retuning, which this
 * suite should not block.
 *
 * The semantic family deliberately does NOT assert hit@1: its decoys quote the
 * query verbatim, so they take rank 1 in every measured run (0/9 hit@1 even with
 * the vector lane healthy). A floor there would be vacuous by construction. The
 * gold and decoy ranks are still printed for diagnosis.
 */
const FLOOR_SEMANTIC_RECALL_AT_10 = 8 / 9;
const FLOOR_DIRECT_HIT_AT_1 = 6 / 8;

/**
 * Why there is no per-run BM25-only control arm, and what stands in for it.
 *
 * A second gateway running this corpus with the vector lane removed would be the
 * ideal control. Three routes to one were tried and none is reachable:
 *
 *   1. Boot a gateway with NO embedder assigned. `indexer-lifecycle` resolves
 *      the embedder role before starting the indexer worker and returns early
 *      when it is unresolved, so `index.db` is never populated at all — not even
 *      the FTS5 table. Every query returns zero results. Its 0/9 would be a
 *      statement about an empty index, not about this corpus.
 *   2. Keep the real embedder (so the index builds) and zero fusion's
 *      `search.params.vectorWeight`. That is an ORDERING knob, not a retrieval
 *      one: vector candidates still enter the candidate pool, and only their RRF
 *      contribution goes to zero. Measured, this scores 9/9 — unchanged — for
 *      the reason {@link MAX_LEXICAL_REACH} makes visible below.
 *   3. Zero `search.vector.hnswOverFetch` to starve the lane of candidates.
 *      `hnswSearchCandidates` floors its `effectiveK` at `candidateLimit`, so
 *      the multiplier cannot reach zero.
 *
 * Measured during development rather than per run: on a gateway whose index was
 * built and whose vector lane then contributes nothing, the nine gold docs are
 * absent from the results entirely. That number is NOT re-measured on every run
 * and must not be read as one.
 *
 * What IS measured every run is the property that number depended on — see
 * {@link MAX_LEXICAL_REACH}.
 */

/**
 * The corpus's adversarial property, asserted per run: for each semantic query,
 * BM25 matches at most this many of the 48 documents (measured: 4–7).
 *
 * This is the honest, per-run stand-in for the missing control. The response
 * carries 20 results while the lexical lane contributes fewer than ten
 * candidates, so most of the top-10 window — including every gold doc that a
 * term ranker cannot reach — can only have been placed there by the vector lane.
 * If a corpus edit ever made the golds lexically reachable, the BM25 candidate
 * count would climb through this ceiling and redden the lane, which is exactly
 * when the recall floor below would quietly stop meaning anything.
 */
const MAX_LEXICAL_REACH = 9;

let reachable = false;

// Probed in beforeAll; describe-level skip can't await, so the suite always
// REGISTERS and the body's first test enforces the CI-fail / local-skip policy.
describe("Semantic search quality on the real POST /search pipeline (C12)", () => {
  let harness: SyntheticE2EHarness | null = null;

  beforeAll(async () => {
    reachable = await probeEmbedderReachable();
    // Required-dependency policy: on a CI runner an unreachable embedder is a
    // hard failure — never a silent green. Locally it is a skip.
    if (!reachable) {
      if (IS_CI) {
        throw new Error(
          `search-quality.e2e: required embedder at ${EMBEDDER_URL} is unreachable on a CI ` +
            `runner. This is a REQUIRED dependency (epic #804 / C12) — failing loudly rather ` +
            `than skipping. Start the local embedding model (OpenAI-compatible /v1/embeddings) ` +
            `or point OMNESIS_TEST_EMBEDDER_URL at one.`,
        );
      }
      // Local dev box: leave harness null; the tests below short-circuit.
      return;
    }

    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      // Minimal universe = bounded, deterministic. We do NOT sync its sources;
      // we push our own invented judged corpus so recall is measured over a
      // known, fictional document set rather than universe fixtures.
      universe: "e2e-minimal",
      // Wire the REAL local embedder via the configured-backend hook (the same
      // injection C21's recorder uses). NO local GGUF (CUDA-crashes on this box)
      // and NO dependency on a local chat model — embedder only.
      extraInference: {
        backends: { localembed: { type: "http", url: EMBEDDER_URL } },
        assignments: { embedder: `localembed/${EMBEDDER_MODEL}` },
      },
      // WORKER-ON lane (Slice 3B). Candidate generation defaults to a dedicated
      // search worker (`gateway.searchWorker.concurrency` default 1), so the
      // spawned gateway already delegates the BM25 + usearch + fusion block to a
      // worker thread and this semantic recall net proves parity THROUGH the
      // worker, not the main-thread fallback. Pinning `concurrency: 1` here
      // makes the worker-on guarantee explicit and immune to a default change —
      // the whole `POST /search` pipeline (real 1024-dim embedder) runs its
      // heavy read off-main, and a worker-side ranking regression would show as
      // a drop below the floors asserted below.
      extraGatewayConfig: { gateway: { searchWorker: { concurrency: 1 } } },
    });
    // A judged title that no longer names a seeded document would silently
    // score 0 forever. Fail loudly at setup instead.
    const titles = new Set(CORPUS.map((d) => d.title));
    for (const t of [
      ...SEMANTIC_PAIRS.flatMap((p) => [p.gold.title, p.decoy.title]),
      ...DIRECT_QUERIES.map((q) => q.goldTitle),
    ]) {
      if (!titles.has(t)) {
        throw new Error(`search-quality.e2e: judged title "${t}" is not in the seeded corpus`);
      }
    }

    await harness.start();
    await harness.pushDocuments(
      CORPUS.map((d) => ({ externalId: d.externalId, title: d.title, content: d.content })),
    );
    // Embedding runs async in the indexer worker after the docs land. Poll a
    // sentinel query (refreshing the search snapshot each round) until the
    // vector stage actually returns candidates — so quality is never measured
    // on a cold index.
    await waitForVectorReady(harness);
  }, 300_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 30_000);

  async function waitForVectorReady(h: SyntheticE2EHarness, timeoutMs = 150_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await h.refreshSearchSnapshot();
      const res = await search(h, "feeding a house cat");
      const vec = res.stages?.vector;
      if (vec?.status === "ran" && (vec.candidates ?? 0) > 0 && (res.results?.length ?? 0) > 0) {
        return;
      }
      await sleep(2000);
    }
    throw new Error(
      "search-quality.e2e: vector stage never produced candidates within timeout — the real " +
        "embedder index did not come up (fail-loud rather than measure on a cold index).",
    );
  }

  async function search(h: SyntheticE2EHarness, text: string): Promise<SearchResponse> {
    return h.gatewayJson<SearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify({ text, limit: 20, verbose: true }),
    });
  }

  /** 1-based rank of a title, or 0 when absent from the result list. */
  function rankOf(results: SearchResult[] | undefined, title: string): number {
    const idx = (results ?? []).findIndex((r) => r.title === title);
    return idx === -1 ? 0 : idx + 1;
  }

  test("dimension adoption: the real embedder's vector stage runs (1024-dim Qwen3)", async () => {
    if (!reachable) {
      // Local-only skip path (CI already threw in beforeAll). Make the skip
      // visible rather than a silent green.
      process.stdout.write("\nsearch-quality.e2e: :8001 unreachable — skipping (local dev box).\n");
      return;
    }
    const h = harness!;
    // The gateway boot shell defaults to a 768-dim index; Qwen3-Embedding-0.6B
    // is 1024-dim. The vector stage running cleanly with candidates means the
    // HNSW read handle ADOPTED the embedder's real dimension on (re)view — the
    // exact dim-swap regression the read-handle refresh guards (project memory:
    // HNSW read-handle self-refresh). A dim mismatch would have thrown here.
    const res = await search(h, "feeding a house cat");
    expect(res.stages?.vector?.status, `vector stage: ${JSON.stringify(res.stages?.vector)}`).toBe(
      "ran",
    );
    expect(res.stages?.vector?.candidates ?? 0).toBeGreaterThan(0);
    expect((res.results ?? []).length).toBeGreaterThan(0);
  });

  test("lexical reach: BM25 alone cannot assemble the top-10 window", async () => {
    if (!reachable) {
      process.stdout.write("\nsearch-quality.e2e: :8001 unreachable — skipping (local dev box).\n");
      return;
    }
    const h = harness!;
    const n = SEMANTIC_PAIRS.length;
    const rows: string[] = [];
    const counts: number[] = [];

    for (const pair of SEMANTIC_PAIRS) {
      const res = await search(h, pair.query);
      const bm25 = res.stages?.bm25?.candidates ?? -1;
      counts.push(bm25);
      rows.push(
        `  bm25 matched ${String(bm25).padStart(2)}/${CORPUS.length} docs, ` +
          `${String(res.results?.length ?? 0).padStart(2)} results returned   "${pair.query}"`,
      );
    }

    process.stdout.write(
      `\nsearch-quality LEXICAL REACH (${n} queries, ${CORPUS.length} docs):\n${rows.join("\n")}\n` +
        `  max bm25 candidates=${Math.max(...counts)} (ceiling ${MAX_LEXICAL_REACH})\n`,
    );

    for (let i = 0; i < n; i++) {
      expect(
        counts[i],
        `"${SEMANTIC_PAIRS[i]!.query}" — BM25 matched ${counts[i]} of ${CORPUS.length} documents. ` +
          `The semantic family assumes its queries are lexically narrow, so that the top-10 window ` +
          `is filled by the vector lane and the recall floor below actually measures it. A count ` +
          `this high means a corpus edit has made these queries term-reachable and the floor is ` +
          `no longer the semantic net it claims to be`,
      ).toBeLessThanOrEqual(MAX_LEXICAL_REACH);
      // A zero would mean the BM25 lane itself is broken, which would make the
      // ceiling above pass for entirely the wrong reason.
      expect(counts[i], `BM25 matched nothing for "${SEMANTIC_PAIRS[i]!.query}"`).toBeGreaterThan(
        0,
      );
    }
  }, 180_000);

  test("semantic family: recall@10 — the gold docs a term ranker cannot reach", async () => {
    if (!reachable) {
      process.stdout.write("\nsearch-quality.e2e: :8001 unreachable — skipping (local dev box).\n");
      return;
    }
    const h = harness!;
    const K = 10;
    const n = SEMANTIC_PAIRS.length;

    let recallAtK = 0;
    const rows: string[] = [];

    for (const pair of SEMANTIC_PAIRS) {
      const res = await search(h, pair.query);
      const goldRank = rankOf(res.results, pair.gold.title);
      // Printed, never asserted — see the FLOOR_* block on why the decoy taking
      // rank 1 is expected behaviour rather than a defect.
      const decoyRank = rankOf(res.results, pair.decoy.title);
      if (goldRank > 0 && goldRank <= K) recallAtK++;
      rows.push(
        `  ${pair.gold.title.padEnd(26)} gold#${String(goldRank || "-").padEnd(3)} ` +
          `decoy#${decoyRank || "-"}   "${pair.query}"`,
      );
    }

    process.stdout.write(
      `\nsearch-quality SEMANTIC (${n} queries, ${CORPUS.length} docs, real ${EMBEDDER_MODEL}):\n` +
        `${rows.join("\n")}\n  recall@${K}=${recallAtK}/${n} (floor ${Math.ceil(
          FLOOR_SEMANTIC_RECALL_AT_10 * n,
        )}/${n})\n`,
    );

    expect(
      recallAtK / n,
      `recall@${K} = ${recallAtK}/${n} — gold docs that share no surface word with their query ` +
        `are falling out of the top-${K} window. The lexical-reach test above bounds BM25 to a ` +
        `handful of matches per query, so the window is the vector lane's to fill — this is it ` +
        `failing to retrieve, not a tuning wobble`,
    ).toBeGreaterThanOrEqual(FLOOR_SEMANTIC_RECALL_AT_10);
  }, 180_000);

  test("direct family: hit@1 — a plainly correct answer stays at rank 1", async () => {
    if (!reachable) {
      process.stdout.write("\nsearch-quality.e2e: :8001 unreachable — skipping (local dev box).\n");
      return;
    }
    const h = harness!;
    const n = DIRECT_QUERIES.length;

    let hitAt1 = 0;
    const rows: string[] = [];

    for (const q of DIRECT_QUERIES) {
      const res = await search(h, q.query);
      const rank = rankOf(res.results, q.goldTitle);
      if (rank === 1) hitAt1++;
      rows.push(`  ${q.goldTitle.padEnd(26)} #${rank || "-"}   "${q.query}"`);
    }

    process.stdout.write(
      `\nsearch-quality DIRECT (${n} queries, ${CORPUS.length} docs):\n${rows.join("\n")}\n` +
        `  hit@1=${hitAt1}/${n} (floor ${Math.ceil(FLOOR_DIRECT_HIT_AT_1 * n)}/${n})\n`,
    );

    expect(
      hitAt1 / n,
      `hit@1 = ${hitAt1}/${n} — plainly correct answers are no longer ranking first. Something in ` +
        `fusion, MMR, dedup or the boost passes is shuffling a correct result off the top spot`,
    ).toBeGreaterThanOrEqual(FLOOR_DIRECT_HIT_AT_1);
  }, 180_000);
});
