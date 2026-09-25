// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { ImapEmailSource } from "./source.js";
import { imapStateSpec } from "./state.js";
import type {
  ImapClient,
  ImapEmailCursor,
  ImapMailbox,
  ImapMailboxState,
  ImapMessage,
} from "./source.js";

class FakeImapClient implements ImapClient {
  connect(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<ImapMailbox[]> {
    return Promise.resolve([]);
  }
  open(): Promise<ImapMailboxState> {
    return Promise.reject(new Error("no mailboxes configured"));
  }
  search(): Promise<number[]> {
    return Promise.resolve([]);
  }
  fetch(): Promise<ImapMessage[]> {
    return Promise.resolve([]);
  }
  fetchMetadata(): Promise<Array<{ uid: number; date?: Date }>> {
    return Promise.resolve([]);
  }
  fetchAttachment(): Promise<Uint8Array> {
    return Promise.reject(new Error("no attachments"));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("imapStateSpec via the host decorator", () => {
  function makeInstance(): SourceInstance {
    const client = new FakeImapClient();
    const source = new ImapEmailSource(
      "imap:account@example.com",
      "imap:account@example.com",
      () => client,
    );
    // Driven through `withVersionedState` rather than `source.sync` directly,
    // because resolving the stored value is the host's job — calling `sync`
    // with a raw cursor would test a path production never takes.
    return { sync: (cursor, opts) => source.sync(cursor as ImapEmailCursor | null, opts) };
  }

  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(makeInstance(), imapStateSpec, {
      sourceId: "imap:account@example.com",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);

    const second = await versioned.sync(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a stored value this build cannot make sense of rebootstraps rather than throwing", async () => {
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(makeInstance(), imapStateSpec, {
      sourceId: "imap:account@example.com",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync({ phase: "sometime-else" } as unknown as Parameters<
      SourceInstance["sync"]
    >[0]);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
