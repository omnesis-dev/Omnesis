// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `omnesis` command tree. Each leaf is a `defineCommand` exported from its
 * file under `commands/` and pulled in lazily — running `omnesis search foo`
 * shouldn't import @clack/prompts, qrcode-terminal, or any other admin-only
 * dep tree, so commands resolve via a per-key dynamic import.
 *
 * Lives apart from the entrypoint so the tree can be read without running the
 * CLI: importing `index.ts` performs the TLS preflight and dispatches argv.
 */

import type { SubCommandsDef } from "citty";

export const SUB_COMMANDS: SubCommandsDef = {
  // ── Read commands (any token) ────────────────────────────────────────
  search: () => import("./commands/search.js").then((m) => m.searchCommand),
  show: () => import("./commands/show.js").then((m) => m.showCommand),
  lookup: () => import("./commands/lookup.js").then((m) => m.lookupCommand),
  recent: () => import("./commands/recent.js").then((m) => m.recentCommand),
  // Quick capture into the built-in omnesis-notes source.
  note: () => import("./commands/note.js").then((m) => m.noteCommand),
  // Destructive: permanently removes one document from the corpus (#1065).
  delete: () => import("./commands/delete.js").then((m) => m.deleteCommand),
  trail: () => import("./commands/trail.js").then((m) => m.trailCommand),
  edges: () => import("./commands/edges.js").then((m) => m.edgesCommand),
  graph: () => import("./commands/graph.js").then((m) => m.graphCommand),
  sql: () => import("./commands/sql.js").then((m) => m.sqlCommand),
  analytics: () => import("./commands/analytics.js").then((m) => m.analyticsCommand),
  status: () => import("./commands/status.js").then((m) => m.statusCommand),
  health: () => import("./commands/health.js").then((m) => m.healthCommand),
  doctor: () => import("./commands/doctor.js").then((m) => m.doctorCommand),
  keyring: () => import("./commands/keyring.js").then((m) => m.keyringCommand),
  whoami: () => import("./commands/whoami.js").then((m) => m.whoamiCommand),
  // Developer annotations (gateway OMNESIS_DEV_MODE) — read/triage the
  // operator → engineer data-quality feedback channel. 404s when off.
  "dev-annotations": () =>
    import("./commands/dev-annotations.js").then((m) => m.devAnnotationsCommand),
  // The watch runtime (gateway OMNESIS_EXPERIMENTAL). Reads, plus one write
  // that stores a watch as data. 404s when off.
  watch: () => import("./commands/watch.js").then((m) => m.watchCommand),

  // ── Agent integration ────────────────────────────────────────────────
  // Admin-authenticated read-only agent surface (experimental).
  answer: () => import("./commands/answer.js").then((m) => m.answerCommand),
  // Local-only helper that emits operating instructions.
  agent: () => import("./commands/agent.js").then((m) => m.agentCommand),
  connect: () => import("./commands/connect.js").then((m) => m.connectCommand),
  access: () => import("./commands/access.js").then((m) => m.accessCommand),
  watches: () => import("./commands/watches.js").then((m) => m.watchesCommand),
  // Muscle memory and any script that already spells it the transport's way.
  subscriptions: () => import("./commands/watches.js").then((m) => m.watchesCommand),

  // ── People queries (read scope) ──────────────────────────────────────
  people: () => import("./commands/people.js").then((m) => m.peopleCommand),

  // ── Grouped admin commands ──────────────────────────────────────────
  sources: () => import("./commands/sources-group.js").then((m) => m.sourcesCommand),
  creds: () => import("./commands/creds.js").then((m) => m.credsCommand),
  devices: () => import("./commands/devices.js").then((m) => m.devicesCommand),
  // Friendlier top-level alias for `devices redeem` — pair a new device with
  // `omnesis pair <code>` instead of curling the raw /devices/pair endpoint.
  pair: () => import("./commands/devices.js").then((m) => m.pairCommand),
  // Operator identity (config.self) — who you are, used to bootstrap the
  // canonical "self" person. The install-level home for self emails/phones.
  self: () => import("./commands/self.js").then((m) => m.selfCommand),
  tokens: () => import("./commands/tokens.js").then((m) => m.tokensCommand),
  config: () => import("./commands/config.js").then((m) => m.configCommand),
  tls: () => import("./commands/tls-provision.js").then((m) => m.tlsCommand),
  brain: () => import("./commands/briefs.js").then((m) => m.brainCommand),
  // Compatibility for scripts and muscle memory that predate the broader
  // Brain namespace. Hidden from help so there is one canonical spelling.
  briefs: () => import("./commands/briefs.js").then((m) => m.brainCommand),
  push: () => import("./commands/push.js").then((m) => m.pushCommand),
  models: () => import("./commands/model.js").then((m) => m.modelCommand),
  model: () => import("./commands/model.js").then((m) => m.modelCommand),
  backend: () => import("./commands/backend.js").then((m) => m.backendCommand),
  codex: () => import("./commands/codex.js").then((m) => m.codexCommand),
  index: () => import("./commands/index-group.js").then((m) => m.indexCommand),
  eval: () => import("./commands/eval-group.js").then((m) => m.evalCommand),
  backup: () => import("./commands/backup.js").then((m) => m.backupCommand),
  restore: () => import("./commands/restore.js").then((m) => m.restoreCommand),
  secure: () => import("./commands/secure.js").then((m) => m.secureCommand),
  export: () => import("./commands/export.js").then((m) => m.exportCommand),

  // ── Lifecycle (install/update/supervise) ─────────────────────────────
  service: () => import("./commands/service.js").then((m) => m.serviceCommand),
  update: () => import("./commands/update.js").then((m) => m.updateCommand),
  "_portal-fleet-update-run": () =>
    import("./commands/portal-fleet-update-run.js").then((m) => m.portalFleetUpdateRunCommand),

  // ── Daemon hosts (what `omnesis service` units exec) ─────────────────
  gateway: () => import("./commands/daemon.js").then((m) => m.gatewayCommand),
  collector: () => import("./commands/daemon.js").then((m) => m.collectorCommand),
};

/**
 * Command names that still dispatch but no longer appear in `--help`. Keeping
 * one working costs nothing; listing it beside the name it duplicates is what
 * makes a help screen ambiguous.
 */
export const HIDDEN_COMMAND_ALIASES: ReadonlySet<string> = new Set(["subscriptions", "briefs"]);

/** Internal entry points invoked by Omnesis itself, never by an operator. */
export const HIDDEN_INTERNAL_COMMANDS: ReadonlySet<string> = new Set(["_portal-fleet-update-run"]);

/** The command tree as `--help` renders it. */
export function visibleSubCommands(): SubCommandsDef {
  return Object.fromEntries(
    Object.entries(SUB_COMMANDS).filter(
      ([name]) => !HIDDEN_COMMAND_ALIASES.has(name) && !HIDDEN_INTERNAL_COMMANDS.has(name),
    ),
  );
}
