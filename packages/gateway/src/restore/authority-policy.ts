// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A backup contributes data, never an implicit grant to its devices or integrations. */
export type RestoreTablePolicy =
  | "keep-target"
  | "discard-work"
  | "rebuild-derived"
  | "import-data"
  | "reconcile-devices"
  | "pause-sources"
  | "review-memberships"
  | "pause-data";

// Exact names are intentional: a new table requires a restore authority review.
const groups: Record<
  "keep-target" | "discard-work" | "rebuild-derived" | "import-data",
  readonly string[]
> = {
  "keep-target": [
    "access_audit_events",
    "access_grant_capabilities",
    "access_grants",
    "access_level_capabilities",
    "access_levels",
    "access_principals",
    "answer_approvals",
    "answer_audit_events",
    "answer_audit_payloads",
    "answer_conversation_tombstones",
    "answer_conversations",
    "answer_egress_events",
    "answer_egress_payloads",
    "answer_messages",
    "answer_releases",
    "answer_request_tombstones",
    "answer_workflow_disclosure",
    "answer_workflow_grants",
    "answer_workflows",
    "direct_audit_events",
    "direct_audit_payloads",
    "direct_audit_sessions",
    "lab_features",
    "oauth_access_tokens",
    "oauth_clients",
    "oauth_execution_bindings",
    "oauth_refresh_tokens",
    "pairing_redemption_receipts",
    "principal_credentials",
    "privacy_policy_families",
    "privacy_policy_state",
    "privacy_policy_versions",
    "revoked_device_keys",
    "schema_migrations",
    "sessions",
    "subscription_approvals",
    "subscription_audit_events",
    "subscription_firing_evidence",
    "subscription_firing_outcomes",
    "subscription_firings",
    "subscription_grants",
    "subscription_revisions",
    "subscription_workflow_disclosure",
    "subscriptions",
    "token_identity_labels",
    "tokens",
  ],
  "discard-work": [
    "answer_completion_deliveries",
    "answer_tasks",
    "device_pairings",
    "device_doctor_runs",
    "knowledge_batch_regions",
    "knowledge_batches",
    "knowledge_candidate_decision_work",
    "knowledge_cascade_frontier",
    "knowledge_cascade_jobs",
    "knowledge_conversion_deferrals",
    "knowledge_decision_input_subjects",
    "knowledge_decision_inputs",
    "knowledge_decision_privacy",
    "knowledge_frontier",
    "knowledge_historical_admissions",
    "knowledge_organization_cohorts",
    "knowledge_organization_members",
    "knowledge_organization_targets",
    "knowledge_owner_changes",
    "knowledge_owner_retire_guard",
    "knowledge_owner_withdraw_guard",
    "knowledge_owner_write_guard",
    "knowledge_projection_cleanup",
    "knowledge_work",
    "mobile_permission_health",
    "note_agent_handoffs",
    "notification_deliveries",
    "notifications",
    "oauth_authorization_requests",
    "pending_source_page_observations",
    "pending_source_pages",
    "reauth_reminders",
    "snapshot_absence_cascade_outbox",
    "source_mode_transition_publications",
    "source_mode_transitions",
    "source_stream_cleanups",
    "source_sync_issues",
    "storage_cleanup_jobs",
    "storage_trim_job_cascades",
    "storage_trim_jobs",
    "subscription_deliveries",
    "subscription_firing_answer_authorities",
    "subscription_firing_outcome_authorities",
  ],
  "rebuild-derived": [
    "canonicalization_state",
    "catalog_table_stats",
    "link_reconcile_state",
    "link_stats",
    "link_stats_counters",
    "mutable_list_revisions",
    "near_dup_df",
    "near_dup_df_meta",
    "near_dup_edges",
    "near_dup_inbox",
    "near_dup_lsh_buckets",
    "near_dup_signatures",
    "refresh_meta",
    "source_inventories",
    "source_inventory_documents",
    "source_stats",
    "transcription_vocabulary_document_profiles",
    "transcription_vocabulary_document_terms",
    "transcription_vocabulary_profiles",
    "transcription_vocabulary_refresh_state",
    "transcription_vocabulary_spellings",
    "transcription_vocabulary_state",
    "transcription_vocabulary_terms",
  ],
  "import-data": [
    "agent_messages",
    "cognition_consumption_edges",
    "cognition_coverage",
    "cognition_decisions",
    "cognition_notes",
    "cognition_run_attribution",
    "cognition_spend",
    "cognition_spend_daily",
    "cognition_sweep_tally",
    "cognition_synthesis_admissions",
    "conversation_read_state",
    "date_mention_judgements",
    "dev_annotations",
    "doc_annotation_evidence",
    "doc_annotations",
    "document_absence_observations",
    "document_absence_scopes",
    "document_absences",
    "document_extracted_dates",
    "document_links",
    "document_people",
    "document_temporal_projection_sources",
    "document_temporal_projections",
    "documents",
    "interest_brief_reactions",
    "interest_signals",
    "knowledge_candidate_sources",
    "knowledge_changes",
    "knowledge_checkpoints",
    "knowledge_claim_outcomes",
    "knowledge_claims",
    "knowledge_decisions",
    "knowledge_dependencies",
    "knowledge_discovery_coverage",
    "knowledge_discovery_targets",
    "knowledge_evidence",
    "knowledge_links",
    "knowledge_node_tombstones",
    "knowledge_nodes",
    "knowledge_operational_arcs",
    "knowledge_outcome_assessment_sources",
    "knowledge_outcome_assessments",
    "knowledge_reconciliation_revisions",
    "knowledge_retired_loop_sources",
    "knowledge_revision_dependencies",
    "knowledge_revisions",
    "knowledge_source_revisions",
    "live_voice_usage",
    "merge_candidates",
    "merge_rules",
    "morning_brief_items",
    "morning_brief_references",
    "morning_briefs",
    "non_identifying_emails",
    "note_agent_meta",
    "note_entries",
    "observation_citations",
    "observation_outcomes",
    "observation_related_loops",
    "observations",
    "open_loop_docs",
    "open_loop_ledger",
    "open_loop_people",
    "open_loops",
    "pending_edges",
    "people",
    "person_alias_assertions",
    "person_aliases",
    "person_annotation_evidence",
    "person_annotations",
    "person_equivalences",
    "removed_documents",
    "removed_sources",
    "replica_deletion_claims",
    "retired_loops",
    "snapshot_absence_deletions",
    "source_document_profiles",
    "source_family_meta",
    "source_watermarks",
    "source_wipe_epoch",
    "source_wire_contracts",
    "sync_state",
    "temporal_annotation_documents",
    "temporal_annotation_evidence",
    "temporal_annotation_loops",
    "temporal_annotation_people",
    "temporal_annotation_projections",
    "temporal_annotations",
    "worth_answers",
  ],
};

const policies = new Map<string, RestoreTablePolicy>();
for (const policy of ["keep-target", "discard-work", "rebuild-derived", "import-data"] as const) {
  for (const name of groups[policy]) {
    if (policies.has(name)) throw new Error("A restore table has conflicting authority policies");
    policies.set(name, policy);
  }
}
policies.set("devices", "reconcile-devices");
policies.set("sources", "pause-sources");
policies.set("source_devices", "review-memberships");
policies.set("source_member_config_contracts", "review-memberships");
policies.set("storage_retention_bindings", "discard-work");
policies.set("storage_source_incarnations", "discard-work");
policies.set("cognition_engine_state", "keep-target");

policies.set("knowledge_candidates", "pause-data");
policies.set("note_agent_runs", "pause-data");
policies.set("cognition_runs", "pause-data");
policies.set("voice_note_transcriptions", "pause-data");

export function desktopRestoreTablePolicy(name: string): RestoreTablePolicy {
  const policy = policies.get(name);
  if (!policy)
    throw new Error("This backup contains a database table without a reviewed restore policy");
  return policy;
}
export function desktopRestoreReviewedTables(): readonly string[] {
  return [...policies.keys()].sort();
}
