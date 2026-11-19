// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fakeEmbed } from "./fake-embedder.js";
import type { AddressInfo } from "node:net";

/** The probe input `probeHttpEmbedder` POSTs to discover a backend's dimension. */
const PROBE_INPUT = "dimension probe";

export interface GatedEmbedderServer {
  url: string;
  modelId: string;
  dim: number;
  /** How many non-probe (corpus/query) embedding inputs have been served. */
  servedInputs: () => number;
  /** Open the gate so all held + future corpus-embed requests proceed. */
  release: () => void;
  close: () => Promise<void>;
}

/**
 * A controllable OpenAI-compatible fake embedder used as the SWAP TARGET. It
 * speaks the same `/v1/models` + `/v1/embeddings` subset as `fake-embedder.ts`
 * (reusing its deterministic `fakeEmbed`), with one addition: a GATE. The
 * dimension-probe request (`input: ["dimension probe"]`) always passes so the
 * swap can discover the target dim; every other (corpus re-embed) request
 * BLOCKS until `release()` is called. That lets the test hold the graceful
 * rebuild open, assert search is still live on the old index, then release and
 * watch the flip — with no timing races.
 */
export function startGatedEmbedderServer(
  dim: number,
  modelId: string,
): Promise<GatedEmbedderServer> {
  let released = false;
  const waiters: Array<() => void> = [];
  const counter = { n: 0 };

  const gate = (): Promise<void> => {
    if (released) return Promise.resolve();
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    released = true;
    while (waiters.length) waiters.shift()!();
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (req.method === "GET" && path === "/v1/models") {
        sendJson(res, 200, {
          object: "list",
          data: [{ id: modelId, object: "model", owned_by: "omnesis-test" }],
        });
        return;
      }
      if (req.method === "POST" && path === "/v1/embeddings") {
        let parsed: { input?: string | string[]; model?: string };
        try {
          parsed = JSON.parse(await readBody(req)) as typeof parsed;
        } catch {
          sendJson(res, 400, { error: { message: "invalid JSON body" } });
          return;
        }
        const raw = parsed.input;
        const inputs: string[] = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
        if (inputs.length === 0) {
          sendJson(res, 400, { error: { message: "input is required" } });
          return;
        }
        const isProbe = inputs.length === 1 && inputs[0] === PROBE_INPUT;
        // Everything except the dimension probe is held until the test releases
        // the gate — that is the mid-rebuild window the headline assertion runs in.
        if (!isProbe) {
          counter.n += inputs.length;
          await gate();
        }
        sendJson(res, 200, {
          object: "list",
          data: inputs.map((text, index) => ({
            object: "embedding",
            index,
            embedding: fakeEmbed(text, dim),
          })),
          model: parsed.model ?? modelId,
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
        return;
      }
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
    })();
  });

  return new Promise<GatedEmbedderServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        modelId,
        dim,
        servedInputs: () => counter.n,
        release,
        close: () =>
          new Promise<void>((res, rej) => {
            release(); // never leave a request hanging on close
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

// Invented fictional corpus — no operator data. A handful of docs so the
// rebuild has real work to re-embed and BM25/fusion have a pool to rank over.
export const CORPUS: ReadonlyArray<{ externalId: string; title: string; content: string }> = [
  {
    externalId: "swap-feline",
    title: "Whiskers Nutrition Guide",
    content:
      "A grown house cat thrives on a protein-rich diet. Offer small portions of cooked poultry " +
      "or quality wet kibble twice daily and always leave fresh water within reach.",
  },
  {
    externalId: "swap-umbrella",
    title: "Forecast Companion Note",
    content:
      "Grey clouds gathering over the bay usually mean a downpour by afternoon. Pack a folding " +
      "parasol and waterproof boots before you head out.",
  },
  {
    externalId: "swap-tuning",
    title: "Six String Setup",
    content:
      "When a fretted instrument sounds sour, turn each peg slowly while plucking the open course " +
      "until the pitch matches a reference tone.",
  },
  {
    externalId: "swap-pasta",
    title: "Weeknight Pasta Idea",
    content:
      "Toss cooked spaghetti with garlic, chilli flakes, and a handful of grated cheese for a fast " +
      "midweek dinner.",
  },
  {
    externalId: "swap-coast",
    title: "Coastal Trip Plan",
    content:
      "We rented a small cottage near the harbour for the long weekend and walked the cliff path " +
      "each morning.",
  },
  {
    externalId: "swap-standup",
    title: "Standup Recap",
    content:
      "Quick sync this morning: the design review slipped to Thursday and the analytics dashboard " +
      "is in QA.",
  },
];

// One query whose answer is a corpus doc. We assert the vector LANE answers it
// (candidates > 0), not exact ranking — this is a liveness net, not a quality net.
export const PROBE_QUERY = "feeding a house cat";
