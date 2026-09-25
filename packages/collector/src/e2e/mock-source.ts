// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Mock source and provider factories for E2E tests.
 * These produce RegisteredSource / RegisteredProvider objects with controllable behavior.
 */
import { SourceId, ProviderId, SourceType, ProviderType, AccountId } from "@omnesis/types";
import type { SyncResult, SyncCursor, SourceDescriptor, SourceInstance } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { RegisteredSource, RegisteredProvider } from "../sync-engine.js";

// ---------------------------------------------------------------------------
// MockDocument helper
// ---------------------------------------------------------------------------

export interface MockDocument {
  externalId: string;
  title: string;
  content: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
  sourceCreatedAt?: string;
  sourceUpdatedAt?: string;
}

let docCounter = 0;

export function mockDoc(id?: string, overrides?: Partial<MockDocument>): MockDocument {
  const eid = id ?? `doc-${++docCounter}`;
  return {
    externalId: eid,
    title: `Title ${eid}`,
    content: `Content of ${eid}`,
    contentHash: `hash-${eid}`,
    metadata: {},
    sourceCreatedAt: "2025-01-01T00:00:00Z",
    sourceUpdatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MockSource
// ---------------------------------------------------------------------------

export interface MockSourceOptions {
  sourceType: string;
  providerType: string;
  accountId?: string;
  unitName?: string;
}

/**
 * MockSource implements RegisteredSource with a controllable SourceInstance.
 * It exposes test configuration methods and records sync history.
 */
export class MockSource implements RegisteredSource {
  readonly id: SourceId;
  readonly name: string;
  readonly providerId: ProviderId;
  readonly unitName?: string;
  /**
   * A real source's family name comes from its definition, so it is the same
   * for every account. The mock names one account and so has to declare it
   * separately, the way a real one does.
   */
  readonly family: { name: string };
  readonly instance: MockSourceInstance;

  constructor(opts: MockSourceOptions) {
    const aid = opts.accountId ?? "test";
    this.id = SourceId(`${opts.sourceType}:${aid}`);
    this.name = `Mock ${opts.sourceType}`;
    this.family = { name: `Mock ${opts.sourceType}` };
    this.providerId = ProviderId(`${opts.providerType}:${aid}`);
    this.unitName = opts.unitName;
    this.instance = new MockSourceInstance(this.id, this.providerId);
  }

  // -- Convenience methods that delegate to instance --

  /** Recorded sync calls */
  get syncHistory() {
    return this.instance.syncHistory;
  }

  /** Set static document pages. Each page is returned on successive sync calls. */
  setDocuments(...pages: MockDocument[][]): void {
    this.instance.setDocuments(...pages);
  }

  /** Set a custom sync function for full control. */
  setSyncFn(fn: (cursor: SyncCursor | null) => Promise<SyncResult>): void {
    this.instance.setSyncFn(fn);
  }

  /** Make sync throw after `afterCalls` successful sync calls (0 = immediately). */
  setError(error: Error, afterCalls = 0): void {
    this.instance.setError(error, afterCalls);
  }

  /** Clear any set error. */
  clearError(): void {
    this.instance.clearError();
  }

  /** Set external IDs to report as deleted on next sync. */
  setDeletedIds(ids: string[]): void {
    this.instance.setDeletedIds(ids);
  }

  /** Enable push-based sync support. */
  enablePush(): void {
    this.instance.enablePush();
  }

  /** Fire a push event (triggers debounced sync in the engine). */
  emitPushEvent(): void {
    this.instance.emitPushEvent();
  }
}

class MockSourceInstance implements SourceInstance {
  syncHistory: Array<{ cursor: SyncCursor | null; callIndex: number }> = [];
  onPushEvent?: (callback: () => void) => void;

  private pages: MockDocument[][] = [];
  private customSyncFn: ((cursor: SyncCursor | null) => Promise<SyncResult>) | null = null;
  private errorToThrow: Error | null = null;
  private errorAfterCalls = 0;
  private deletedIds: string[] = [];
  private pushCallback: (() => void) | null = null;

  constructor(
    private sourceId: SourceId,
    private providerId: ProviderId,
  ) {}

  setDocuments(...pages: MockDocument[][]): void {
    this.pages = pages;
    this.customSyncFn = null;
  }

  setSyncFn(fn: (cursor: SyncCursor | null) => Promise<SyncResult>): void {
    this.customSyncFn = fn;
  }

  setError(error: Error, afterCalls = 0): void {
    this.errorToThrow = error;
    this.errorAfterCalls = afterCalls;
  }

  clearError(): void {
    this.errorToThrow = null;
    this.errorAfterCalls = 0;
  }

  setDeletedIds(ids: string[]): void {
    this.deletedIds = ids;
  }

  enablePush(): void {
    this.onPushEvent = (cb: () => void) => {
      this.pushCallback = cb;
    };
  }

  emitPushEvent(): void {
    this.pushCallback?.();
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const callIndex = this.syncHistory.length;
    this.syncHistory.push({ cursor, callIndex });

    // Error injection
    if (this.errorToThrow && callIndex >= this.errorAfterCalls) {
      throw this.errorToThrow;
    }

    // Custom sync function
    if (this.customSyncFn) {
      return this.customSyncFn(cursor);
    }

    // Static pages mode
    const pageIndex = (cursor as { page?: number } | null)?.page ?? 0;
    const docs = this.pages[pageIndex] ?? [];
    const hasMore = pageIndex < this.pages.length - 1;

    const documents: DocumentInput[] = docs.map((d) => ({
      providerId: this.providerId,
      sourceId: this.sourceId,
      externalId: d.externalId,
      title: d.title,
      content: d.content,
      contentHash: d.contentHash,
      metadata: d.metadata ?? {},
      sourceCreatedAt: d.sourceCreatedAt ?? "2025-01-01T00:00:00Z",
      sourceUpdatedAt: d.sourceUpdatedAt ?? "2025-01-01T00:00:00Z",
    }));

    const deletedExternalIds = pageIndex === 0 ? this.deletedIds : [];
    // Clear deleted IDs after first page so they aren't reported again
    if (pageIndex === 0) this.deletedIds = [];

    return {
      documents,
      deletedExternalIds,
      cursor: { page: hasMore ? pageIndex + 1 : pageIndex },
      hasMore,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

export function createMockProvider(
  providerType: string,
  accountId = "test",
  sources: RegisteredSource[] = [],
): RegisteredProvider {
  return {
    id: ProviderId(`${providerType}:${accountId}`),
    name: `Mock ${providerType}`,
    credentialState: () => Promise.resolve({ status: "connected" as const }),
    renewableCredential: true,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Mock SourceDescriptor
// ---------------------------------------------------------------------------

export function createMockDescriptor(sourceType: string, providerType: string): SourceDescriptor {
  return {
    id: SourceType(sourceType),
    name: `Mock ${sourceType}`,
    description: `Mock source for E2E testing: ${sourceType}`,
    provider: {
      id: ProviderType(providerType),
      name: `Mock ${providerType}`,
    },
    authType: "local",
    unitName: "items",
  };
}
