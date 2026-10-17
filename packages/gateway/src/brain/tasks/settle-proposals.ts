// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settle the proposals waiting on the user's own tasks under the current
 * auto-apply policy. A proposal is judged once, when it is made; the task and
 * the policy can move on while it waits. So, when the Brain starts:
 *
 * - a proposal that no longer changes anything (the task already reads that
 *   way, or is already done) is withdrawn;
 * - an edit the policy now applies on its own (context that needs no proof,
 *   and a title that still names the same task) is applied, as an undoable
 *   change in the task's history;
 * - everything else keeps waiting for the user.
 *
 * Proposals that rest on a fact (a completion, a new deadline) stay
 * proposals: the evidence quotes they were judged on are not kept.
 */

import { getOpenLoop } from "../storage/open-loops.js";
import { readTaskAuthorship } from "../storage/tasks.js";
import { isOwnedTask, type OpenLoopState, type ProposedTaskChange } from "../storage/types.js";
import { decideTaskAutoApply, planTaskAutoApply, taskProposalFor } from "./auto-apply.js";
import type { WriteGate } from "../../write-gate.js";
import type { Logger } from "@omnesis/core";
import type { TaskChecks } from "./task-checks.js";
import type Database from "better-sqlite3";

export interface SettleTaskProposalsDeps {
  db: Database.Database;
  writeGate: Pick<WriteGate, "autoApplyTaskChange" | "withdrawTaskProposal">;
  /** Config `brain.tasks.autoApply`. */
  autoApply: boolean;
  taskChecks?: TaskChecks;
  clock: () => number;
  log: Logger;
}

export async function settleTaskProposals(
  deps: SettleTaskProposalsDeps,
): Promise<{ applied: number; withdrawn: number }> {
  const ids = deps.db
    .prepare<[], { id: string }>(
      "SELECT id FROM open_loops WHERE proposed_change_json IS NOT NULL ORDER BY id",
    )
    .all()
    .map((row) => row.id);
  let applied = 0;
  let withdrawn = 0;
  for (const id of ids) {
    const loop = getOpenLoop(deps.db, id);
    const proposal = loop?.proposedChange;
    if (!loop || !proposal || !isOwnedTask(loop)) continue;
    // When to do a task is the user's call; such a proposal always waits.
    if (proposal.fields?.scheduledFor !== undefined) continue;
    const effective = taskProposalFor(loop, asChange(proposal));
    if (!effective) {
      if (await deps.writeGate.withdrawTaskProposal(id, proposal.proposedAt)) withdrawn += 1;
      continue;
    }
    const { authored, latestEventSeq } = readTaskAuthorship(deps.db, id);
    let decision = decideTaskAutoApply(
      planTaskAutoApply({
        enabled: deps.autoApply,
        loop,
        proposal: effective,
        authored,
        evidence: undefined,
      }),
      null,
    );
    const title = decision.apply ? decision.change.fields?.title : undefined;
    if (decision.apply && title !== undefined && deps.taskChecks) {
      const same = await deps.taskChecks.sameTask({
        runId: proposal.runId,
        loopId: id,
        documentId: loop.docs[0] ?? proposal.evidence[0] ?? null,
        before: { title: loop.title, description: loop.description },
        after: {
          title,
          description: decision.change.fields?.description ?? loop.description,
        },
      });
      if (same === "different" || same === "unavailable") {
        decision = { apply: false, why: "the new title was not confirmed as the same task" };
        deps.log.info(`Task ${id} keeps its proposed new title waiting: task check ${same}`);
      }
    }
    if (!decision.apply) continue;
    const result = await deps.writeGate.autoApplyTaskChange(
      id,
      {
        ...decision.change,
        reason: proposal.reason,
        evidence: proposal.evidence,
        runId: proposal.runId,
        basedOnSeq: latestEventSeq,
      },
      deps.clock(),
    );
    if (result.applied) applied += 1;
  }
  if (applied + withdrawn > 0)
    deps.log.info(
      `Settled waiting task proposals: ${applied} applied, ${withdrawn} withdrawn as no-ops`,
    );
  return { applied, withdrawn };
}

/** A stored proposal, read back as the change a run would have made. */
function asChange(proposal: ProposedTaskChange): {
  state?: OpenLoopState;
  title?: string;
  description?: string;
  deadline?: unknown;
} {
  if (proposal.kind === "complete") return { state: "done" };
  if (proposal.kind === "strike") return { state: "dismissed" };
  const fields = proposal.fields ?? {};
  return {
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.deadline !== undefined ? { deadline: fields.deadline } : {}),
  };
}
