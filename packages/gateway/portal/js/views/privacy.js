// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Audit — what external agents asked of Omnesis, and what left this machine.
 *
 * Two tabs over one record. Answer holds the privacy-reviewed releases
 * (including anything waiting on a decision); Direct holds the raw,
 * unreviewed reads. The rules that govern a release — who may ask, over
 * what, under which policy — are configuration and live on Settings →
 * Access; this page is the record of what those rules actually did.
 *
 * The surfaces themselves live in `./privacy/`; this file only routes between
 * the feed, the two details that open on their own, and the Direct tab.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import { getPrivacyReviewerHealth } from "../api.js";
import { TabBar } from "../components/tab-bar.js";
import { replaceRoute } from "../lib/router.js";
import { PrivacyActivityPane, PrivacyApprovalRoute } from "./audit/activity.js";
import { DirectAuditPane, DirectSessionDetailRoute } from "./audit/direct.js";
import { PrivacyExchangeDetailRoute } from "./audit/exchange-detail.js";
import { PrivacyHealthBanner } from "./audit/shared.js";

function AuditDashboard({ directTab }) {
  const [reviewerHealth, setReviewerHealth] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPrivacyReviewerHealth()
      .then((health) => {
        if (!cancelled) setReviewerHealth(health);
      })
      .catch(() => {
        // The aggregate is advisory. Individual answers still fail closed.
      });
    return () => { cancelled = true; };
  }, []);

  // The tab is route state, not local state, so a refresh or bookmark lands
  // where the operator left off. Toggles replace the URL (matching Settings)
  // while drilling into a session pushes, so Browser Back walks back up.
  const tab = directTab ? "direct" : "answer";
  const switchTab = (next) => {
    if (next === tab) return;
    replaceRoute(next === "direct" ? "/portal/audit/direct" : "/portal/audit");
  };

  return html`
    <div class="privacy-view">
      <header class="privacy-page-header">
        <div><h1>Audit</h1></div>
        <p class="privacy-page-lede">
          What agents asked of Omnesis, and what left this machine.
        </p>
      </header>
      <${PrivacyHealthBanner} health=${reviewerHealth} />
      <${TabBar}
        tabs=${[
          { key: "answer", label: "Answer" },
          { key: "direct", label: "Direct" },
        ]}
        active=${tab}
        onSelect=${switchTab}
      />
      ${tab === "answer"
        ? html`<${PrivacyActivityPane} />`
        : html`<${DirectAuditPane} />`}
    </div>
  `;
}

export function PrivacyView({
  approvalId = null,
  conversationId = null,
  taskId = null,
  directTab = false,
  directSessionId = null,
}) {
  if (approvalId) return html`<${PrivacyApprovalRoute} key=${approvalId} approvalId=${approvalId} />`;
  if (conversationId) {
    return html`<${PrivacyExchangeDetailRoute}
      key=${`${conversationId}:${taskId ?? "all"}`}
      conversationId=${conversationId}
      taskId=${taskId}
    />`;
  }
  if (directSessionId) {
    return html`<${DirectSessionDetailRoute} key=${directSessionId} sessionId=${directSessionId} />`;
  }
  return html`<${AuditDashboard} directTab=${directTab} />`;
}
