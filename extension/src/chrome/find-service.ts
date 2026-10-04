// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  browserUrl,
  readSourceLabels,
  readCanonicalizers,
  parseFindResults,
  dedupeFindResults,
  readSourceIcons,
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
  automatic?: boolean;
  canonicalizers: UrlCanonicalizerSpec[];
  sourceLabels: Record<string, string>;
  sourceAttributions: Record<string, string>;
  sourceIcons: Record<string, string>;
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
  progressId?: string;
  sourceLabels?: Record<string, string>;
  sourceIcons?: Record<string, string>;
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
  private suggestionGeneration = 0;
  private suggestionAbort?: AbortController;
  private suggestionsSupported = false;
  private searchAbort?: AbortController;
  private transcript?: { query: string; id: string; progress: FindProgress };
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
      sourceIcons: {},
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
        supported: raw.supported === true && raw.experimental === true && raw.automatic === true,
        automatic: raw.automatic === true,
        experimental: raw.experimental === true,
        canonicalizers: readCanonicalizers(raw.canonicalizers),
        sourceLabels: readSourceLabels(raw.sourceLabels),
        sourceAttributions: readSourceLabels(raw.sourceAttributions, 1024),
        sourceIcons: readSourceIcons(raw.sourceIcons),
        ...(typeof raw.token === "string" ? { token: raw.token } : {}),
        ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
        query: typeof raw.query === "string" ? raw.query.slice(0, MAX_FIND_QUERY) : "",
        resultsQuery:
          typeof raw.resultsQuery === "string" ? raw.resultsQuery.slice(0, MAX_FIND_QUERY) : "",
        results: Array.isArray(raw.results)
          ? dedupeFindResults(
              raw.results
                .filter(
                  (item) =>
                    item &&
                    typeof item.id === "string" &&
                    browserUrl(item.url) &&
                    typeof item.title === "string" &&
                    typeof item.snippet === "string" &&
                    typeof item.source === "string",
                )
                .slice(0, 200),
              readCanonicalizers(raw.canonicalizers),
            )
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
      await readBoundedResponseText(
        response,
        ["/search", "/browser/find", "/browser/find/suggest"].includes(path) ? 2000000 : 100000,
      ),
    ) as unknown;
  }
  private async refresh(
    config: ExtensionConfig,
    state: FindState,
    signal?: AbortSignal,
  ): Promise<void> {
    let checking = "health";
    try {
      const health = (await this.request(config, "/health", undefined, undefined, signal)) as {
        experimental?: unknown;
        capabilities?: {
          browserFind?: { min?: unknown; max?: unknown };
          browserFeatures?: { min?: unknown; max?: unknown };
          browserFindSuggest?: { min?: unknown; max?: unknown };
        };
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
      const broker = health?.capabilities?.browserFeatures;
      const automatic =
        typeof broker?.min === "number" &&
        typeof broker.max === "number" &&
        Number.isInteger(broker.min) &&
        Number.isInteger(broker.max) &&
        broker.min > 0 &&
        broker.min <= broker.max &&
        broker.min <= 1 &&
        broker.max >= 1;
      state.automatic = automatic;
      state.experimental = health?.experimental === true;
      state.supported = compatible && automatic && state.experimental;
      const suggest = health?.capabilities?.browserFindSuggest;
      this.suggestionsSupported =
        state.supported &&
        typeof suggest?.min === "number" &&
        typeof suggest.max === "number" &&
        Number.isInteger(suggest.min) &&
        Number.isInteger(suggest.max) &&
        suggest.min > 0 &&
        suggest.min <= 1 &&
        suggest.max >= 1;

      if (!state.supported) this.searchAbort?.abort();

      if (state.supported && !state.token) {
        checking = "automatic authorization";
        state.requestId ??= crypto.randomUUID();
        await this.persist(config, state);
        const response = (await this.request(
          config,
          "/browser/find/enable",
          config.token,
          {
            id: state.requestId,
          },
          signal,
        )) as {
          status?: unknown;
          credential?: { token?: unknown; tokenId?: unknown; deviceId?: unknown; scopes?: unknown };
        };
        const credential = response?.credential;
        if (
          response?.status !== "approved" ||
          credential?.deviceId !== config.deviceId ||
          !Array.isArray(credential.scopes) ||
          credential.scopes.length !== 1 ||
          credential.scopes[0] !== "read" ||
          typeof credential.token !== "string" ||
          !credential.token.length ||
          credential.token.length > 8192 ||
          typeof credential.tokenId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(credential.tokenId)
        )
          throw new Error("Gateway returned an invalid Find credential");
        state.token = credential.token;
        delete state.requestId;
        await this.persist(config, state);
      }
      if (state.supported && state.token) {
        checking = "credential";
        const validation = (await this.request(
          config,
          "/browser/find",
          state.token,
          undefined,
          signal,
        )) as {
          enabled?: unknown;
          canonicalizers?: unknown;
          sourceLabels?: unknown;
          sourceAttributions?: unknown;
          sourceIcons?: unknown;
        };
        if (validation?.enabled !== true) throw new Error("Invalid Find authorization response");
        state.canonicalizers = readCanonicalizers(validation.canonicalizers);
        state.sourceLabels = readSourceLabels(validation.sourceLabels);
        state.sourceAttributions = readSourceLabels(validation.sourceAttributions, 1024);
        state.sourceIcons = readSourceIcons(validation.sourceIcons);
      }
      delete state.error;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.suggestionsSupported = false;
      if (error instanceof FindHttpError && [401, 403, 404, 410].includes(error.status)) {
        if (checking === "health") {
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
      pendingApproval: false,
      query: state?.query ?? "",
      resultsQuery: state?.resultsQuery ?? "",
      results: enabled ? state!.results : [],
      hasMore: enabled && !!state?.hasMore,
      decision: enabled ? state?.decision : undefined,
      agentText: enabled ? state?.agentText : undefined,
      activity: enabled ? this.active?.activity : undefined,
      tools:
        enabled && this.transcript?.query === state?.resultsQuery
          ? this.transcript.progress.snapshot()
          : [],
      progressId:
        enabled && this.transcript?.query === state?.resultsQuery ? this.transcript.id : undefined,
      sourceLabels: enabled ? state?.sourceLabels : {},
      sourceIcons: enabled ? state?.sourceIcons : {},
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
  /** Address-bar previews use configured retrieval without decision or agent turns and never become the durable Find conversation. */
  async suggest(query: string, signal?: AbortSignal): Promise<FindResult[]> {
    const generation = ++this.suggestionGeneration;
    this.suggestionAbort?.abort();
    const controller = new AbortController();
    this.suggestionAbort = controller;
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    query = query.slice(0, MAX_FIND_QUERY).trim();
    let authority: { config: ExtensionConfig; token: string } | undefined;
    try {
      if (!query) return [];
      const loaded = await this.run(async () => {
        abort.throwIfAborted();
        const loaded = await this.load();
        if (!loaded) return null;
        await this.refresh(loaded.config, loaded.state, abort);
        return loaded;
      });
      abort.throwIfAborted();
      if (!loaded || !this.suggestionsSupported || !this.view(loaded.state).enabled) return [];
      const { config, state } = loaded;
      authority = { config, token: state.token! };
      const response = (await this.request(
        config,
        "/browser/find/suggest",
        state.token,
        { version: 1, text: query, limit: 5 },
        abort,
      )) as { results?: unknown };
      abort.throwIfAborted();
      if (!Array.isArray(response?.results)) throw new Error("Invalid Find suggestions response");
      const latest = await this.load();
      if (
        generation !== this.suggestionGeneration ||
        !latest ||
        pairing(latest.config) !== pairing(config) ||
        latest.config.token !== config.token ||
        latest.state.token !== state.token ||
        !this.view(latest.state).enabled
      )
        return [];
      return dedupeFindResults(
        parseFindResults(response.results, state.sourceLabels, query, state.sourceAttributions),
        state.canonicalizers,
      ).slice(0, 5);
    } catch (error) {
      if (abort.aborted || generation !== this.suggestionGeneration) return [];
      if (error instanceof FindHttpError && [401, 403, 404, 410].includes(error.status)) {
        await this.run(async () => {
          const loaded = await this.load();
          if (
            !loaded ||
            !authority ||
            pairing(loaded.config) !== pairing(authority.config) ||
            loaded.config.token !== authority.config.token ||
            loaded.state.token !== authority.token
          )
            return;
          eraseRetrievedCache(loaded.state);
          delete loaded.state.token;
          loaded.state.supported = false;
          this.suggestionsSupported = false;
          await this.persist(loaded.config, loaded.state);
        });
      }
      return [];
    } finally {
      if (this.suggestionAbort === controller) this.suggestionAbort = undefined;
    }
  }
  async search(query: string, more = false): Promise<FindView> {
    this.suggestionAbort?.abort();
    query = query.slice(0, MAX_FIND_QUERY);
    const generation = ++this.searchGeneration;
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    const progress = new FindProgress();
    this.active = { generation, query, tools: progress };
    this.transcript = { query, id: crypto.randomUUID(), progress };
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
                state.results = dedupeFindResults(
                  [...state.results, ...cards],
                  state.canonicalizers,
                );
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
              } else if (type === "agent.tool.child.start" || type === "agent.tool.child.result") {
                // Keep the shared batch renderer's source-shaped child payloads intact.
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
        if (this.active?.generation === generation) {
          progress.finish();
          this.active = undefined;
        }
      }
      await publish();
      return this.status(false);
    } finally {
      if (this.active?.generation === generation) this.active = undefined;
      if (this.searchAbort === controller) this.searchAbort = undefined;
    }
  }
  flushProgress(toolCallId: string, progressId: string): Promise<FindView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded || !this.view(loaded.state).enabled) return this.view(loaded?.state);
      if (this.transcript?.id !== progressId) return this.view(loaded.state);
      this.transcript.progress.flush(toolCallId);
      loaded.state.progressRevision = (loaded.state.progressRevision ?? 0) + 1;
      await this.persist(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  cancel(): Promise<FindView> {
    this.searchAbort?.abort();
    return this.status(false);
  }

  clear(): Promise<void> {
    this.searchGeneration++;
    this.suggestionGeneration++;
    this.suggestionAbort?.abort();
    this.suggestionsSupported = false;
    this.searchAbort?.abort();
    this.active = undefined;
    this.transcript = undefined;
    return this.run(async () => this.deps.write(null));
  }
}
