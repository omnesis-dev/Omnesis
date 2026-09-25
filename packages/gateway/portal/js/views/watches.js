// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Watches — what Omnesis has been asked to keep an eye on.
 *
 * One list, whatever store a watch's id came from. Who asked for it, where its
 * firings go and whether it is still running are attributes of the row, not
 * sections it belongs to: every row states its own status, so a heading above a
 * group of them would say the same thing a second time and turn one list into
 * three. Order carries it instead — running first, finished last.
 *
 * A request to create a watch is pinned at the top of that same list. It is a
 * different noun — none of them is a watch yet — but it is the one thing on
 * this page that wants an answer, and a reader looking for it should find it
 * where they are already looking rather than under a heading of its own.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  getPrivacySubscription,
  getWatchV2Watch,
  listSubscriptionApprovals,
  listWatchV2Watches,
} from "../api.js";
import { LoadMore } from "../components/load-more.js";
import { Loading } from "../components/loading.js";
import { navigate, replaceRoute } from "../lib/router.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { errorMessage, privacyCollection } from "./shared/privacy-vocabulary.js";
import { SubscriptionApprovalList, SubscriptionApprovalRoute } from "./watches/approval.js";
import { PrivacySubscriptionFiringRoute } from "./watches/firing.js";
import { InstalledWatchList, InstalledWatchRoute } from "./watches/installed.js";
import { installedWatchDocument } from "./watches/vocabulary.js";

/**
 * Every watch the runtime is running.
 *
 * Not paged: the route answers with all of them in one response, because the
 * definitions are few and the listing deliberately omits the one large field
 * each carries. A 404 is the runtime saying it is not there, which is a state
 * of the install rather than a failure of this read.
 */
function useInstalledWatches() {
  const [watches, setWatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    listWatchV2Watches()
      .then((payload) => {
        if (generation.current !== current) return;
        const items = privacyCollection(payload, "watches") ?? [];
        setWatches(items.map(installedWatchDocument).filter((watch) => watch !== null));
        setError(null);
      })
      .catch((err) => {
        if (generation.current !== current) return;
        if (err?.status === 404) setWatches([]);
        else setError(errorMessage(err));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, []);

  return { watches, loading, error };
}

function WatchesDashboard() {
  const installed = useInstalledWatches();
  const approvalPage = useCursorPage({
    resetKey: "pending-watch-approvals",
    pageSize: 50,
    loadPage: async ({ limit, cursor }) => {
      try {
        return await listSubscriptionApprovals({ status: "pending", limit, cursor });
      } catch (error) {
        if (error?.status === 404) {
          return { approvals: [], nextCursor: null, totalCount: 0 };
        }
        throw error;
      }
    },
    selectItems: (payload) => privacyCollection(payload, "approvals") ?? [],
    selectMeta: (payload) => ({
      totalCount: Number.isFinite(payload?.totalCount) ? payload.totalCount : null,
    }),
  });

  return html`
    <div class="privacy-view">
      <header class="privacy-page-header">
        <div>
          <h1>Watches</h1>
          <span class="experimental-tag">Experimental</span>
        </div>
      </header>
      ${approvalPage.error
        ? html`<div class="privacy-banner error" role="alert">Failed to load watch requests: ${errorMessage(approvalPage.error)}</div>`
        : null}
      ${installed.error
        ? html`<div class="privacy-banner error" role="alert">Failed to load watches: ${installed.error}</div>`
        : null}
      ${approvalPage.loading || installed.loading
        ? html`<${Loading} label="Loading watches…" />`
        : html`<div class="watch-list">
            <${SubscriptionApprovalList} approvals=${approvalPage.items} />
            <${LoadMore}
              hasMore=${approvalPage.hasMore}
              loading=${approvalPage.loadingMore}
              error=${approvalPage.loadMoreError}
              onLoadMore=${approvalPage.loadMore}
              label="Load more watch requests"
            />
            ${installed.error
              ? null
              : html`<${InstalledWatchList} watches=${installed.watches} />`}
          </div>`}
    </div>
  `;
}

/**
 * What a `/portal/watches/<id>` id resolves to.
 *
 * Ids of two shapes reach this route. A watch id is answered by the runtime,
 * and its answer is the record the screen renders, so the question that decides
 * the shape is also the read that draws it.
 *
 * A subscription id is a link into the old two-page world — a bookmark, an
 * approval notification, a firing row. It names the record that authorised a
 * watch, and provenance runs both ways, so it resolves to the watch that record
 * is about and the route sends the reader there. There is one page per watch
 * and this is how every old address finds it.
 *
 * A record whose plan is not a watch has nowhere to send anyone. That is a
 * record written by a build that predates watches, and saying so plainly beats
 * a page describing half of something.
 */
export async function resolveWatchDetail(watchId) {
  try {
    const watch = installedWatchDocument(await getWatchV2Watch(watchId));
    if (watch) return { kind: "installed", watch };
  } catch {
    // Not the runtime's, or a runtime that could not say. Either way the
    // subscription store is the other place this id can live.
  }
  try {
    const subscription = await getPrivacySubscription(watchId);
    const owner = subscription?.subscription?.watchId ?? subscription?.watchId;
    if (typeof owner === "string" && owner.length > 0) return { kind: "owned-by", watchId: owner };
  } catch {
    // Neither store claims it.
  }
  return { kind: "unknown" };
}

function WatchDetailRoute({ watchId }) {
  // `null` while neither store has been asked yet.
  const [resolved, setResolved] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setResolved(null);
    resolveWatchDetail(watchId).then((detail) => {
      if (generation.current === current) setResolved(detail);
    });
    return () => {
      if (generation.current === current) generation.current += 1;
    };
  }, [watchId]);

  if (resolved === null) {
    return html`<div class="privacy-view">
      <a class="doc-back" href="/portal/watches" onClick=${(event) => {
        event.preventDefault();
        navigate("/portal/watches");
      }}>← Watches</a>
      <${Loading} label="Loading watch…" />
    </div>`;
  }
  if (resolved.kind === "installed") {
    return html`<${InstalledWatchRoute} watch=${resolved.watch} />`;
  }
  if (resolved.kind === "owned-by") {
    return html`<${WatchRedirect} watchId=${resolved.watchId} />`;
  }
  return html`<div class="privacy-view">
    <a class="doc-back" href="/portal/watches" onClick=${(event) => {
      event.preventDefault();
      navigate("/portal/watches");
    }}>← Watches</a>
    <div class="privacy-empty-state">
      <strong>No watch here</strong>
      <span>Nothing on this install answers to that id.</span>
    </div>
  </div>`;
}

/**
 * Send a subscription address to the watch it is about.
 *
 * Replaces rather than pushes: the old address is not a place, so a reader who
 * goes back should land where they came from rather than bounce through here
 * again.
 */
function WatchRedirect({ watchId }) {
  useEffect(() => {
    replaceRoute(`/portal/watches/${encodeURIComponent(watchId)}`);
  }, [watchId]);
  return html`<div class="privacy-view"><${Loading} label="Opening the watch…" /></div>`;
}

export function WatchesView({ watchApprovalId = null, watchId = null, watchFiringId = null }) {
  if (watchApprovalId) {
    return html`<${SubscriptionApprovalRoute} key=${watchApprovalId} approvalId=${watchApprovalId} />`;
  }
  if (watchId && watchFiringId) {
    return html`<${PrivacySubscriptionFiringRoute}
      key=${`${watchId}:${watchFiringId}`}
      subscriptionId=${watchId}
      firingId=${watchFiringId}
    />`;
  }
  if (watchId) {
    return html`<${WatchDetailRoute} key=${watchId} watchId=${watchId} />`;
  }
  return html`<${WatchesDashboard} />`;
}
