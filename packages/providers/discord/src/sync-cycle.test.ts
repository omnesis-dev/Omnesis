// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cycle must settle. Discord walks a ring within one tick — enumerate,
 * then one channel per call, chained with `hasMore` — and re-reads every
 * channel's newest day on each pass, so the question is whether an upstream
 * that stands still eventually produces no writes at all, or whether the
 * re-read rewrites the newest day forever. A step here is one whole tick,
 * since the contract reads `hasMore` as "not settled yet".
 */

import { describe, test } from "vitest";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { DiscordClient } from "./client.js";
import { DAVID, FakeDiscord, JAMIE, MAYA, msg } from "./fake-discord.js";
import { DiscordSource } from "./source.js";
import type { DiscordCursor } from "./types.js";

describe("DiscordSource — sync cycle", () => {
  test("an upstream that never changes settles and stops emitting documents", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar Labs");
    fake.addChannel("1", { id: "10", type: 0, name: "general" });
    fake.addThread("1", { id: "31", type: 11, name: "standup notes", parent_id: "10" });
    fake.post(msg("10", MAYA, "2026-03-08T09:00:00.000Z", "morning"));
    fake.post(msg("10", JAMIE, "2026-03-09T08:00:00.000Z", "day two"));
    fake.post(msg("31", DAVID, "2026-03-09T10:00:00.000Z", "standup: shipped it"));
    const source = new DiscordSource({
      client: new DiscordClient("valid-token", {
        fetchImpl: fake.fetch,
        sleep: () => Promise.resolve(),
      }),
      providerId: ProviderId("discord:900000000000000001"),
      sourceId: SourceId("discord:900000000000000001"),
    });

    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      async step(cursor) {
        // One tick: the engine keeps calling while the source says hasMore.
        const records = [];
        let next = cursor as DiscordCursor | null;
        let hasMore = true;
        for (let calls = 0; calls < 50 && hasMore; calls++) {
          const result = await source.sync(next);
          next = result.cursor;
          hasMore = result.hasMore;
          for (const doc of result.documents) {
            records.push({
              table: "documents",
              row: {
                externalId: doc.externalId,
                contentHash: doc.contentHash,
                sourceUpdatedAt: doc.sourceUpdatedAt,
              },
            });
          }
        }
        return { records, cursor: next, hasMore };
      },
      primaryKey: () => ["externalId"],
      settleSteps: 3,
    });
  });
});
