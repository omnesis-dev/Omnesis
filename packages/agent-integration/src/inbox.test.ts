// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import { AmbiguousDeliveryError, DeliveryConflictError, DurableIntegrationInbox } from "./inbox.js";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
  type AnswerCompletionDelivery,
  deliveryPayloadHash,
  type SubscriptionDelivery,
  type SubscriptionDeliveryV3,
  type SubscriptionDeliveryV4,
} from "./protocol.js";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-integration-inbox-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}

function answerCompletion(id = "acdl_fictional_1"): AnswerCompletionDelivery {
  return {
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
    deliveryId: id,
    taskId: "task_fictional_1",
    nativeConversationId: "native_fictional_1",
  };
}

function delivery(id = "adl_fictional_1"): SubscriptionDeliveryV4 {
  return {
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
    deliveryId: id,
    firingId: `trf_${id}`,
    subscriptionId: "sub_fictional_1",
    workflowHandle: "wf_fictional_1",
    reaction: { instruction: "Review the fictional Riverside Estate update." },
    answer: {
      token: "omn_firing_example",
      expiresAt: 1_900_000_000_000,
      endpoint: `/subscriptions/firings/trf_${id}/answer`,
    },
    // Outlives the answer authority: a report stays postable long after the
    // credential the run asked its questions with has expired.
    outcome: {
      token: "omn_outcome_example",
      expiresAt: 1_950_000_000_000,
      endpoint: `/subscriptions/firings/trf_${id}/outcome`,
    },
  };
}

/** A wake from a gateway that predates bindings and outcome reporting. */
function legacyDelivery(id = "adl_legacy_1"): SubscriptionDeliveryV3 {
  const { outcome: _outcome, reaction, ...rest } = delivery(id);
  return {
    ...rest,
    reaction: { instruction: reaction.instruction },
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DurableIntegrationInbox", () => {
  test("simultaneous processes can initialize the same inbox", async () => {
    const path = tempDb();
    const moduleUrl = new URL("./inbox.ts", import.meta.url).href;
    const script = `
      import { DurableIntegrationInbox } from ${JSON.stringify(moduleUrl)};
      process.stdout.write("ready\\n");
      process.stdin.once("data", () => {
        try {
          for (let wave = 0; wave < 3; wave += 1) {
            const inbox = new DurableIntegrationInbox(${JSON.stringify(path)});
            inbox.close();
          }
          process.exit(0);
        } catch (error) {
          process.stderr.write(String(error?.stack ?? error));
          process.exit(1);
        }
      });
    `;
    const children = Array.from({ length: 24 }, () =>
      spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", script], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    try {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              let stdout = "";
              child.stdout.setEncoding("utf8");
              child.stdout.on("data", (chunk: string) => {
                stdout += chunk;
                if (stdout.includes("ready\n")) resolve();
              });
              child.once("error", reject);
              child.once("exit", (code) => {
                if (!stdout.includes("ready\n"))
                  reject(new Error(`child exited before ready: ${code}`));
              });
            }),
        ),
      );
      for (const child of children) child.stdin.end("open\n");
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise<{ code: number | null; stderr: string }>((resolve) => {
              let stderr = "";
              child.stderr.setEncoding("utf8");
              child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
              });
              child.once("close", (code) => resolve({ code, stderr }));
            }),
        ),
      );
      // Node may emit startup warnings inherited from the runner environment;
      // initialization succeeds when every child exits cleanly.
      for (const result of results) expect(result.code, result.stderr).toBe(0);

      const verified = new DatabaseSync(path);
      expect(verified.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(
        verified
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'integration_inbox'",
          )
          .get(),
      ).toEqual({ count: 1 });
      verified.close();
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
              }
              child.once("close", () => resolve());
              if (!child.kill()) resolve();
            }),
        ),
      );
    }
  }, 45_000);

  test("migrates a legacy received wake to prepared without executing it", async () => {
    const path = tempDb();
    const legacy = new DatabaseSync(path);
    const wake = delivery("adl_legacy");
    legacy.exec(`
      CREATE TABLE integration_inbox (
        delivery_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK(state IN ('received','starting','accepted','retryable_failure')),
        accepted_at INTEGER,
        local_run_id TEXT,
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(
        `INSERT INTO integration_inbox
           (delivery_id, payload_hash, payload_json, state, updated_at)
         VALUES (?, ?, ?, 'received', 10)`,
      )
      .run(wake.deliveryId, deliveryPayloadHash(wake), JSON.stringify(wake));
    legacy.close();

    const inbox = new DurableIntegrationInbox(path);
    expect(inbox.getState(wake.deliveryId)).toBe("prepared");
    let starts = 0;
    await inbox.commit(wake.deliveryId, () => {
      starts += 1;
      return { localRunId: "run-legacy", nativeSessionId: "session-legacy" };
    });
    expect(starts).toBe(1);
    inbox.close();
  });

  test("preparing is durable but never starts the native harness", () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    expect(inbox.prepare(delivery(), 100)).toEqual({
      status: "prepared",
      preparedAt: 100,
      duplicate: false,
    });
    expect(inbox.getState(delivery().deliveryId)).toBe("prepared");
    inbox.close();
  });

  test("persists the stable native identity before returning acceptance", async () => {
    const path = tempDb();
    const inbox = new DurableIntegrationInbox(path);
    inbox.prepare(delivery());
    const accepted = await inbox.commit(delivery().deliveryId, async ({ binding }) => {
      expect(binding).toBeNull();
      return {
        localRunId: "openclaw-run-fictional-1",
        nativeSessionId: "openclaw-session-fictional-1",
        nativeFlowId: "openclaw-flow-fictional-1",
      };
    });
    expect(accepted).toMatchObject({ status: "accepted", duplicate: false });
    expect(inbox.getState(delivery().deliveryId)).toBe("accepted");
    inbox.close();

    const reopened = new DurableIntegrationInbox(path);
    expect(reopened.getWorkflowBinding(delivery().workflowHandle)).toMatchObject({
      nativeSessionId: "openclaw-session-fictional-1",
      nativeFlowId: "openclaw-flow-fictional-1",
    });
    reopened.close();
  });

  test("a replay returns the original acknowledgement without a second run", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    let starts = 0;
    const starter = async () => {
      starts += 1;
      return { localRunId: "run-1", nativeSessionId: "session-1" };
    };
    inbox.prepare(delivery());
    const first = await inbox.commit(delivery().deliveryId, starter);
    inbox.prepare(delivery());
    const replay = await inbox.commit(delivery().deliveryId, starter);
    expect(starts).toBe(1);
    expect(replay).toEqual({ ...first, duplicate: true });
    inbox.close();
  });

  test("lost-ACK replay rotates authority without starting a second run", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    const first = delivery();
    let starts = 0;
    const starter = async ({ delivery: wake }: { delivery: SubscriptionDelivery }) => {
      starts += 1;
      inbox.putFiringAuthority(wake, "session-1", 1);
      return { localRunId: "run-1", nativeSessionId: "session-1" };
    };
    inbox.prepare(first);
    const accepted = await inbox.commit(first.deliveryId, starter);
    const rotated = {
      ...first,
      answer: {
        ...first.answer,
        token: "omn_rotated_firing_example",
        expiresAt: first.answer.expiresAt + 60_000,
      },
    };
    inbox.prepare(rotated);
    const replay = await inbox.commit(rotated.deliveryId, starter);
    expect(starts).toBe(1);
    expect(replay).toEqual({ ...accepted, duplicate: true });
    expect(inbox.getFiringAuthority("session-1", first.firingId, 2)).toMatchObject({
      token: "omn_rotated_firing_example",
      expiresAt: first.answer.expiresAt + 60_000,
    });
    inbox.close();
  });

  test("concurrent duplicates wait for one native start", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starter = async () => {
      starts += 1;
      await gate;
      return { localRunId: "run-concurrent", nativeSessionId: "session-concurrent" };
    };
    inbox.prepare(delivery());
    const first = inbox.commit(delivery().deliveryId, starter);
    const duplicate = inbox.commit(delivery().deliveryId, starter);
    release();
    const [a, b] = await Promise.all([first, duplicate]);
    expect(starts).toBe(1);
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ ...a, duplicate: true });
    inbox.close();
  });

  test("an overlapping inbox process cannot claim the same prepared wake twice", async () => {
    const path = tempDb();
    const competing = new DurableIntegrationInbox(path);
    let competingCommit!: Promise<unknown>;
    let starts = 0;
    const starter = () => {
      starts += 1;
      return { localRunId: "run-cross-process", nativeSessionId: "session-cross-process" };
    };
    const first = new DurableIntegrationInbox(path, {
      beforeStartClaim: () => {
        competingCommit = competing.commit(delivery().deliveryId, starter);
      },
    });
    first.prepare(delivery());

    await expect(first.commit(delivery().deliveryId, starter)).rejects.toBeInstanceOf(
      AmbiguousDeliveryError,
    );
    await expect(competingCommit).resolves.toMatchObject({
      status: "accepted",
      duplicate: false,
    });
    expect(starts).toBe(1);
    first.close();
    competing.close();
  });

  test("a cancellation tombstone wins stale-read contention before the start claim", async () => {
    const path = tempDb();
    const cancelling = new DurableIntegrationInbox(path);
    const first = new DurableIntegrationInbox(path, {
      beforeStartClaim: () => {
        cancelling.cancel(delivery().deliveryId);
      },
    });
    first.prepare(delivery());
    let starts = 0;
    await expect(
      first.commit(delivery().deliveryId, () => {
        starts += 1;
        return { localRunId: "run-impossible", nativeSessionId: "session-impossible" };
      }),
    ).rejects.toThrow(/cancelled before commit/);
    expect(starts).toBe(0);
    expect(first.getState(delivery().deliveryId)).toBe("cancelled");
    first.close();
    cancelling.close();
  });

  test("rejects a replay whose identifier was rebound to different bytes", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    inbox.prepare(delivery());
    await inbox.commit(delivery().deliveryId, () => ({
      localRunId: "run-1",
      nativeSessionId: "session-1",
    }));
    expect(() =>
      inbox.prepare({
        ...delivery(),
        reaction: { instruction: "A changed instruction." },
      }),
    ).toThrow(DeliveryConflictError);
    inbox.close();
  });

  test("an ambiguous native start is parked across restart instead of replayed", async () => {
    const path = tempDb();
    const first = new DurableIntegrationInbox(path);
    first.prepare(delivery());
    await expect(
      first.commit(delivery().deliveryId, () => {
        throw new Error("fictional harness unavailable");
      }),
    ).rejects.toThrow(/unavailable/);
    expect(first.getState(delivery().deliveryId)).toBe("starting");
    first.close();

    const recovered = new DurableIntegrationInbox(path);
    let starts = 0;
    const starter = () => {
      starts += 1;
      return { localRunId: "run-after-restart", nativeSessionId: "session-after-restart" };
    };
    await expect(recovered.commit(delivery().deliveryId, starter)).rejects.toBeInstanceOf(
      AmbiguousDeliveryError,
    );
    expect(starts).toBe(0);
    recovered.close();
  });

  test("a crash after native acceptance but before inbox commit remains parked", async () => {
    const path = tempDb();
    let starts = 0;
    const first = new DurableIntegrationInbox(path, {
      beforeAcceptanceCommit: () => {
        throw new Error("fictional crash before durable acceptance");
      },
    });
    first.prepare(delivery());
    await expect(
      first.commit(delivery().deliveryId, () => {
        starts += 1;
        return { localRunId: "run-started", nativeSessionId: "session-started" };
      }),
    ).rejects.toThrow(/fictional crash/);
    expect(starts).toBe(1);
    expect(first.getState(delivery().deliveryId)).toBe("starting");
    first.close();

    const reopened = new DurableIntegrationInbox(path);
    await expect(
      reopened.commit(delivery().deliveryId, () => {
        starts += 1;
        return { localRunId: "run-duplicate", nativeSessionId: "session-started" };
      }),
    ).rejects.toBeInstanceOf(AmbiguousDeliveryError);
    expect(starts).toBe(1);
    reopened.close();
  });

  test("keeps one stable session binding across distinct firings", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    inbox.prepare(delivery("adl_first"));
    await inbox.commit("adl_first", () => ({
      localRunId: "run-first",
      nativeSessionId: "session-workflow",
      nativeFlowId: "flow-workflow",
    }));
    inbox.prepare(delivery("adl_second"));
    await inbox.commit("adl_second", ({ binding }) => {
      expect(binding).toMatchObject({
        nativeSessionId: "session-workflow",
        nativeFlowId: "flow-workflow",
      });
      return {
        localRunId: "run-second",
        nativeSessionId: binding!.nativeSessionId,
        nativeFlowId: binding!.nativeFlowId,
      };
    });
    inbox.close();
  });

  test("a cancel tombstone wins before or after preparation", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    expect(inbox.cancel("adl_cancelled", 100)).toEqual({
      status: "cancelled",
      cancelledAt: 100,
      duplicate: false,
    });
    expect(() => inbox.prepare(delivery("adl_cancelled"), 101)).toThrow(/cancelled before commit/);

    const prepared = delivery("adl_prepared_cancelled");
    inbox.prepare(prepared, 102);
    expect(inbox.cancel(prepared.deliveryId, 103).status).toBe("cancelled");
    let starts = 0;
    await expect(
      inbox.commit(prepared.deliveryId, () => {
        starts += 1;
        return { localRunId: "run-impossible", nativeSessionId: "session-impossible" };
      }),
    ).rejects.toThrow(/cancelled before commit/);
    expect(starts).toBe(0);
    inbox.close();
  });

  test("durably prepares terminal answer delivery before invoking its starter", async () => {
    const path = tempDb();
    const first = new DurableIntegrationInbox(path);
    const wake = answerCompletion();
    expect(first.prepareAnswerCompletion(wake, 100)).toEqual({
      status: "prepared",
      preparedAt: 100,
      duplicate: false,
    });
    first.close();

    const reopened = new DurableIntegrationInbox(path);
    let starts = 0;
    await expect(
      reopened.commitAnswerCompletion(
        wake.deliveryId,
        async (received) => {
          starts += 1;
          expect(received).toEqual(wake);
        },
        101,
      ),
    ).resolves.toMatchObject({ status: "accepted", localRunId: wake.deliveryId });
    expect(starts).toBe(1);
    await expect(
      reopened.commitAnswerCompletion(
        wake.deliveryId,
        async () => {
          starts += 1;
        },
        102,
      ),
    ).resolves.toMatchObject({ status: "accepted", duplicate: true });
    expect(starts).toBe(1);
    reopened.close();
  });

  test("posts an answer again at a harness that never said whether it landed", async () => {
    // A run start parks on the first ambiguity and stays parked, because
    // starting an agent twice runs its side effects twice. An answer is the
    // other trade: the worst case of retrying is the operator reading it
    // twice, and the worst case of parking is that they asked a question and
    // nothing ever tells them the reply was swallowed.
    const path = tempDb();
    const wake = answerCompletion("acdl_ambiguous");
    let attempts = 0;
    const crashing = async (): Promise<void> => {
      attempts += 1;
      throw new Error("fictional crash after posting, before acceptance");
    };

    const inbox = new DurableIntegrationInbox(path);
    inbox.prepareAnswerCompletion(wake, 100);
    for (const at of [101, 102, 103]) {
      await expect(inbox.commitAnswerCompletion(wake.deliveryId, crashing, at)).rejects.toThrow(
        /fictional crash/,
      );
    }
    expect(attempts, "an ambiguous answer was never retried").toBe(3);
    expect(inbox.getAnswerCompletionState(wake.deliveryId)).toBe("starting");

    // Bounded, and the bound survives a restart — it is a column, not a
    // counter in memory. Otherwise every reconnect would buy three more.
    inbox.close();
    const reopened = new DurableIntegrationInbox(path);
    await expect(
      reopened.commitAnswerCompletion(wake.deliveryId, crashing, 104),
    ).rejects.toBeInstanceOf(AmbiguousDeliveryError);
    expect(attempts, "the retry budget was not durable").toBe(3);
    reopened.close();
  });

  test("stops retrying an answer as soon as one lands", async () => {
    // The budget is a ceiling on ambiguity, not a quota to spend: a post that
    // reached the harness leaves the row accepted, and the next frame is a
    // duplicate rather than a fourth attempt.
    const inbox = new DurableIntegrationInbox(tempDb());
    const wake = answerCompletion("acdl_lands_second");
    let attempts = 0;
    const flaky = async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new Error("fictional crash after posting");
    };

    inbox.prepareAnswerCompletion(wake, 100);
    await expect(inbox.commitAnswerCompletion(wake.deliveryId, flaky, 101)).rejects.toThrow(
      /fictional crash/,
    );
    await expect(inbox.commitAnswerCompletion(wake.deliveryId, flaky, 102)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(inbox.commitAnswerCompletion(wake.deliveryId, flaky, 103)).resolves.toMatchObject({
      status: "accepted",
      duplicate: true,
    });

    expect(attempts, "an accepted answer was posted again").toBe(2);
    inbox.close();
  });

  test("an answer-completion cancellation tombstone survives prepare reordering", async () => {
    const path = tempDb();
    const inbox = new DurableIntegrationInbox(path);
    const wake = answerCompletion("acdl_cancelled");
    expect(inbox.cancelAnswerCompletion(wake.deliveryId, 100)).toEqual({
      status: "cancelled",
      cancelledAt: 100,
      duplicate: false,
    });
    inbox.close();
    const reopened = new DurableIntegrationInbox(path);
    expect(() => reopened.prepareAnswerCompletion(wake, 101)).toThrow(/cancelled before commit/);
    reopened.close();
  });

  test("cancellation reports too late after an accepted commit", async () => {
    const inbox = new DurableIntegrationInbox(tempDb());
    const wake = delivery("adl_committed");
    inbox.prepare(wake);
    await inbox.commit(wake.deliveryId, () => ({
      localRunId: "run-committed",
      nativeSessionId: "session-committed",
    }));
    expect(inbox.cancel(wake.deliveryId, 200)).toEqual({
      status: "too_late",
      cancelledAt: 200,
      duplicate: false,
    });
    inbox.close();
  });

  test("keeps firing authority private and bound to one native session", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const wake = delivery();
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putFiringAuthority(wake, nativeSessionId, 1);
    expect(inbox.getFiringAuthority(nativeSessionId, wake.firingId, 2)).toEqual({
      deliveryId: wake.deliveryId,
      firingId: wake.firingId,
      nativeSessionId,
      endpoint: wake.answer.endpoint,
      token: wake.answer.token,
      expiresAt: wake.answer.expiresAt,
    });
    expect(
      inbox.getFiringAuthority("agent:main:telegram:dm:fictional", wake.firingId, 2),
    ).toBeNull();
    expect(
      inbox.getFiringAuthority(nativeSessionId, wake.firingId, wake.answer.expiresAt),
    ).toBeNull();
    inbox.close();
  });

  test("keeps the outcome authority reportable after the answer authority is gone", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const wake = delivery();
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putFiringAuthority(wake, nativeSessionId, 1);
    inbox.putOutcomeAuthority(wake, nativeSessionId, 1);
    // The answer authority expires on its own clock. A report has to outlive
    // it, or a run that waited for approval could never say what it did.
    const afterAnswerExpiry = wake.answer.expiresAt + 1;
    expect(inbox.getFiringAuthority(nativeSessionId, wake.firingId, afterAnswerExpiry)).toBeNull();
    expect(inbox.getOutcomeAuthority(wake.deliveryId, afterAnswerExpiry)).toEqual({
      deliveryId: wake.deliveryId,
      firingId: wake.firingId,
      nativeSessionId,
      endpoint: `/subscriptions/firings/${wake.firingId}/outcome`,
      token: "omn_outcome_example",
      expiresAt: wake.outcome!.expiresAt,
      deferred: false,
    });
    inbox.close();
  });

  test("a wake without an outcome authority leaves the run nothing to report", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const legacy = legacyDelivery();
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putOutcomeAuthority(legacy, nativeSessionId, 1);
    expect(inbox.getOutcomeAuthority(legacy.deliveryId, 2)).toBeNull();
    inbox.close();
  });

  test("a deferred run stays reportable and a settled one is retired", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const wake = delivery();
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putOutcomeAuthority(wake, nativeSessionId, 1);
    inbox.deferOutcome(wake.deliveryId, "native_held_answer", 2);
    expect(inbox.getOutcomeAuthority(wake.deliveryId, 3)?.deferred).toBe(true);
    expect(inbox.resumeDeferredOutcome("native_held_answer", 4)).toMatchObject({
      deliveryId: wake.deliveryId,
      deferred: false,
    });
    expect(inbox.getOutcomeAuthority(wake.deliveryId, 5)?.deferred).toBe(false);
    // The wait is over, so the same answer cannot resume the run a second time.
    expect(inbox.resumeDeferredOutcome("native_held_answer", 5)).toBeNull();
    inbox.clearOutcomeAuthority(wake.deliveryId);
    expect(inbox.getOutcomeAuthority(wake.deliveryId, 6)).toBeNull();
    inbox.close();
  });

  test("a redelivered wake rebinds its outcome authority without stale deferral", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const wake = delivery();
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putOutcomeAuthority(wake, nativeSessionId, 1);
    inbox.deferOutcome(wake.deliveryId, "native_held_answer", 2);
    inbox.putOutcomeAuthority(
      { ...wake, outcome: { ...wake.outcome!, token: "omn_outcome_rotated" } },
      nativeSessionId,
      3,
    );
    expect(inbox.getOutcomeAuthority(wake.deliveryId, 4)).toMatchObject({
      token: "omn_outcome_rotated",
      deferred: false,
    });
    // The rebound authority waits on nothing, so the answer the retired run
    // was holding out for cannot resume it.
    expect(inbox.resumeDeferredOutcome("native_held_answer", 4)).toBeNull();
    inbox.close();
  });

  test("each firing of one workflow keeps its own outcome authority", () => {
    // Every firing of a workflow is woken in the same native session, so the
    // session names the workflow and not the firing that ran.
    const inbox = new DurableIntegrationInbox(":memory:");
    const first = delivery("adl_fictional_first");
    const second = delivery("adl_fictional_second");
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putOutcomeAuthority(first, nativeSessionId, 1);
    inbox.putOutcomeAuthority(second, nativeSessionId, 2);

    expect(inbox.getOutcomeAuthority(first.deliveryId, 3)).toMatchObject({
      firingId: first.firingId,
      endpoint: `/subscriptions/firings/${first.firingId}/outcome`,
    });
    expect(inbox.getOutcomeAuthority(second.deliveryId, 3)).toMatchObject({
      firingId: second.firingId,
      endpoint: `/subscriptions/firings/${second.firingId}/outcome`,
    });
    // Retiring the firing that reported leaves its sibling reportable.
    inbox.clearOutcomeAuthority(second.deliveryId);
    expect(inbox.getOutcomeAuthority(first.deliveryId, 4)).not.toBeNull();
    inbox.close();
  });

  test("one firing's wait leaves its sibling firing undeferred", () => {
    const inbox = new DurableIntegrationInbox(":memory:");
    const waiting = delivery("adl_fictional_waiting");
    const working = delivery("adl_fictional_working");
    const nativeSessionId = "agent:main:subagent:omnesis-wf_fictional_1";
    inbox.putOutcomeAuthority(waiting, nativeSessionId, 1);
    inbox.putOutcomeAuthority(working, nativeSessionId, 2);
    inbox.deferOutcome(waiting.deliveryId, "native_held_answer", 3);

    expect(inbox.getOutcomeAuthority(waiting.deliveryId, 4)?.deferred).toBe(true);
    expect(inbox.getOutcomeAuthority(working.deliveryId, 4)?.deferred).toBe(false);
    // The release names the firing that asked, never the one still working.
    expect(inbox.resumeDeferredOutcome("native_held_answer", 5)?.deliveryId).toBe(
      waiting.deliveryId,
    );
    inbox.close();
  });

  test("an inbox written before a deferral named its answer keeps working", () => {
    const path = tempDb();
    const legacyStore = new DatabaseSync(path);
    legacyStore.exec(`
      CREATE TABLE integration_outcome_authorities (
        delivery_id TEXT PRIMARY KEY,
        firing_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        deferred INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_integration_outcome_authorities_session
        ON integration_outcome_authorities(native_session_id, updated_at);
      INSERT INTO integration_outcome_authorities VALUES (
        'adl_carried_over', 'trf_carried_over', 'agent:main:subagent:omnesis-wf_fictional_1',
        '/subscriptions/firings/trf_carried_over/outcome', 'omn_outcome_example',
        1950000000000, 1, 1
      );
    `);
    legacyStore.close();

    const inbox = new DurableIntegrationInbox(path);
    // The run carried over is still deferred, and now waits on nothing: no
    // answer can name it, which is what a run whose wait was never recorded is.
    expect(inbox.getOutcomeAuthority("adl_carried_over", 2)?.deferred).toBe(true);
    inbox.deferOutcome("adl_carried_over", "native_held_answer", 3);
    expect(inbox.resumeDeferredOutcome("native_held_answer", 4)?.deliveryId).toBe(
      "adl_carried_over",
    );
    inbox.close();
  });
});
