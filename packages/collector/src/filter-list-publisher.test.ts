// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector's side of publishing filter lists: it sends a list only when
 * the gateway's digest differs, sends nothing a gateway would not store, and
 * never lets a failed listing reach the sync. All fixture data is invented.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  collectFilterList,
  filterListDigest,
  type FilterListProducers,
  type SourceInstance,
} from "@omnesis/source-sdk";
import {
  FILTER_LIST_LIMITS,
  ProviderId,
  SourceId,
  type FilterListItem,
  type FilterListOutcome,
  type FilterListPublication,
} from "@omnesis/types";
import { FilterListPublisher, type CommittedPage } from "./filter-list-publisher.js";

const SOURCE = SourceId("filing:northstar");
const FOLDERS = "extra.folderIds";
const GROUPS = "extra.groupId";

const folders: FilterListItem[] = [
  { id: "f-work", label: "Work" },
  { id: "f-atlas", label: "Atlas API", parentId: "f-work" },
];
const groups: FilterListItem[] = [
  {
    id: "g-team",
    label: "Atlas team",
    members: [{ type: "email", value: "maya.reeves@example.com" }],
  },
];

const digestOf = async (items: FilterListItem[]): Promise<string> =>
  filterListDigest(await collectFilterList(() => items, { signal: new AbortController().signal }));

interface Sent {
  hasMore: boolean;
  cursor: unknown;
  wipeEpoch: number | undefined;
  documents: unknown;
  filterLists: FilterListPublication[];
}

/** A gateway that stores whole lists and reports their digests, as the real one does. */
class FakeGateway {
  digests: Record<string, string> | undefined = {};
  sent: Sent[] = [];
  digestReads = 0;
  /** Overrides the outcome of a page, by field and part. */
  outcome: (publication: FilterListPublication) => FilterListOutcome | undefined = () => undefined;
  respond: "normal" | "rejected" | "silent" | "throw" = "normal";

  getFilterListDigests = async () => {
    this.digestReads++;
    return this.digests ? { ...this.digests } : undefined;
  };

  upsertWithCursor = async (args: {
    hasMore: boolean;
    cursor: unknown;
    wipeEpoch?: number;
    documents?: unknown;
    filterLists?: FilterListPublication[];
  }) => {
    if (this.respond === "throw") throw new Error("gateway unreachable");
    const filterLists = args.filterLists ?? [];
    this.sent.push({
      hasMore: args.hasMore,
      cursor: args.cursor,
      wipeEpoch: args.wipeEpoch,
      documents: args.documents,
      filterLists,
    });
    const base = { ingested: 0, reconciledDeleted: 0, indexCleanedRows: 0 };
    if (this.respond === "rejected") return { ...base, rejected: true as const };
    if (this.respond === "silent") return base;
    return {
      ...base,
      filterLists: filterLists.map((publication) => {
        const outcome = this.outcome(publication) ?? (publication.final ? "published" : "staged");
        if (outcome === "published" && this.digests)
          this.digests[publication.field] = publication.digest;
        return {
          field: publication.field,
          digest: publication.digest,
          part: publication.part,
          outcome,
        };
      }),
    };
  };
}

function sourceWith(producers: FilterListProducers | undefined) {
  const instance: SourceInstance = {
    sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    ...(producers ? { filterLists: producers } : {}),
  };
  return { id: SOURCE, providerId: ProviderId("filing:northstar"), instance };
}

const page = (overrides: Partial<CommittedPage> = {}): CommittedPage => ({
  cursor: { offset: 5 },
  hasMore: true,
  wipeEpoch: 7,
  signal: new AbortController().signal,
  holder: true,
  ...overrides,
});

let gateway: FakeGateway;
let publisher: FilterListPublisher;

beforeEach(() => {
  gateway = new FakeGateway();
  publisher = new FilterListPublisher(gateway);
});

describe("FilterListPublisher", () => {
  it("sends every list the gateway does not hold, on one page that carries no documents", async () => {
    await publisher.publish(
      sourceWith({ [FOLDERS]: () => folders, [GROUPS]: () => groups }),
      page(),
    );
    expect(gateway.sent).toHaveLength(1);
    const [sent] = gateway.sent;
    expect(sent).toMatchObject({
      documents: [],
      cursor: { offset: 5 },
      hasMore: true,
      wipeEpoch: 7,
    });
    expect(sent?.filterLists.map((list) => [list.field, list.part, list.final])).toEqual([
      [FOLDERS, 0, true],
      [GROUPS, 0, true],
    ]);
    expect(sent?.filterLists[0]?.digest).toBe(await digestOf(folders));
    expect(sent?.filterLists[0]?.items.map((item) => item.id)).toEqual(["f-atlas", "f-work"]);
  });

  it("sends nothing when the gateway already holds every list", async () => {
    const source = sourceWith({ [FOLDERS]: () => folders, [GROUPS]: () => groups });
    await publisher.publish(source, page());
    await publisher.publish(source, page());
    expect(gateway.sent).toHaveLength(1);
    expect(gateway.digestReads).toBe(2);
  });

  it("sends only the list that changed", async () => {
    let current = folders;
    const source = sourceWith({ [FOLDERS]: () => current, [GROUPS]: () => groups });
    await publisher.publish(source, page());
    current = [{ id: "f-work", label: "Office" }, folders[1]!];
    await publisher.publish(source, page());
    expect(gateway.sent[1]?.filterLists.map((list) => list.field)).toEqual([FOLDERS]);
    expect(gateway.sent[1]?.filterLists[0]?.digest).toBe(await digestOf(current));
  });

  it("sends a list again to a gateway that lost it", async () => {
    const source = sourceWith({ [FOLDERS]: () => folders });
    await publisher.publish(source, page());
    gateway.digests = {};
    await publisher.publish(source, page());
    expect(gateway.sent).toHaveLength(2);
    expect(gateway.sent[1]?.filterLists[0]?.items).toHaveLength(2);
  });

  it("does not read digests or run producers for a source with no lists", async () => {
    await publisher.publish(sourceWith(undefined), page());
    expect(gateway.digestReads).toBe(0);
    expect(gateway.sent).toEqual([]);
  });

  it("does not run producers against a gateway that stores no lists", async () => {
    gateway.digests = undefined;
    let ran = 0;
    await publisher.publish(
      sourceWith({
        [FOLDERS]: () => {
          ran++;
          return folders;
        },
      }),
      page(),
    );
    expect(ran).toBe(0);
    expect(gateway.sent).toEqual([]);
  });

  it("leaves a replicated source's lists to the device holding its lease", async () => {
    await publisher.publish(sourceWith({ [FOLDERS]: () => folders }), page({ holder: false }));
    expect(gateway.digestReads).toBe(0);
    expect(gateway.sent).toEqual([]);
  });

  it("keeps a failed listing away from the sync and still sends the lists that worked", async () => {
    const source = sourceWith({
      [FOLDERS]: () => {
        throw new Error("the account could not be listed");
      },
      [GROUPS]: () => groups,
    });
    await expect(publisher.publish(source, page())).resolves.toBeUndefined();
    expect(gateway.sent[0]?.filterLists.map((list) => list.field)).toEqual([GROUPS]);
  });

  it("sends nothing for a list that breaks the contract, so the gateway keeps the one it has", async () => {
    gateway.digests = { [FOLDERS]: "previous" };
    const source = sourceWith({
      [FOLDERS]: () => [{ id: "f-orphan", label: "Orphan", parentId: "f-gone" }],
    });
    await publisher.publish(source, page());
    expect(gateway.sent).toEqual([]);
    expect(gateway.digests).toEqual({ [FOLDERS]: "previous" });
  });

  it("gives up on a producer that outlives its time limit", async () => {
    publisher = new FilterListPublisher(gateway, { producerTimeoutMs: 20 });
    const source = sourceWith({
      [FOLDERS]: async function* ({ signal }) {
        yield folders[0]!;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        yield folders[1]!;
      },
      [GROUPS]: () => groups,
    });
    await publisher.publish(source, page());
    expect(gateway.sent[0]?.filterLists.map((list) => list.field)).toEqual([GROUPS]);
  });

  it("survives a gateway that cannot be reached", async () => {
    gateway.respond = "throw";
    await expect(
      publisher.publish(sourceWith({ [FOLDERS]: () => folders }), page()),
    ).resolves.toBeUndefined();
  });

  it("stops quietly when the source is removed while it lists", async () => {
    const abort = new AbortController();
    const source = sourceWith({
      [FOLDERS]: () => {
        abort.abort(new Error("source removed"));
        return folders;
      },
      [GROUPS]: () => groups,
    });
    await publisher.publish(source, page({ signal: abort.signal }));
    expect(gateway.sent).toEqual([]);
  });

  describe("a list too long for one page", () => {
    // Long labels, so each page of the list fills a sync page of its own.
    const many = Array.from({ length: FILTER_LIST_LIMITS.itemsPerPart * 2 + 1 }, (_, i) => ({
      id: `f-${String(i).padStart(6, "0")}`,
      label: `Folder ${i} `.padEnd(400, "x"),
    }));

    it("goes out as numbered pages in order, the last one marked final", async () => {
      await publisher.publish(sourceWith({ [FOLDERS]: () => many }), page());
      const parts = gateway.sent.flatMap((sent) => sent.filterLists);
      expect(parts.map((part) => [part.part, part.final])).toEqual([
        [0, false],
        [1, false],
        [2, true],
      ]);
      expect(parts.flatMap((part) => part.items)).toHaveLength(many.length);
      expect(gateway.sent.length).toBeGreaterThan(1);
      // Every page repeats the committed position and carries no documents.
      for (const sent of gateway.sent) {
        expect(sent).toMatchObject({ documents: [], cursor: { offset: 5 }, wipeEpoch: 7 });
      }
      expect(gateway.digests?.[FOLDERS]).toBe(await digestOf(many));
    });

    it.each<FilterListOutcome>([
      "out-of-sequence",
      "superseded",
      "undeclared",
      "not-holder",
      "current",
    ])(
      "stops sending its pages once the gateway answers %s, and goes on with the other lists",
      async (refusal) => {
        gateway.outcome = (publication) =>
          publication.field === FOLDERS && publication.part === 0 ? refusal : undefined;
        await publisher.publish(
          sourceWith({ [FOLDERS]: () => many, [GROUPS]: () => groups }),
          page(),
        );
        const parts = gateway.sent.flatMap((sent) => sent.filterLists);
        expect(parts.filter((part) => part.field === FOLDERS).map((part) => part.part)).toEqual([
          0,
        ]);
        expect(parts.filter((part) => part.field === GROUPS)).toHaveLength(1);
      },
    );

    it.each(["rejected", "silent"] as const)(
      "stops after the first page when the gateway's answer is %s",
      async (respond) => {
        gateway.respond = respond;
        await publisher.publish(sourceWith({ [FOLDERS]: () => many }), page());
        expect(gateway.sent).toHaveLength(1);
      },
    );
  });
});
