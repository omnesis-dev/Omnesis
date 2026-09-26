// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The privacy policies an access level can name, and the page one opens on.
//
// A policy decides what may leave this machine in an answer. The library is
// the Policies tab of Settings, and each policy opens at its own address the
// way an access level does on the Access tab.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { createPrivacyPolicy, deleteNamedPrivacyPolicy, getPrivacyPolicyTemplates, renameNamedPrivacyPolicy } from "../../api.js";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { Modal } from "../../components/modal.js";
import { policyFamilyId, policyFamilyName } from "../../components/grant-builder-state.js";
import { policyEditorPath } from "../../lib/policy-path.js";
import { navigate } from "../../lib/router.js";
import { rowActivateHandler } from "../../lib/table-row-click.js";
import { ForkPolicyButton, PrivacyPolicyPane, affectedPolicyAccess } from "./policy.js";

// A policy revision is a content hash. Only its head distinguishes one from
// another at a glance, so the row shows that and keeps the full value in the
// title for anyone matching it against a stored revision.
export function shortRevision(revision) {
  return revision.length > 12 ? `${revision.slice(0, 12)}…` : revision;
}

/**
 * One privacy policy, open for editing on its own page.
 *
 * The editor is the pane the library links to, so the page is only chrome: a
 * way back to the list, and a heading — named after the policy where the
 * library knows its name — for focus to land on.
 */
export function PolicyEditorPage({ policyId, policyName = null, onClose, headingRef }) {
  useEffect(() => { headingRef?.current?.focus(); }, []);

  return html`<div class="access-editor-page">
    <header class="access-page-header">
      <button type="button" class="doc-back access-page-back" onClick=${onClose}>← Back to policies</button>
      <div class="access-page-title">
        <div>
          <span class="access-eyebrow">Privacy policy</span>
          <h2 ref=${headingRef} tabIndex="-1">${policyName ? `Edit ${policyName}` : "Edit policy"}</h2>
        </div>
        <${ForkPolicyButton} policyId=${policyId} policyName=${policyName} />
      </div>
    </header>
    <${PrivacyPolicyPane} policyId=${policyId} />
  </div>`;
}

/**
 * The list of policies, under the tab's heading.
 *
 * Each row says how many connections and integrations a policy reviews, because
 * that is the blast radius of editing it. The count is read off the access overview — the
 * same levels and connections the editor's confirmation lists — so the two
 * never disagree. The row of the gateway's default policy — the one a new
 * access level starts under — says so.
 *
 * `headingRef` is the tab's heading, for focus to land on when the editor
 * page closes.
 */
export function PolicyLibrary({ overview, overviewReady, loading, headingRef = null, onRefresh }) {
  const [renaming, setRenaming] = useState(null);
  const [renameName, setRenameName] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState("");
  const renamePending = useRef(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deletePending = useRef(false);
  const [deleteError, setDeleteError] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [templates, setTemplates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Templates are only needed once the dialog opens, and are kept for the
  // life of the library so reopening it does not ask again.
  useEffect(() => {
    if (!creating || templates.length) return;
    getPrivacyPolicyTemplates()
      .then((result) => setTemplates(result?.templates ?? []))
      .catch(() => setError("The starting templates could not be loaded. Close this dialog and try again."));
  }, [creating]);

  function open() {
    setError("");
    setCreating(true);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createPrivacyPolicy({ name: trimmed, templateId });
      const familyId = created.family?.id ?? created.familyId ?? created.id;
      if (!familyId) throw new Error("The policy was created but could not be opened.");
      navigate(policyEditorPath(familyId));
    } catch (failure) {
      // The gateway's own sentence when it has one; never the raw request line.
      setError(failure?.serverMessage || "This policy could not be created.");
    } finally {
      setBusy(false);
    }
  }

  const trimmedRenameName = renameName.trim();
  const renameValid = Boolean(renaming && trimmedRenameName && trimmedRenameName.length <= 120
    && trimmedRenameName !== policyFamilyName(renaming));

  async function rename() {
    if (!renameValid || renamePending.current) return;
    renamePending.current = true;
    setRenameBusy(true);
    setRenameError("");
    try {
      await renameNamedPrivacyPolicy(policyFamilyId(renaming), trimmedRenameName);
      setRenaming(null);
      await onRefresh?.();
    } catch (failure) {
      setRenameError(failure?.serverMessage || "This policy could not be renamed.");
    } finally {
      renamePending.current = false;
      setRenameBusy(false);
    }
  }

  async function remove() {
    if (!deleting || deletePending.current) return;
    deletePending.current = true;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteNamedPrivacyPolicy(policyFamilyId(deleting));
      setDeleting(null);
      await onRefresh?.();
    } catch (failure) {
      setDeleting(null);
      setDeleteError(failure?.serverMessage || "This policy could not be deleted.");
      await onRefresh?.();
    } finally {
      deletePending.current = false;
      setDeleteBusy(false);
    }
  }

  const policies = overview.policyFamilies ?? overview.privacyPolicies ?? [];

  return html`
    <section class="access-policies">
      ${deleteError && html`<p class="access-error" role="alert">${deleteError}</p>`}
      <div class="access-list-header">
        <div>
          <h2 ref=${headingRef} tabIndex="-1">Policies</h2>
          <p>An access level that releases reviewed answers names one of these. It decides what may leave this machine.</p>
        </div>
        <button type="button" class="btn-secondary" disabled=${!overviewReady} onClick=${open}>New policy</button>
      </div>
      ${loading
        ? html`<p class="loading">Loading policies…</p>`
        : !overviewReady
          // The page-level error above already says the overview did not
          // load. Claiming here that no policy exists would be a falsehood
          // about a safety control.
          ? null
          : policies.length
            ? html`<div class="portal-table-wrap">
                <table class="portal-table access-policy-table">
                  <thead>
                    <tr>
                      <th>Policy</th>
                      <th>Revision</th>
                      <th class="portal-table-num" title="Live connections whose answers are reviewed under this policy — the blast radius of editing it">Connections</th>
                      <th class="portal-table-num" title="Integrations on access levels reviewed under this policy">Integrations</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${policies.map((policy) => {
                      const id = policyFamilyId(policy);
                      const revision = policy.revision ?? policy.currentRevision ?? null;
                      const affected = affectedPolicyAccess(overview, id);
                      const governed = affected.connectionCount;
                      const deletionReason = policy.deletionBlockedReason
                        ?? (id === overview.defaultPolicyFamilyId ? "The default policy cannot be deleted."
                          : affected.levels.length || affected.connectionCount || affected.deviceCount
                            ? "This policy is used by access levels, connections or integrations. Reassign them before deleting it."
                            : !Object.hasOwn(policy, "deletionBlockedReason")
                              ? "Policy usage could not be verified. Refresh before deleting it." : "");
                      const isDefault = id === overview.defaultPolicyFamilyId;
                      const openPolicy = () => navigate(policyEditorPath(id));
                      // A row whose policy has no id has nowhere to go, so it
                      // stays inert rather than advertising a click that would
                      // navigate to the bare policies path.
                      const openFromCell = id ? rowActivateHandler(openPolicy) : undefined;
                      return html`<tr key=${id} class=${id ? "access-policy-row" : ""}>
                        <td onClick=${openFromCell}>
                          <span class="access-policy-name-line">
                            <a
                              class="portal-table-name"
                              href=${policyEditorPath(id)}
                              onClick=${(event) => {
                                // A modified click belongs to the browser: let it
                                // open the policy in a new tab or window.
                                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                                event.preventDefault();
                                openPolicy();
                              }}
                            >${policyFamilyName(policy)}</a>
                            ${isDefault
                              ? html`<span class="portal-pill portal-pill-accent"
                                  title="A new access level starts under this policy">Default</span>`
                              : null}
                          </span>
                        </td>
                        <td onClick=${openFromCell}><small title=${revision ?? undefined}
                          >${revision ? shortRevision(revision) : "None yet"}</small></td>
                        <td class="portal-table-num" onClick=${openFromCell}>${governed}</td>
                        <td class="portal-table-num" onClick=${openFromCell}>${affected.deviceCount}</td>
                        <td><div class="access-policy-actions"><button type="button" class="btn-secondary" aria-label=${`Rename ${policyFamilyName(policy)}`}
                          disabled=${!id || deleteBusy || renameBusy}
                          onClick=${() => { setRenameName(policyFamilyName(policy)); setRenameError(""); setRenaming(policy); }}>Rename</button>
                          <span title=${deletionReason || "Delete this unused policy"} aria-label=${deletionReason || undefined} tabindex=${deletionReason ? "0" : undefined}>
                          <button type="button" class="btn-secondary" aria-label=${`Delete ${policyFamilyName(policy)}`}
                            title=${deletionReason || "Delete this unused policy"}
                            disabled=${!id || Boolean(deletionReason) || deleteBusy || renameBusy}
                            onClick=${() => { setDeleteError(""); setDeleting(policy); }}>Delete</button>
                        </span></div></td>
                      </tr>`;
                    })}
                  </tbody>
                </table>
              </div>`
            : html`<p class="access-policy-empty">
                No privacy policy exists yet. An access level cannot release reviewed answers until one does.
              </p>`}

      <${Modal} open=${Boolean(renaming)} title="Rename policy" size="sm"
        onClose=${renameBusy ? () => {} : () => setRenaming(null)}>
        <form class="privacy-policy-create" onSubmit=${(event) => { event.preventDefault(); rename(); }}>
          <label class="form-group"><span>Name</span><input maxlength="120" value=${renameName}
            disabled=${renameBusy} onInput=${(event) => setRenameName(event.currentTarget.value)} /></label>
          <p>Renaming keeps this policy's rules, history and access assignments.</p>
          ${renameError && html`<p class="access-error" role="alert">${renameError}</p>`}
          <div class="access-request-actions">
            <button type="button" class="btn-secondary" disabled=${renameBusy} onClick=${() => setRenaming(null)}>Cancel</button>
            <button type="submit" class="btn-primary" disabled=${renameBusy || !renameValid}>${renameBusy ? "Renaming…" : "Save name"}</button>
          </div>
        </form>
      </${Modal}>
      <${ConfirmModal}
        open=${Boolean(deleting)}
        title=${`Delete ${deleting ? policyFamilyName(deleting) : "policy"}?`}
        body="This removes the policy from the library. Version history and existing audit records are retained."
        confirmLabel=${deleteBusy ? "Deleting…" : "Delete policy"}
        destructive
        confirmDisabled=${deleteBusy}
        cancelDisabled=${deleteBusy}
        onConfirm=${remove}
        onCancel=${() => setDeleting(null)}
      />
      <${Modal} open=${creating} title="Create policy" size="sm" onClose=${busy ? () => {} : () => setCreating(false)}>
        <div class="privacy-policy-create">
          <label class="form-group"><span>Name</span><input maxlength="120" value=${name}
            onInput=${(event) => setName(event.currentTarget.value)} /></label>
          <label class="form-group"><span>Starting template</span><select value=${templateId}
            onChange=${(event) => setTemplateId(event.currentTarget.value)}>
            <option value="">Choose a template</option>
            ${templates.map((template) => html`<option value=${template.id} key=${template.id}>Template — ${template.name}</option>`)}
          </select></label>
          <p>Creating a policy starts a new family. Later restores append a new version; they never rewrite history.</p>
          ${error && html`<p class="access-error" role="alert">${error}</p>`}
          <div class="access-request-actions">
            <button type="button" class="btn-secondary" disabled=${busy} onClick=${() => setCreating(false)}>Cancel</button>
            <button type="button" class="btn-primary" disabled=${busy || !name.trim() || !templateId} onClick=${create}>${busy ? "Creating…" : "Create policy"}</button>
          </div>
        </div>
      </${Modal}>
    </section>
  `;
}
