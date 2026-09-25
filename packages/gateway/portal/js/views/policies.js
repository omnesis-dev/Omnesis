// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Policies is the Settings tab listing the privacy policies an access level can
// name, and the page one opens on for editing. A policy decides what may leave
// this machine in a reviewed answer; the access levels naming it are managed on
// the neighbouring Access tab, which links back here from each level's terms.
//
// This file owns the route dispatcher (`PoliciesView`) and the access overview
// the list reads its connection counts from. The list and the editor page live in
// `./policies/policy-library.js`; the editor pane itself in `./policies/policy.js`.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { getAccessOverview } from "../api.js";
import { policyFamilyId, policyFamilyName } from "../components/grant-builder-state.js";
import { replaceRoute } from "../lib/router.js";
import { errorMessage, overviewPolicies } from "./access/shared.js";
import { PolicyEditorPage, PolicyLibrary } from "./policies/policy-library.js";

const EMPTY_OVERVIEW = { principals: [], oauth: null };

export function PoliciesView({ policyId = null } = {}) {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [overviewReady, setOverviewReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const headingRef = useRef(null);
  const editorHeadingRef = useRef(null);
  const previousPolicyRef = useRef(policyId);

  async function refresh() {
    try {
      setOverview(await getAccessOverview());
      setOverviewReady(true);
      setError("");
    } catch (failure) {
      setOverviewReady(false);
      setError(errorMessage(failure, "The policies could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    // The editor saves, forks and creates without telling this page, so
    // coming back from it re-reads what the list shows and lands focus on
    // the heading.
    if (!policyId && previousPolicyRef.current) {
      refresh();
      headingRef.current?.focus();
    }
    previousPolicyRef.current = policyId;
  }, [policyId]);

  if (policyId) {
    const openPolicy = overviewPolicies(overview).find((policy) => policyFamilyId(policy) === policyId);
    return html`<div class="access-view">
      <${PolicyEditorPage}
        key=${policyId}
        policyId=${policyId}
        policyName=${openPolicy ? policyFamilyName(openPolicy) : null}
        onClose=${() => replaceRoute("/portal/settings/policies")}
        headingRef=${editorHeadingRef}
      />
    </div>`;
  }

  return html`<div class="access-view">
    ${error && html`<p class="access-error" role="alert">${error}</p>`}
    <${PolicyLibrary}
      overview=${overview}
      overviewReady=${overviewReady}
      loading=${loading}
      headingRef=${headingRef}
    />
  </div>`;
}
