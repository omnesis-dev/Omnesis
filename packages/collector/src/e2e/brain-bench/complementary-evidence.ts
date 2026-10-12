// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { waitFor } from "../briefs-scorecard.js";
import { call, structuredData, type PuppetPlan, type ToolStep } from "./puppet-plan.js";
import type { BrainBench } from "./bench.js";

/** Scripted topic decisions still discover and read their supporting documents through real tools. */
export function complementaryEvidence(title: string, steps: readonly ToolStep[]) {
  const calls: PuppetPlan["calls"] = [
    call("search_many", { queries: [{ query: title, limit: 10 }] }),
  ];
  const search = [...steps]
    .reverse()
    .find(
      (step) =>
        step.name === "search_many" && JSON.stringify(step.args) === JSON.stringify(calls[0]!.args),
    );
  const parsed = z
    .object({
      items: z.array(
        z.object({
          results: z.array(z.object({ documentId: z.string(), title: z.string() })),
        }),
      ),
    })
    .safeParse(search?.result);
  const hit = parsed.success
    ? parsed.data.items.flatMap((item) => item.results).find((item) => item.title === title)
    : undefined;
  if (!hit) return { calls, evidence: undefined };
  const ref = `source:${hit.documentId}`;
  calls.push(call("knowledge_reference", { ref }));
  const read = [...steps]
    .reverse()
    .find((step) => step.name === "knowledge_reference" && step.args?.ref === ref);
  const evidence = z
    .object({ ref: z.string(), revision: z.string(), text: z.string() })
    .safeParse(read && structuredData(read.result));
  return {
    calls,
    evidence: evidence.success ? { ...evidence.data, id: hit.documentId } : undefined,
  };
}

/** Wait for the real search seam; ingestion/maintenance completion is not index readiness. */
export async function waitForComplementaryEvidence(
  bench: BrainBench,
  title: string,
): Promise<void> {
  await waitFor(
    `indexed complementary evidence: ${title}`,
    async () => {
      const response = await bench.harness.gatewayJson<{ results: Array<{ title: string }> }>(
        "/search",
        { method: "POST", body: JSON.stringify({ text: title, limit: 10 }) },
      );
      return response.results.some((result) => result.title === title) ? true : null;
    },
    60_000,
  );
}
