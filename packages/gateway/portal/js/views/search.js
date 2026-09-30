// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { sourceTypeOf } from "../lib/source-id.js";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import {
  search,
  getSearchReadiness,
  getDocumentsPeopleBulk,
  getPeople,
  getStatus,
  searchAgentContext,
  getDocumentSummariesBulk,
} from "../api.js";
import { ResultCard } from "../components/result-card.js";
import { FacetPanel } from "../components/facets.js";
import { PipelineDebug } from "../components/pipeline-debug.js";
import { IndexerWarmingCard } from "../components/indexer-warming-card.js";
import { STORAGE_PREFIXES } from "../lib/storage.js";
import { SearchProvenance } from "../components/search-provenance.js";
import { provenanceForResults, provenancePanels, provenanceDocumentIds, graphContextNotice } from "../lib/search-provenance.js";

// Pull the Omnesis prefix from the shared storage module so logout's
// `clearOmnesisStorage()` and this view's cache key stay in sync — if a
// future logout helper is added, it will already cover this key.
const SEARCH_CACHE_KEY = `${STORAGE_PREFIXES[0]}search_cache`;

// Hard refresh = empty search. Browser back-nav from a doc = restore
// cached results. The Performance Navigation Timing API distinguishes
// the two: a reload returns "reload" here exactly once per page load,
// so wiping the cache at module load is enough — subsequent in-SPA
// back/forward navigations don't re-evaluate the module and keep the
// cache that was saved during the last SearchView unmount.
try {
  const navType = performance.getEntriesByType("navigation")[0]?.type;
  if (navType === "reload") {
    sessionStorage.removeItem(SEARCH_CACHE_KEY);
  }
} catch { /* performance API not available — leave cache alone */ }

function saveSearchCache(data) {
  try {
    sessionStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(data));
  } catch { /* ignore quota errors */ }
}

function loadSearchCache() {
  try {
    const raw = sessionStorage.getItem(SEARCH_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSearchCache() {
  sessionStorage.removeItem(SEARCH_CACHE_KEY);
}

export function SearchView() {
  const cached = loadSearchCache();

  const [query, setQuery] = useState(cached?.query || "");
  const [verbose, setVerbose] = useState(cached?.verbose || false);
  const [results, setResults] = useState(cached?.results || null);
  const [response, setResponse] = useState(cached?.response || null);
  const [peopleByDoc, setPeopleByDoc] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [completedQuery, setCompletedQuery] = useState(
    typeof cached?.response?.query?.original === "string" ? cached.response.query.original : null,
  );
  const [provenanceByDoc, setProvenanceByDoc] = useState({});
  const [contextDocuments, setContextDocuments] = useState({});
  const [contextNotice, setContextNotice] = useState(null);
  const searchSequence = useRef(0);
  // Indexer readiness snapshot. Polled every 3s while the
  // embedder is still loading so the "warming up" banner disappears on
  // its own when the worker becomes ready.
  const [readiness, setReadiness] = useState(null);
  // Corpus-anchored examples for the empty-state syntax help — fetched
  // once at mount so the user sees `from:<their top contact>` instead
  // of `from:alice@example.com`. Falls back to generic placeholders if
  // the gateway hasn't responded yet (or the corpus is still empty).
  const [exampleAnchors, setExampleAnchors] = useState(null);
  const inputRef = useRef(null);

  // Use a ref to track current state for the unmount cleanup
  const stateRef = useRef({ query: cached?.query || "", verbose: cached?.verbose || false, results: cached?.results || null, response: cached?.response || null });

  // Keep stateRef in sync with state changes
  useEffect(() => { stateRef.current.query = query; }, [query]);
  useEffect(() => { stateRef.current.verbose = verbose; }, [verbose]);
  useEffect(() => { stateRef.current.results = results; }, [results]);
  useEffect(() => { stateRef.current.response = response; }, [response]);

  // Pick corpus-anchored example values once at mount. Best-effort:
  // any failure leaves `exampleAnchors` null and the help block falls
  // back to its generic placeholders, so a cold gateway / un-synced
  // corpus never blocks the empty-state from rendering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [peopleResp, status] = await Promise.all([
          getPeople("", 10).catch(() => ({ people: [] })),
          getStatus().catch(() => null),
        ]);
        if (cancelled) return;
        const topPerson = (peopleResp.people || []).find((p) => !p.isSelf) ?? null;
        const bySource = status?.documents?.bySource ?? {};
        // Prefer an account-bearing source (`<type>:<account>`), which is
        // typically more useful in a search example than an internal source.
        const ranked = Object.entries(bySource)
          .filter(([id]) => typeof id === "string")
          .sort((a, b) => (b[1] || 0) - (a[1] || 0));
        const topAccountSource = ranked.find(([id]) => id.includes(":"))?.[0] ?? null;
        const topAnySource = ranked[0]?.[0] ?? null;
        setExampleAnchors({ topPerson, topAccountSource, topAnySource });
      } catch {
        /* leave anchors null; help block falls back to placeholders */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-focus search input on mount; restore scroll position from cache
  // Save scroll position + state to sessionStorage on unmount
  useEffect(() => {
    inputRef.current?.focus();
    if (cached?.scrollY != null) {
      requestAnimationFrame(() => window.scrollTo(0, cached.scrollY));
    }
    // Backfill people-bubbles when restoring from cache (the bubble
    // map isn't persisted). Fire-and-forget; bubbles are optional.
    if (cached?.results?.length) {
      const ids = cached.results.map((r) => r.documentId).filter(Boolean);
      if (ids.length > 0) {
        getDocumentsPeopleBulk(ids)
          .then((bulk) => setPeopleByDoc(bulk.docs ?? {}))
          .catch(() => {});
      }
    }
    return () => {
      searchSequence.current++;
      const s = stateRef.current;
      if (s.results) {
        saveSearchCache({ query: s.query, verbose: s.verbose, results: s.results, response: s.response, scrollY: window.scrollY });
      }
    };
  }, []);

  const doSearch = useCallback(async (text, v) => {
    if (!text.trim()) return;
    const sequence = ++searchSequence.current;
    setLoading(true);
    setError(null);
    setCompletedQuery(null);
    setProvenanceByDoc({});
    setContextDocuments({});
    setContextNotice(null);
    // Capability belongs to this request epoch; do not reuse a previous grant.
    setReadiness((current) => ({ ...current, agentContextAvailable: false }));
    getSearchReadiness()
      .then((current) => { if (sequence === searchSequence.current) setReadiness(current); })
      .catch(() => {});
    try {
      const res = await search(text, { verbose: v });
      if (sequence !== searchSequence.current) return;
      setResponse(res);
      setResults(res.results || []);
      setCompletedQuery(text);
      setPeopleByDoc({});
      saveSearchCache({ query: text, verbose: v, results: res.results || [], response: res, scrollY: 0 });
      const ids = (res.results || []).map((x) => x.documentId).filter(Boolean);
      if (ids.length > 0) {
        getDocumentsPeopleBulk(ids)
          .then((bulk) => { if (sequence === searchSequence.current) setPeopleByDoc(bulk.docs ?? {}); })
          .catch(() => {});
      }
    } catch (err) {
      if (sequence !== searchSequence.current) return;
      console.error("Search error:", err);
      // Keep the prior results null so we don't show a misleading
      // "No results found" when the backend actually failed. The UI
      // renders the error banner instead.
      setResults(null);
      setResponse(null);
      // Surface the X-Request-Id (first 8 chars) so the user can
      // copy-paste it when filing a bug. The id flows through from
      // `request()` in api.js.
      const message = err instanceof Error ? err.message : String(err);
      const reqId = err?.requestId ? ` [id=${String(err.requestId).slice(0, 8)}]` : "";
      setError(`${message}${reqId}`);
      clearSearchCache();
    } finally {
      if (sequence === searchSequence.current) setLoading(false);
    }
  }, []);

  // Diagnostic context is never cached. A capability change or a newer search
  // invalidates the in-flight response before it can attach to another query.
  useEffect(() => {
    let cancelled = false;
    const sequence = searchSequence.current;
    setProvenanceByDoc({});
    setContextDocuments({});
    setContextNotice(null);
    if (readiness?.agentContextAvailable === true && completedQuery && results?.length) {
      searchAgentContext(completedQuery)
        .then(async (context) => {
          if (cancelled || sequence !== searchSequence.current) return;
          let documents = {};
          try {
            documents = (await getDocumentSummariesBulk(provenanceDocumentIds(context))).docs || {};
          } catch { /* Missing summaries retain linked document placeholders. */ }
          if (!cancelled && sequence === searchSequence.current) {
            setContextDocuments(documents);
            setProvenanceByDoc(provenanceForResults(context, results));
          }
        })
        .catch((err) => {
          if (!cancelled && sequence === searchSequence.current) {
            setContextNotice(graphContextNotice(err));
            if ([403, 404, 405].includes(err?.status)) {
              setReadiness((current) => ({ ...current, agentContextAvailable: false }));
            }
          }
        });
    }
    return () => { cancelled = true; };
  }, [completedQuery, results, readiness?.agentContextAvailable]);

  function handleSubmit(e) {
    e.preventDefault();
    doSearch(query, verbose);
  }

  function handleFilter(filterType, value) {
    const prefix = filterType === "type" ? "type:" : "source:";
    const newQuery = `${query.trim()} ${prefix}${value}`;
    setQuery(newQuery);
    doSearch(newQuery, verbose);
  }

  // Readiness polling. Only runs while the worker is not yet ready —
  // stops once it reports ready/failed/disabled so we don't hammer the
  // endpoint forever.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      const sequence = searchSequence.current;
      try {
        const r = await getSearchReadiness();
        if (cancelled) return;
        if (sequence === searchSequence.current) setReadiness(r);
        if (r?.indexer?.status === "loading-model" || r?.indexer?.status === "spawning") {
          timer = setTimeout(tick, r?.indexer?.status === "loading-model" ? 1000 : 3000);
        }
      } catch {
        if (cancelled) return;
        timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const hasSearched = results !== null;
  const contextPanels = readiness?.agentContextAvailable === true
    ? provenancePanels(results, provenanceByDoc)
    : Object.create(null);

  return html`
    <div class="search-view">
      <form class="search-bar" onSubmit=${handleSubmit}>
        <div class="search-input-wrap">
          <input
            ref=${inputRef}
            class="search-input"
            type="text"
            placeholder="Search your digital life..."
            aria-label="Search query"
            value=${query}
            onInput=${(e) => setQuery(e.target.value)}
          />
          <button
            type="submit"
            class="search-submit"
            disabled=${loading || !query.trim()}
            title="Search (Enter)"
          >
            ${loading ? html`<span class="spinner"></span>` : "Search"}
          </button>
        </div>
        <div class="search-controls">
          <label class="toggle-label">
            <input type="checkbox" checked=${verbose} onChange=${(e) => setVerbose(e.target.checked)} />
            Verbose
          </label>
        </div>
      </form>

      <${IndexerWarmingCard} readiness=${readiness} />

      ${!loading && error && html`
        <div class="search-error" role="alert">
          <div class="search-error-title">Search failed</div>
          <div class="search-error-message">${error}</div>
          <button class="search-error-retry" onClick=${() => doSearch(query, verbose)}>
            Retry
          </button>
        </div>
      `}

      ${loading && html`<div class="loading"><span class="spinner"></span> Searching...</div>`}

      ${!loading && !error && hasSearched && results.length === 0 && html`
        <div class="empty-state">
          <h2>No results found</h2>
          <p>Try different keywords or adjust your search.</p>
        </div>
      `}

      ${!loading && !hasSearched && html`
        <${SearchHelp} anchors=${exampleAnchors} />
      `}

      ${!loading && results && results.length > 0 && html`
        <div>
          ${verbose && response && html`<${PipelineDebug} response=${response} />`}
          ${contextNotice && html`<p class="search-context-notice" role="status">${contextNotice}</p>`}
          <div class="results-count">${results.length} result${results.length !== 1 ? "s" : ""}</div>
          <div class="results-layout">
            <div class="result-list">
              ${results.map((r) => html`
                <div class="search-result-with-context" key=${r.documentId}>
                <${ResultCard}
                  result=${r}
                  query=${query}
                  verbose=${verbose}
                  peopleSummary=${peopleByDoc[r.documentId]}
                />
                ${contextPanels[r.documentId] && !contextPanels[r.documentId].repeated && html`<${SearchProvenance} provenance=${contextPanels[r.documentId].provenance} documents=${contextDocuments} panelId=${contextPanels[r.documentId].panelId} resultDocumentId=${r.documentId} />`}

                </div>
              `)}
            </div>
            <${FacetPanel} results=${results} onFilter=${handleFilter} />
          </div>
        </div>
      `}
    </div>
  `;
}

/**
 * Pick a person email-alias if one exists. Falls back to the canonical
 * name. Used to render two `from:` examples — one with the bare name
 * (substring match on the people graph's `name`-type aliases) and one
 * with the full email (exact match on `email`-type aliases), so the
 * help text demonstrates that both work.
 */
function pickPersonEmail(person) {
  if (!person?.aliases) return null;
  const emailAlias = person.aliases.find((a) => a.aliasType === "email");
  return emailAlias?.alias ?? null;
}

/**
 * Empty-state syntax help. Every example is corpus-anchored when the
 * gateway returns enough data (top non-self person for `from:`,
 * top account-bearing source for `source:`); falls back to generic
 * placeholders while the fetch is in flight or on a cold corpus.
 *
 * The list intentionally covers a broad set of filter shapes; more may
 * be added over time (negation, `has:`, `is:`, person-graph traversal,
 * etc.).
 */
function SearchHelp({ anchors }) {
  const person = anchors?.topPerson ?? null;
  // Pick a one-word name fragment (the people graph does a
  // case-insensitive substring match on `name`-type aliases, so a
  // first name is enough). Fall back to a non-loaded placeholder
  // that's clearly a placeholder ("Sarah"), not a real corpus value.
  const firstName = person?.canonicalName?.split(/\s+/)?.[0] ?? "Sarah";
  const fullName = person?.canonicalName ?? "Sarah Connor";
  const email = pickPersonEmail(person) ?? "sarah@work.com";
  const fullSource = anchors?.topAccountSource ?? "gmail:user@example.com";
  // Derive a bare-type example by stripping the account half off the
  // top account-bearing source. Defaults to `gmail` so users always
  // see how the bare form looks even on a fresh gateway.
  const bareType = sourceTypeOf(fullSource) || "gmail";

  return html`
    <div class="empty-state">
      <h2>Search your data</h2>
      <p>Type a query and press Enter. Mix plain text with the filter tokens below.</p>
      <dl class="syntax-help">
        <dt>from:${firstName}</dt>
        <dd>By sender — name fragment (case-insensitive substring match against the people graph)</dd>
        <dt>from:${email}</dt>
        <dd>By sender — exact email; phones (<code>+15551234567</code>) and the literal <code>me</code> also resolve</dd>
        <dt>to:me</dt>
        <dd>Where you were a recipient or an invited attendee (resolves to the gateway-detected self-person)</dd>
        <dt>with:"${fullName}"</dt>
        <dd>Any role — sender, recipient, attendee, participant, mention. Quote names with spaces.</dd>
        <dt>from:alice to:bob</dt>
        <dd>AND across intents — Alice sent AND Bob received (not "either one")</dd>
        <dt>type:email</dt>
        <dd>By document type — <code>email</code>, <code>event</code>, <code>note</code>, <code>conversation</code>, <code>file</code>, <code>attachment</code>, <code>task</code>, <code>contact</code>, <code>bookmark</code>, <code>webpage</code>, <code>browsing-history</code>, <code>activity</code>, <code>document</code>, <code>reminder</code>, <code>project</code></dd>
        <dt>source:${fullSource}</dt>
        <dd>Full source ID — exact match</dd>
        <dt>source:${bareType}</dt>
        <dd>Bare source type — every configured ${bareType} account</dd>
        <dt>source:google</dt>
        <dd>Provider type — every source under that provider (gmail + calendar + drive + contacts)</dd>
        <dt>after:"last week"</dt>
        <dd>Relative date — also <code>today</code>, <code>yesterday</code>, <code>"last month"</code>, <code>"last year"</code></dd>
        <dt>before:2024-01-01</dt>
        <dd>Upper bound (ISO <code>YYYY-MM-DD</code> only — no time/timezone)</dd>
        <dt>#INBOX</dt>
        <dd>Tag — case-insensitive; <code>tag:work</code> is the equivalent explicit form</dd>
      </dl>
      <p class="syntax-help-hint">
        Filters of the same intent OR (<code>from:alice from:bob</code> → either). Different filters AND.
        Boolean operators (<code>AND</code>/<code>OR</code>/<code>NOT</code>) aren't supported — quote a phrase to match it literally.
      </p>
    </div>
  `;
}
