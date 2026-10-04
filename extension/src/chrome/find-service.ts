// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  browserUrl,
  readSourceLabels,
  readCanonicalizers,
  parseFindResults,
  type FindResult,
} from "./find-results.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core/url-normalize";
export { browserUrl, findSnippet, readCanonicalizers, type FindResult } from "./find-results.js";
import { FindProgress, type FindToolCard } from "./find-progress.js";
import { readFindStream } from "./find-stream.js";
import { readBoundedResponseText } from "../push/response-body.js";
import type { ExtensionConfig } from "./storage.js";

export const FIND_STATE_KEY = "omnesis.find.state.v1";
export const MAX_FIND_QUERY = 1024;
export interface FindDecision {
  mode: "direct" | "agentic";
  status: "decided" | "not_configured" | "unavailable";
  reason: string;
  model?: string;
}
interface FindState {
  pairing: string;
  supported: boolean;
  experimental?: boolean;
  canonicalizers: UrlCanonicalizerSpec[];
  sourceLabels: Record<string, string>;
  sourceAttributions: Record<string, string>;
  token?: string;
  requestId?: string;
  query: string;
  resultsQuery: string;
  results: FindResult[];
  limit: number;
  hasMore: boolean;
  decision?: FindDecision;
  agentText?: string;
  complete: boolean;
  progressRevision?: number;
  error?: string;
}
export interface FindView {
  canonicalizers: UrlCanonicalizerSpec[];
  supported: boolean;
  enabled: boolean;
  pendingApproval: boolean;
  query: string;
  resultsQuery: string;
  results: FindResult[];
  hasMore: boolean;
  decision?: FindDecision;
  agentText?: string;
  activity?: string;
  tools?: FindToolCard[];
  running: boolean;
  interrupted: boolean;
  error?: string;
}
interface FindDeps {
  config(): Promise<ExtensionConfig | null>;
  read(): Promise<unknown>;
  write(state: unknown): Promise<void>;
  fetch: typeof fetch;
}
function eraseRetrievedCache(state: FindState): void {
  state.results = [];
  state.resultsQuery = "";
  state.hasMore = false;
  state.complete = true;
  delete state.agentText;
  delete state.decision;
}
const pairing = (config: ExtensionConfig): string => `${config.gatewayUrl}\0${config.deviceId}`;
class FindHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gateway returned HTTP ${status}`);
  }
}

/** Durable search state and read authorization are owned exclusively by the worker. */
export class FindService {
  private lane: Promise<unknown> = Promise.resolve();
  private searchGeneration = 0;
  private searchAbort?: AbortController;
  private active?: { generation: number; query: string; activity?: string; tools: FindProgress };
  constructor(private readonly deps: FindDeps) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lane.then(work, work);
    this.lane = task.catch(() => undefined);
    return task;
  }
  private async load(): Promise<{ config: ExtensionConfig; state: FindState } | null> {
    const config = await this.deps.config();
    if (!config) return null;
    const raw = (await this.deps.read()) as Partial<FindState> | null;
    const empty: FindState = {
      pairing: pairing(config),
      supported: false,
      canonicalizers: [],
      sourceLabels: {},
      sourceAttributions: {},
      query: "",
      resultsQuery: "",
      results: [],
      limit: 25,
      hasMore: false,
      complete: true,
    };
    if (raw?.pairing !== empty.pairing) return { config, state: empty };
    return {
      config,
      state: {
        ...empty,
        supported: raw.supported === true && raw.experimental === true,
        experimental: raw.experimental === true,
        canonicalizers: readCanonicalizers(raw.canonicalizers),
        sourceLabels: readSourceLabels(raw.sourceLabels),
        sourceAttributions: readSourceLabels(raw.sourceAttributions, 1024),
        ...(typeof raw.token === "string" ? { token: raw.token } : {}),
        ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
        query: typeof raw.query === "string" ? raw.query.slice(0, MAX_FIND_QUERY) : "",
        resultsQuery:
          typeof raw.resultsQuery === "string" ? raw.resultsQuery.slice(0, MAX_FIND_QUERY) : "",
        results: Array.isArray(raw.results)
          ? raw.results
              .filter(
                (item) =>
                  item &&
                  typeof item.id === "string" &&
                  browserUrl(item.url) &&
                  typeof item.title === "string" &&
                  typeof item.snippet === "string" &&
                  typeof item.source === "string",
              )
              .slice(0, 200)
          : [],
        limit: [25, 50, 100, 200].includes(raw.limit ?? 0) ? raw.limit! : 25,
        hasMore: raw.hasMore === true,
        complete: raw.complete !== false,
        progressRevision: typeof raw.progressRevision === "number" ? raw.progressRevision : 0,
        ...(raw.decision &&
        ["direct", "agentic"].includes(raw.decision.mode) &&
        typeof raw.decision.reason === "string"
          ? { decision: raw.decision }
          : {}),
        ...(typeof raw.agentText === "string" ? { agentText: raw.agentText.slice(0, 32000) } : {}),
        ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      },
    };
  }
  private async persist(config: ExtensionConfig, state: FindState): Promise<void> {
    const current = await this.deps.config();
    if (!current || pairing(current) !== pairing(config) || current.token !== config.token)
      throw new Error("Browser pairing changed. Search stopped.");
    await this.deps.write(state);
  }
  private async request(
    config: ExtensionConfig,
    path: string,
    token?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.deps.fetch(`${config.gatewayUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(path === "/search" ? 15000 : 5000),
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) throw new FindHttpError(response.status);
    return JSON.parse(
      await readBoundedResponseText(response, path === "/search" ? 2000000 : 100000),
    ) as unknown;
  }
  private async refresh(config: ExtensionConfig, state: FindState): Promise<void> {
    let checking = "health";
    try {
      const health = (await this.request(config, "/health")) as {
        capabilities?: { browserFind?: { min?: unknown; max?: unknown } };
      };
      const range = health?.capabilities?.browserFind;
      const compatible =
        typeof range?.min === "number" &&
        typeof range.max === "number" &&
        Number.isInteger(range.min) &&
        Number.isInteger(range.max) &&
        range.min > 0 &&
        range.min <= range.max &&
        range.min <= 1 &&
        range.max >= 1;
      if (compatible) {
        checking = "experimental";
        const status = (await this.request(config, "/status", config.token)) as {
          experimental?: unknown;
        };
        state.experimental = status?.experimental === true;
        state.supported = state.experimental;
      } else {
        state.experimental = false;
        state.supported = false;
      }
      if (!state.supported) this.searchAbort?.abort();

      if (state.supported && state.token) {
        checking = "credential";
        const validation = (await this.request(config, "/browser/find", state.token)) as {
          enabled?: unknown;
          canonicalizers?: unknown;
          sourceLabels?: unknown;
          sourceAttributions?: unknown;
        };
        if (validation?.enabled !== true) throw new Error("Invalid Find authorization response");
        state.canonicalizers = readCanonicalizers(validation.canonicalizers);
        state.sourceLabels = readSourceLabels(validation.sourceLabels);
        state.sourceAttributions = readSourceLabels(validation.sourceAttributions, 1024);
      } else if (state.supported && state.requestId) {
        checking = "authorization";
        const auth = (await this.request(
          config,
          `/browser/find/authorization/${encodeURIComponent(state.requestId)}`,
          config.token,
        )) as {
          status?: string;
          credential?: { token?: string; deviceId?: string; scopes?: string[] };
        };
        if (
          auth.status === "approved" &&
          auth.credential?.deviceId === config.deviceId &&
          auth.credential.scopes?.length === 1 &&
          auth.credential.scopes[0] === "read" &&
          typeof auth.credential.token === "string" &&
          auth.credential.token.length > 0
        )
          state.token = auth.credential.token;
        else if (auth.status !== "pending") {
          eraseRetrievedCache(state);
          delete state.token;
          delete state.requestId;
        }
      }
      delete state.error;
    } catch (error) {
      if (error instanceof FindHttpError && [401, 403, 404, 410].includes(error.status)) {
        if (checking === "health" || checking === "experimental") {
          state.supported = false;
          state.experimental = false;
        }
        eraseRetrievedCache(state);
        this.searchAbort?.abort();
        delete state.token;
        delete state.requestId;
        if (error.status === 404 && checking !== "authorization") state.supported = false;
      } else if (checking !== "health") {
        // Read access is revalidated before each search; an outage keeps local results only.
        state.error = "Gateway unavailable. Your previous search is kept in this browser.";
      }
    }
    await this.persist(config, state);
  }
  private view(state?: FindState): FindView {
    const enabled = !!state?.supported && !!state.token;
    return {
      canonicalizers: enabled ? state!.canonicalizers : [],
      supported: state?.supported ?? false,
      enabled,
      pendingApproval: !!state?.requestId && !state.token,
      query: state?.query ?? "",
      resultsQuery: state?.resultsQuery ?? "",
      results: enabled ? state!.results : [],
      hasMore: enabled && !!state?.hasMore,
      decision: enabled ? state?.decision : undefined,
      agentText: enabled ? state?.agentText : undefined,
      activity: enabled ? this.active?.activity : undefined,
      tools: enabled ? this.active?.tools.snapshot() : [],
      running: enabled && this.active?.query === state?.resultsQuery,
      interrupted:
        enabled && state?.complete === false && this.active?.query !== state?.resultsQuery,
      error: state?.error,
    };
  }
  status(fresh = true): Promise<FindView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      if (fresh) await this.refresh(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  activate(): Promise<string> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) throw new Error("Pair this browser first");
      const { config, state } = loaded;
      await this.refresh(config, state);
      if (!state.supported) throw new Error("Find is unavailable on this gateway");
      if (!state.requestId) {
        state.requestId = crypto.randomUUID();
        await this.persist(config, state);
      }
      const approval = (await this.request(config, "/browser/find/authorization", config.token, {
        id: state.requestId,
      })) as { requestId?: unknown; approvalPath?: unknown };
      if (
        typeof approval.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(approval.requestId) ||
        typeof approval.approvalPath !== "string" ||
        !approval.approvalPath.startsWith("/portal/") ||
        approval.approvalPath.startsWith("//")
      )
        throw new Error("Gateway returned an invalid approval link");
      const url = new URL(approval.approvalPath, config.gatewayUrl);
      if (url.origin !== new URL(config.gatewayUrl).origin)
        throw new Error("Invalid approval origin");
      state.requestId = approval.requestId;
      await this.persist(config, state);
      return url.href;
    });
  }
  update(query: string): Promise<FindView> {
    if (this.active && query !== this.active.query) this.searchAbort?.abort();
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      loaded.state.query = query.slice(0, MAX_FIND_QUERY);
      await this.persist(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  async search(query: string, more = false): Promise<FindView> {
    query = query.slice(0, MAX_FIND_QUERY);
    const generation = ++this.searchGeneration;
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    this.active = { generation, query, tools: new FindProgress() };
    try {
      const loaded = await this.run(async () => {
        const loaded = await this.load();
        if (!loaded) return null;
        loaded.state.query = query;
        await this.persist(loaded.config, loaded.state);
        await this.refresh(loaded.config, loaded.state);
        return loaded;
      });
      if (!loaded) {
        if (generation === this.searchGeneration) this.active = undefined;
        return this.view();
      }
      if (generation !== this.searchGeneration || controller.signal.aborted) {
        if (this.active?.generation === generation) this.active = undefined;
        return this.status(false);
      }
      const { config, state } = loaded;
      if (!state.supported || !state.token) {
        this.active = undefined;
        return this.view(state);
      }
      const authorizationToken = state.token;
      const limit = more && state.resultsQuery === query ? Math.min(state.limit * 2, 200) : 25;
      state.resultsQuery = query;
      state.results = [];
      state.complete = false;
      state.hasMore = false;
      state.agentText = "";
      delete state.decision;
      delete state.error;
      let lastPublished = 0;
      const publish = async (): Promise<void> => {
        await this.run(async () => {
          const latest = await this.load();
          if (
            !latest ||
            generation !== this.searchGeneration ||
            pairing(latest.config) !== pairing(config) ||
            latest.config.token !== config.token ||
            latest.state.token !== authorizationToken ||
            !latest.state.supported
          )
            return;
          const next = {
            ...state,
            query: latest.state.query,
            progressRevision: (latest.state.progressRevision ?? 0) + 1,
          };
          await this.persist(config, next);
          lastPublished = Date.now();
        });
      };
      await publish();
      try {
        if (!query.trim()) state.complete = true;
        else {
          controller.signal.throwIfAborted();
          const response = await this.deps.fetch(`${config.gatewayUrl}/browser/find/search`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
            body: JSON.stringify({
              text: query,
              limit,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
            redirect: "error",
            credentials: "omit",
          });
          if (!response.ok) throw new FindHttpError(response.status);
          await readFindStream(
            response,
            async ({ type, payload }) => {
              if (generation !== this.searchGeneration) return;
              if (type === "find.decision") {
                if (
                  !["direct", "agentic"].includes(String(payload.mode)) ||
                  typeof payload.reason !== "string"
                )
                  throw new Error("Invalid Find decision");
                state.decision = {
                  mode: payload.mode as "direct" | "agentic",
                  status: ["decided", "not_configured", "unavailable"].includes(
                    String(payload.status),
                  )
                    ? (payload.status as FindDecision["status"])
                    : "unavailable",
                  reason: payload.reason.slice(0, 2000),
                  ...(typeof payload.model === "string"
                    ? { model: payload.model.slice(0, 128) }
                    : {}),
                };
              } else if (type === "find.results") {
                if (!Array.isArray(payload.results)) throw new Error("Invalid Find results");
                const cards = parseFindResults(
                  payload.results,
                  state.sourceLabels,
                  query,
                  state.sourceAttributions,
                );
                const merged = new Map(state.results.map((card) => [card.id, card]));
                for (const card of cards) merged.set(card.id, card);
                state.results = [...merged.values()].slice(0, 200);
                state.hasMore = payload.hasMore === true && limit < 200;
                state.limit = limit;
              } else if (type === "find.complete") state.complete = true;
              else if (type === "find.error" || type === "agent.error") {
                if (payload.code === "FIND_PERMISSION_REVOKED") throw new FindHttpError(401);
                throw new Error(
                  typeof payload.message === "string"
                    ? payload.message.slice(0, 2000)
                    : "Search failed",
                );
              } else if (type === "agent.text.delta" && typeof payload.delta === "string")
                state.agentText = ((state.agentText ?? "") + payload.delta).slice(0, 32000);
              else if (
                (type === "agent.tool.start" || type === "agent.tool.input_start") &&
                typeof payload.tool === "string"
              ) {
                if (this.active?.generation === generation)
                  this.active.activity = payload.tool.replace(/_/g, " ").slice(0, 128);
              } else if (type === "agent.tool.result") {
                if (this.active?.generation === generation) this.active.activity = undefined;
              } else return;
              if (this.active?.generation === generation) this.active.tools.update(type, payload);
              if (type !== "agent.text.delta" || Date.now() - lastPublished >= 150) await publish();
            },
            controller.signal,
          );
          if (!state.complete)
            throw new Error("Search was interrupted. Results are kept; try again.");
        }
      } catch (error) {
        if (generation !== this.searchGeneration) return this.status(false);
        if (error instanceof FindHttpError && [401, 403, 404, 410].includes(error.status)) {
          eraseRetrievedCache(state);
          delete state.token;
          delete state.requestId;
        }
        state.error = controller.signal.aborted
          ? "Search canceled. Results are kept."
          : error instanceof Error
            ? error.message
            : "Search failed. Try again.";
      } finally {
        if (this.active?.generation === generation) this.active = undefined;
      }
      await publish();
      return this.status(false);
    } finally {
      if (this.active?.generation === generation) this.active = undefined;
      if (this.searchAbort === controller) this.searchAbort = undefined;
    }
  }
  cancel(): Promise<FindView> {
    this.searchAbort?.abort();
    return this.status(false);
  }

  clear(): Promise<void> {
    this.searchGeneration++;
    this.searchAbort?.abort();
    this.active = undefined;
    return this.run(async () => this.deps.write(null));
  }
}
