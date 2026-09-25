// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Fragment } from "preact";
import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  forkPrivacyPolicy,
  getAccessOverview,
  getNamedPrivacyPolicy,
  getNamedPrivacyPolicyHistory,
  getNamedPrivacyPolicyVersion,
  restoreNamedPrivacyPolicy,
  updateNamedPrivacyPolicy,
} from "../../api.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { Modal } from "../../components/modal.js";
import { LoadMore } from "../../components/load-more.js";
import { Loading } from "../../components/loading.js";
import { TextEditor } from "../../lib/json-editor.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { navigate } from "../../lib/router.js";
import { errorMessage } from "../shared/privacy-vocabulary.js";
import { policyDiffPage } from "./policy-diff.js";
import { DEFAULT_POLICY_FAMILY_ID, normalizeGrantRules } from "../../components/grant-builder-state.js";
import { accessLevels, connectionEntries, levelDevices } from "../access/shared.js";

/**
 * The gateway serves a policy either bare or wrapped in the family it belongs
 * to; both spellings reach here, so read whichever one carries the text.
 */
export function privacyPolicyDocument(payload) {
  if (typeof payload?.policy === "string" && typeof payload?.revision === "string") return payload;
  if (typeof payload?.policy?.policy === "string") return payload.policy;
  return null;
}

const MAX_POLICY_CHARS = 64_000;
const POLICY_DRAFT_KEY = "omnesis:privacy-policy-draft";

function namedPolicyDocument(payload) {
  return privacyPolicyDocument(payload) ??
    privacyPolicyDocument(payload?.family?.current ?? payload?.current);
}

function summaryForDocument(document, fallbackName) {
  return {
    id: document.familyId,
    name: document.familyName ?? fallbackName,
    currentRevision: document.revision,
    currentVersion: document.familyVersion ?? document.generation,
  };
}

/**
 * The access a policy reviews: the access levels whose Answer is reviewed
 * under it, each with the live connections using it, and the live connections
 * no listed level accounts for whose own Answer is, and the integrations on
 * those levels. `connectionCount` and `deviceCount` together are the blast
 * radius of editing the policy.
 */
export function affectedPolicyAccess(overview, familyId, now = Date.now()) {
  const reviewsUnder = (subject) => {
    const rules = normalizeGrantRules(
      subject.rules ?? subject.capabilities,
      overview?.defaultPolicyFamilyId ?? DEFAULT_POLICY_FAMILY_ID,
    );
    return rules.answer?.release.mode === "reviewed" && rules.answer.release.policyFamilyId === familyId;
  };
  const live = connectionEntries(overview ?? {})
    .filter((entry) => !(entry.grant.expiresAt != null && entry.grant.expiresAt <= now));
  const levels = accessLevels(overview ?? {});
  const known = new Set(levels.map((level) => level.id));
  const affectedLevels = levels.filter(reviewsUnder).map((level) => ({
    id: level.id,
    name: level.name,
    connections: live
      .filter((entry) => entry.levelId === level.id)
      .map((entry) => ({ id: entry.id, name: entry.name })),
    devices: levelDevices(level),
  }));
  const connections = live
    .filter((entry) => !(entry.levelId && known.has(entry.levelId)) && reviewsUnder(entry.grant))
    .map((entry) => ({ id: entry.id, name: entry.name }));
  return {
    levels: affectedLevels,
    connections,
    connectionCount: affectedLevels.reduce((count, level) => count + level.connections.length, 0) + connections.length,
    deviceCount: affectedLevels.reduce((count, level) => count + level.devices.length, 0),
  };
}

function AffectedPolicyAccess({ overview, familyId, loading }) {
  if (loading) {
    return html`<section class="privacy-policy-affected" aria-label="Affected access" aria-live="polite">
      <h3>Affected access</h3><p>Checking current access…</p>
    </section>`;
  }
  if (!overview) {
    return html`<section class="privacy-policy-affected" aria-label="Affected access" aria-live="polite">
      <h3>Affected access</h3><p>Current access could not be loaded. Close this dialog and try again.</p>
    </section>`;
  }
  const affected = affectedPolicyAccess(overview, familyId);
  return html`<section class="privacy-policy-affected" aria-label="Affected access" aria-live="polite">
    <h3>Affected access</h3>
    ${affected.levels.length === 0 && affected.connections.length === 0
      ? html`<p>No access levels or connections currently use this policy.</p>`
      : html`<p>Saving this version immediately changes privacy review for:</p>
        <ul>
          ${affected.levels.map((level) => html`<li key=${`level-${level.id}`}>
            <strong>${level.name}</strong>
            <span>${level.connections.length + level.devices.length > 0
              ? `Access level · ${[...level.connections, ...level.devices].map((user) => user.name).join(", ")}`
              : "Access level · No connections"}</span>
          </li>`)}
          ${affected.connections.map((connection) => html`<li key=${`connection-${connection.id}`}>
            <strong>${connection.name}</strong>
            <span>Connection</span>
          </li>`)}
        </ul>`}
  </section>`;
}

function DiffText({ row }) {
  if (!row.spans) return row.text || " ";
  return row.spans
    .filter((span) => span.kind === "same" || span.kind === row.kind)
    .map((span, index) => span.kind === "same"
      ? span.value
      : html`<span key=${index} class=${`privacy-diff-char privacy-diff-char--${row.kind}`}>
          ${span.value}
        </span>`);
}

export function PrivacyPolicyDiff({ before, after, page = 0, onPage = () => {}, label = "Privacy policy changes" }) {
  const diff = policyDiffPage(before, after, page);
  return html`<div>
    <div class="privacy-policy-diff" role="table" aria-label=${label}>
    ${diff.rows.map((row, index) => row.kind === "omitted"
      ? html`<div key=${index} class="privacy-policy-diff-omitted" role="row">
          <span role="cell">${row.count.toLocaleString()} unchanged lines collapsed.</span>
        </div>`
      : html`<div
      key=${index}
      class=${`privacy-policy-diff-row privacy-policy-diff-row--${row.kind}`}
      role="row"
    >
      <span role="cell" class="privacy-diff-line" aria-label=${row.oldLine ? `Old line ${row.oldLine}` : ""}>
        ${row.oldLine ?? ""}
      </span>
      <span role="cell" class="privacy-diff-line" aria-label=${row.newLine ? `New line ${row.newLine}` : ""}>
        ${row.newLine ?? ""}
      </span>
      <span role="cell" class="privacy-diff-marker" aria-hidden="true">
        ${row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
      </span>
      <span role="cell" class="sr-only">${row.kind === "add" ? "Added" : row.kind === "remove" ? "Removed" : "Unchanged"}</span>
      <code role="cell"><${DiffText} row=${row} /></code>
    </div>`)}
    </div>
    ${diff.totalPages > 1 ? html`<nav class="privacy-diff-pagination" aria-label="Diff pages">
      <button type="button" class="btn-secondary" disabled=${diff.page === 0}
        onClick=${() => onPage(Math.max(0, diff.page - 1))}>Previous changes</button>
      <span>Page ${(diff.page + 1).toLocaleString()} of ${diff.totalPages.toLocaleString()}</span>
      <button type="button" class="btn-secondary" disabled=${diff.page + 1 >= diff.totalPages}
        onClick=${() => onPage(Math.min(diff.totalPages - 1, diff.page + 1))}>Next changes</button>
    </nav>` : null}
  </div>`;
}

export function restorePolicyDraft(serialized, current) {
  if (!serialized) return { draft: current.policy, stale: false };
  try {
    const saved = JSON.parse(serialized);
    if (typeof saved?.draft !== "string") throw new Error("invalid draft");
    return { draft: saved.draft, stale: saved.baseRevision !== current.revision };
  } catch {
    // A draft stored as bare text has no base revision to compare against,
    // so it is kept but flagged for review rather than trusted.
    return { draft: serialized, stale: true };
  }
}

export function serializePolicyDraft(draft, policy) {
  return JSON.stringify({ draft, baseRevision: policy.revision, basePolicy: policy.policy });
}

function formatHistoryTime(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleString();
}

function historyVersion(version) {
  return version?.familyVersion ?? version?.version ?? version?.generation;
}

const HISTORY_ACTION = {
  bootstrap: "Initial version",
  edit: "Edited",
  revert: "Restored an earlier version",
  restore: "Restored an earlier version",
  fork: "Forked from another policy",
  template: "Created from a template",
};

export function PrivacyPolicyHistory({
  currentGeneration,
  familyId,
  refreshKey,
  saving,
  onRevert,
}) {
  const [versions, setVersions] = useState([]);
  const [pageInfo, setPageInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadGeneration = useRef(0);

  async function load(beforeGeneration, append) {
    const generation = ++loadGeneration.current;
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const payload = await getNamedPrivacyPolicyHistory(familyId, {
        limit: 25,
        beforeVersion: beforeGeneration,
      });
      if (generation !== loadGeneration.current) return;
      setVersions((existing) => append ? [...existing, ...(payload.versions ?? [])] : payload.versions ?? []);
      setPageInfo(payload.pageInfo ?? null);
    } catch (loadError) {
      if (generation !== loadGeneration.current) return;
      setError(loadError);
    } finally {
      if (generation !== loadGeneration.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => { load(undefined, false); }, [refreshKey]);

  async function inspect(version) {
    setDetailLoading(true);
    setError(null);
    try {
      const number = version.familyVersion ?? version.version ?? version.generation;
      const payload = await getNamedPrivacyPolicyVersion(familyId, number);
      setSelected(payload.version ?? null);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setDetailLoading(false);
    }
  }

  return html`<section class="privacy-section privacy-policy-history">
    <header class="privacy-section-head">
      <h3>Version history</h3>
    </header>
    ${error ? html`<div class="privacy-banner error" role="alert">${errorMessage(error)}</div>` : null}
    ${loading
      ? html`<${Loading} label="Loading history…" />`
      : !versions.length
        // A header row over an empty body would assert a structure with no
        // data under it — which is what a failed load leaves behind.
        ? html`<p class="privacy-empty">${error ? "No versions could be read." : "No versions yet."}</p>`
        : html`<div class="portal-table-wrap">
          <table class="portal-table privacy-history-table">
            <thead>
              <tr>
                <th class="portal-table-num">Version</th>
                <th>Change</th>
                <th>Saved</th>
                <th class="portal-table-actions-col"></th>
              </tr>
            </thead>
            <tbody>
              ${versions.map((version) => {
                const number = historyVersion(version);
                const current = number === currentGeneration;
                const restored = version.restoredFromVersion ?? version.revertedFromGeneration;
                return html`<tr key=${number}>
                  <td class="portal-table-num">${number}</td>
                  <td>
                    <span class="privacy-history-change">
                      <strong>${HISTORY_ACTION[version.action] ?? "Policy changed"}</strong>
                      ${current ? html`<span class="portal-pill portal-pill-accent">Current</span>` : null}
                      ${restored ? html`<small>Restored version ${restored}</small>` : null}
                    </span>
                  </td>
                  <td>${formatHistoryTime(version.createdAt)}</td>
                  <td class="portal-table-actions-col">
                    ${current
                      ? null
                      : html`<button
                          type="button"
                          class="btn-secondary btn-icon privacy-history-view"
                          aria-label=${`View version ${number}`}
                          title=${`View version ${number}`}
                          aria-busy=${detailLoading ? "true" : undefined}
                          disabled=${saving || detailLoading}
                          onClick=${() => inspect(version)}
                        ><${SearchIcon} /></button>`}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`}
    <${LoadMore}
      hasMore=${Boolean(pageInfo?.hasMore)}
      loading=${loadingMore}
      error=${null}
      onLoadMore=${() => load(pageInfo?.nextBeforeVersion ?? pageInfo?.nextBeforeGeneration, true)}
      label="Load older versions"
    />
    <${ConfirmModal}
      open=${Boolean(selected)}
      title=${`Policy version ${historyVersion(selected) ?? ""}`}
      body=${html`<div>
        <p>${HISTORY_ACTION[selected?.action] ?? "Policy changed"} ${formatHistoryTime(selected?.createdAt)}</p>
        <div class="privacy-history-preview doc-content"
          dangerouslySetInnerHTML=${{ __html: renderMarkdown(selected?.policy ?? "") }}
        ></div>
      </div>`}
      confirmLabel="Restore as new version"
      onConfirm=${() => { const version = selected; setSelected(null); if (version) onRevert(version); }}
      onCancel=${() => setSelected(null)}
    />
  </section>`;
}

/** Lucide `search` (https://lucide.dev/icons/search), inlined like the portal's other glyphs. */
function SearchIcon() {
  return html`<svg
    class="lucide-icon"
    viewBox="0 0 24 24"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  ><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>`;
}

/**
 * "Fork policy" and its dialog. A fork is a new family with this policy's
 * current version as its origin; on success the fork opens, since the origin
 * is not what the reader then wants on screen. Self-contained so the page
 * header can carry it beside the title, independent of the editor's state.
 */
export function ForkPolicyButton({ policyId, policyName = null }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function fork() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await forkPrivacyPolicy(policyId, { name: trimmed });
      const family = created.family?.id
        ? created.family
        : summaryForDocument(namedPolicyDocument(created) ?? {}, trimmed);
      const nextId = family.id ?? family.familyId;
      if (!nextId) throw new Error("Forked policy response was incomplete.");
      setOpen(false);
      setName("");
      navigate(`/portal/settings/policies/${encodeURIComponent(nextId)}`);
    } catch (forkError) {
      setError(forkError);
    } finally {
      setBusy(false);
    }
  }

  return html`<${Fragment}>
    <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => {
      setName(`${policyName ?? "Policy"} copy`);
      setError(null);
      setOpen(true);
    }}>Fork policy</button>
    <${Modal} open=${open} title="Fork policy" size="sm" onClose=${busy ? () => {} : () => setOpen(false)}>
      <div class="privacy-policy-create">
        ${error ? html`<div class="privacy-banner error" role="alert">${errorMessage(error)}</div>` : null}
        <label class="form-group"><span>New family name</span><input maxlength="120" value=${name}
          onInput=${(event) => setName(event.currentTarget.value)} /></label>
        <p>The new family records this policy version as its origin and evolves independently.</p>
        <div class="access-request-actions"><button type="button" class="btn-secondary" disabled=${busy} onClick=${() => setOpen(false)}>Cancel</button><button type="button" class="btn-primary" disabled=${busy || !name.trim()} onClick=${fork}>${busy ? "Forking…" : "Fork policy"}</button></div>
      </div>
    </${Modal}>
  </${Fragment}>`;
}

/**
 * One privacy policy family, open for editing.
 *
 * `policyId` names the family; every read and write here is scoped to it, so a
 * link into a policy lands on that policy and a save cannot reach another.
 */
export function PrivacyPolicyPane({ policyId }) {
  const [policy, setPolicy] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const [accessOverview, setAccessOverview] = useState(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [diffPage, setDiffPage] = useState(0);
  const [pendingRevert, setPendingRevert] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const draftKey = `${POLICY_DRAFT_KEY}:${policyId}`;
  const dirty = Boolean(policy && draft !== policy.policy);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getNamedPrivacyPolicy(policyId)]).then(([policyResult]) => {
      if (cancelled) return;
      if (policyResult.status === "fulfilled") {
        const document = namedPolicyDocument(policyResult.value);
        if (document) {
          setPolicy(document);
          let savedDraft = null;
          try { savedDraft = sessionStorage.getItem(draftKey); } catch { /* unavailable */ }
          const restored = restorePolicyDraft(savedDraft, document);
          setDraft(restored.draft);
          if (restored.stale) setNotice({
            kind: "warning",
            message: "Your saved draft was based on an older policy. It has been rebased for review against the latest version; review every change before saving or discard it.",
          });
        } else setNotice({ kind: "error", message: "Policy response was incomplete." });
      } else {
        // A bookmark can name a policy the gateway no longer has. Say so in
        // the gateway's words rather than echoing the request line.
        setNotice({
          kind: "error",
          message: `Failed to load policy: ${policyResult.reason?.serverMessage ?? errorMessage(policyResult.reason)}`,
        });
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!policy) return undefined;
    try {
      if (dirty) sessionStorage.setItem(draftKey, serializePolicyDraft(draft, policy));
      else sessionStorage.removeItem(draftKey);
    } catch { /* storage may be disabled */ }
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draft, policy, draftKey]);

  function adopt(next, message) {
    setPolicy(next);
    setDraft(next.policy);
    setConfirmSave(false);
    setPendingRevert(null);
    setHistoryRefresh((value) => value + 1);
    setNotice({ kind: "success", message });
  }

  async function save() {
    if (!policy || saving || !dirty) return;
    setSaving(true);
    setNotice(null);
    try {
      const next = namedPolicyDocument(await updateNamedPrivacyPolicy(policyId, {
        policy: draft,
        beforeVersion: historyVersion(policy),
      }));
      if (!next) throw new Error("Saved policy response was incomplete.");
      adopt(next, "Privacy policy saved.");
    } catch (error) {
      setConfirmSave(false);
      if (error?.status === 409) {
        try {
          const latest = namedPolicyDocument(await getNamedPrivacyPolicy(policyId));
          if (latest) {
            setPolicy(latest);
            setNotice({
              kind: "warning",
              message: "The policy changed elsewhere. The latest version is loaded and your draft is still here; review and save again.",
            });
          } else throw new Error("Policy response was incomplete.");
        } catch {
          setNotice({
            kind: "warning",
            message: "The policy changed elsewhere. Your draft is still here; refresh before saving it.",
          });
        }
      } else setNotice({ kind: "error", message: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  }

  async function reviewAndSave() {
    setDiffPage(0);
    setConfirmSave(true);
    setAccessOverview(null);
    setAccessLoading(true);
    try {
      setAccessOverview(await getAccessOverview());
    } catch {
      setAccessOverview(null);
    } finally {
      setAccessLoading(false);
    }
  }

  async function revert() {
    if (!policy || !pendingRevert || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const version = historyVersion(pendingRevert);
      const next = namedPolicyDocument(
        await restoreNamedPrivacyPolicy(policyId, version, policy.revision),
      );
      if (!next) throw new Error("Restored policy response was incomplete.");
      adopt(next, `Version ${version} restored as a new change.`);
    } catch (error) {
      setPendingRevert(null);
      if (error?.status === 409) {
        const latest = await getNamedPrivacyPolicy(policyId).then(namedPolicyDocument).catch(() => null);
        if (latest) {
          setPolicy(latest);
          setHistoryRefresh((value) => value + 1);
        }
      }
      setNotice({
        kind: error?.status === 409 ? "warning" : "error",
        message: error?.status === 409
          ? "The policy changed before it could be restored. Refresh and try again."
          : errorMessage(error),
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return html`<${Loading} label="Loading policy…" />`;
  if (!policy) return html`<div class="privacy-banner error" role="alert">${notice?.message ?? "Policy unavailable."}</div>`;

  const invalidDraft = !draft.trim() || draft.length > MAX_POLICY_CHARS;

  return html`<div class="privacy-policy-pane">
    ${notice ? html`<div class=${`privacy-banner ${notice.kind}`} role=${notice.kind === "error" ? "alert" : "status"}>
      ${notice.message}
    </div>` : null}

    <section class="privacy-section privacy-policy-editor-section">
      <div class="privacy-policy-label">Policy (Markdown)</div>
      <div id="privacy-policy-editor" class="privacy-policy-code-editor">
        <${TextEditor}
          value=${draft}
          ariaLabel="Privacy policy Markdown"
          wrap
          onChange=${(value) => { setDraft(value); setNotice(null); }}
        />
      </div>
      <div class="privacy-policy-toolbar">
        <span class=${draft.length > MAX_POLICY_CHARS ? "privacy-char-count over" : "privacy-char-count"}>
          ${draft.length.toLocaleString()} / ${MAX_POLICY_CHARS.toLocaleString()}
        </span>
        <span class="privacy-policy-actions">
          <button type="button" class="btn-secondary" disabled=${saving || !dirty}
            onClick=${() => { setDraft(policy.policy); setNotice(null); }}>Discard changes</button>
          <button type="button" class="btn-primary" disabled=${saving || !dirty || invalidDraft}
            onClick=${reviewAndSave}>Review and save</button>
        </span>
      </div>
    </section>

    <${PrivacyPolicyHistory}
      currentGeneration=${policy.familyVersion ?? policy.generation}
      familyId=${policyId}
      refreshKey=${historyRefresh}
      saving=${saving}
      onRevert=${setPendingRevert}
    />

    <${ConfirmModal}
      open=${confirmSave}
      title="Review privacy policy changes"
      body=${html`<div>
        <p>Red lines will be removed. Green lines will be added. Changed characters are emphasized.</p>
        <${PrivacyPolicyDiff} before=${policy.policy} after=${draft} page=${diffPage} onPage=${setDiffPage} />
        <${AffectedPolicyAccess} overview=${accessOverview} familyId=${policyId} loading=${accessLoading} />
      </div>`}
      confirmLabel=${saving ? "Saving…" : "Save policy"}
      confirmDisabled=${saving || accessLoading || !accessOverview}
      cancelDisabled=${saving}
      onConfirm=${save}
      onCancel=${() => setConfirmSave(false)}
    />

    <${ConfirmModal}
      open=${Boolean(pendingRevert)}
      title=${`Restore version ${historyVersion(pendingRevert) ?? ""}?`}
      body=${dirty
        ? "This does not erase newer history, but it will discard your unsaved draft and copy the selected policy into a new current version."
        : "This does not erase newer history. It copies the selected policy into a new current version."}
      confirmLabel=${saving ? "Restoring…" : "Restore as new version"}
      confirmDisabled=${saving}
      cancelDisabled=${saving}
      onConfirm=${revert}
      onCancel=${() => setPendingRevert(null)}
    />
  </div>`;
}
