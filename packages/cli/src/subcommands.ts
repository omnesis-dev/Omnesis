// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `omnesis` command tree. Each leaf is a `defineCommand` exported from its
 * file under `commands/` and pulled in lazily — running `omnesis search foo`
 * shouldn't import @clack/prompts, qrcode-terminal, or any other admin-only
 * dep tree, so commands resolve via a per-key dynamic import.
 *
 * Each entry also carries the one-line summary the top-level `--help` lists,
 * so that screen is rendered from this table alone and imports no command.
 * Reading each command's own description instead would load nearly the whole
 * product, the gateway and collector daemons included, to print a list of
 * names, and under a TypeScript loader every module loaded leaves a cache
 * write that the process must finish before it can exit.
 *
 * Lives apart from the entrypoint so the tree can be read without running the
 * CLI: importing `index.ts` performs the TLS preflight and dispatches argv.
 */

import type { SubCommandsDef } from "citty";

/** One top-level command: its `--help` summary and the import that defines it. */
export interface CommandEntry {
  /** Must equal the command's own `meta.description`; a unit test holds them together. */
  readonly description: string;
  readonly load: Extract<SubCommandsDef[string], () => unknown>;
}

export const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  // The Omnesis account and the cloud relay.
  cloud: {
    description: "Your Omnesis account: connect this gateway and add devices",
    load: () => import("./commands/cloud.js").then((m) => m.cloudCommand),
  },
  // The gateway's own Tailscale device.
  tailscale: {
    description: "The gateway's own Tailscale device",
    load: () => import("./commands/tailscale.js").then((m) => m.tailscaleCommand),
  },
  // ── Read commands (any token) ────────────────────────────────────────
  search: {
    description: "Search across indexed documents",
    load: () => import("./commands/search.js").then((m) => m.searchCommand),
  },
  show: {
    description: "Show a document by ID (or unambiguous prefix)",
    load: () => import("./commands/show.js").then((m) => m.showCommand),
  },
  lookup: {
    description: "Find documents by source URL (canonicalized)",
    load: () => import("./commands/lookup.js").then((m) => m.lookupCommand),
  },
  recent: {
    description: "List recent documents for a source",
    load: () => import("./commands/recent.js").then((m) => m.recentCommand),
  },
  // Quick capture into the built-in omnesis-notes source.
  note: {
    description: "Capture a quick note addressed to your Omnesis brain",
    load: () => import("./commands/note.js").then((m) => m.noteCommand),
  },
  // Destructive: permanently removes one document from the corpus.
  delete: {
    description: "Delete a single document from the corpus (privacy)",
    load: () => import("./commands/delete.js").then((m) => m.deleteCommand),
  },
  trail: {
    description: "Build a chronological event trail around one or more documents",
    load: () => import("./commands/trail.js").then((m) => m.trailCommand),
  },
  edges: {
    description: "Inspect a document's reference-graph edges",
    load: () => import("./commands/edges.js").then((m) => m.edgesCommand),
  },
  graph: {
    description: "Traverse the knowledge graph",
    load: () => import("./commands/graph.js").then((m) => m.graphCommand),
  },
  sql: {
    description: "Run a read-only SQL query against the analytics or sqlite DB",
    load: () => import("./commands/sql.js").then((m) => m.sqlCommand),
  },
  analytics: {
    description: "Inspect analytics catalog and tables",
    load: () => import("./commands/analytics.js").then((m) => m.analyticsCommand),
  },
  status: {
    description: "Show per-source sync + index state",
    load: () => import("./commands/status.js").then((m) => m.statusCommand),
  },
  health: {
    description: "Check gateway health",
    load: () => import("./commands/health.js").then((m) => m.healthCommand),
  },
  doctor: {
    description: "Diagnose the health and security posture of your Omnesis setup (read-only)",
    load: () => import("./commands/doctor.js").then((m) => m.doctorCommand),
  },
  stalls: {
    description: "Rank what has been blocking the gateway's event loop",
    load: () => import("./commands/stalls.js").then((m) => m.stallsCommand),
  },
  keyring: {
    description: "Manage Omnesis OS keyring material",
    load: () => import("./commands/keyring.js").then((m) => m.keyringCommand),
  },
  whoami: {
    description: "Show current token, device, and scopes",
    load: () => import("./commands/whoami.js").then((m) => m.whoamiCommand),
  },
  // Developer annotations (gateway OMNESIS_DEV_MODE) — read/triage the
  // operator → engineer data-quality feedback channel. 404s when off.
  "dev-annotations": {
    description: "Read and triage developer annotations (requires gateway OMNESIS_DEV_MODE)",
    load: () => import("./commands/dev-annotations.js").then((m) => m.devAnnotationsCommand),
  },
  // The watch runtime (gateway OMNESIS_EXPERIMENTAL). Reads, plus one write
  // that stores a watch as data. 404s when off.
  watch: {
    description: "The watch runtime (experimental)",
    load: () => import("./commands/watch.js").then((m) => m.watchCommand),
  },

  // ── Agent integration ────────────────────────────────────────────────
  // Admin-authenticated read-only agent surface (experimental).
  answer: {
    description: "Ask the read-only Omnesis agent",
    load: () => import("./commands/answer.js").then((m) => m.answerCommand),
  },
  // Local-only helper that emits operating instructions.
  agent: {
    description: "Agent integration helpers (operating instructions for AI agents)",
    load: () => import("./commands/agent.js").then((m) => m.agentCommand),
  },
  connect: {
    description:
      "Connect an external agent harness (OpenClaw, Hermes) to this user's Omnesis: provision least-privilege credentials, install the plugin + skill, and verify health",
    load: () => import("./commands/connect.js").then((m) => m.connectCommand),
  },
  access: {
    description: "Inspect and migrate delegated MCP access",
    load: () => import("./commands/access.js").then((m) => m.accessCommand),
  },
  watches: {
    description: "Manage the watches integrations own",
    load: () => import("./commands/watches.js").then((m) => m.watchesCommand),
  },
  // Muscle memory and any script that already spells it the transport's way.
  subscriptions: {
    description: "Manage the watches integrations own",
    load: () => import("./commands/watches.js").then((m) => m.watchesCommand),
  },

  // ── People queries (read scope) ──────────────────────────────────────
  people: {
    description: "People graph queries",
    load: () => import("./commands/people.js").then((m) => m.peopleCommand),
  },

  // ── Grouped admin commands ──────────────────────────────────────────
  sources: {
    description: "Manage data sources (admin scope)",
    load: () => import("./commands/sources-group.js").then((m) => m.sourcesCommand),
  },
  creds: {
    description: "Manage provider OAuth credentials",
    load: () => import("./commands/creds.js").then((m) => m.credsCommand),
  },
  broker: {
    description: "Take account credentials from a credential broker",
    load: () => import("./commands/broker.js").then((m) => m.brokerCommand),
  },
  devices: {
    description: "Manage paired devices",
    load: () => import("./commands/devices.js").then((m) => m.devicesCommand),
  },
  // Friendlier top-level alias for `devices redeem` — pair a new device with
  // `omnesis pair <code>` instead of curling the raw /devices/pair endpoint.
  pair: {
    description:
      "Redeem a pairing code on this device and obtain its token (alias of `devices redeem`)",
    load: () => import("./commands/devices.js").then((m) => m.pairCommand),
  },
  // Operator identity (config.self) — who you are, used to bootstrap the
  // canonical "self" person. The install-level home for self emails/phones.
  self: {
    description: "Manage who you are — the identity used to bootstrap the canonical self person",
    load: () => import("./commands/self.js").then((m) => m.selfCommand),
  },
  tokens: {
    description: "Manage scoped auth tokens",
    load: () => import("./commands/tokens.js").then((m) => m.tokensCommand),
  },
  config: {
    description: "View and edit the gateway's omnesis.json config",
    load: () => import("./commands/config.js").then((m) => m.configCommand),
  },
  tls: {
    description:
      "Manage the gateway's TLS certificate: provision a browser-trusted cert, inspect, renew, reload, re-trust",
    load: () => import("./commands/tls-provision.js").then((m) => m.tlsCommand),
  },
  brain: {
    description:
      "Inspect the Brain: open loops, runs, transcripts, decisions, spend, calibration (operator, read-only)",
    load: () => import("./commands/briefs.js").then((m) => m.brainCommand),
  },
  // Compatibility for scripts and muscle memory that predate the broader
  // Brain namespace. Hidden from help so there is one canonical spelling.
  briefs: {
    description:
      "Inspect the Brain: open loops, runs, transcripts, decisions, spend, calibration (operator, read-only)",
    load: () => import("./commands/briefs.js").then((m) => m.brainCommand),
  },
  push: {
    description: "Configure and test phone push notifications",
    load: () => import("./commands/push.js").then((m) => m.pushCommand),
  },
  models: {
    description: "Install / assign / uninstall embedding, agent, and transcription models",
    load: () => import("./commands/model.js").then((m) => m.modelCommand),
  },
  model: {
    description: "Install / assign / uninstall embedding, agent, and transcription models",
    load: () => import("./commands/model.js").then((m) => m.modelCommand),
  },
  backend: {
    description: "Manage inference backends and API keys",
    load: () => import("./commands/backend.js").then((m) => m.backendCommand),
  },
  decision: {
    description: "Set up the Decision model: providers, decision APIs, verify",
    load: () => import("./commands/decision.js").then((m) => m.decisionCommand),
  },
  codex: {
    description: "Manage the Codex agent backend (ChatGPT subscription)",
    load: () => import("./commands/codex.js").then((m) => m.codexCommand),
  },
  "claude-code": {
    description: "Manage the Claude Code agent backend (Claude subscription)",
    load: () => import("./commands/claude-code.js").then((m) => m.claudeCodeCommand),
  },
  index: {
    description: "Global index operations (admin)",
    load: () => import("./commands/index-group.js").then((m) => m.indexCommand),
  },
  eval: {
    description: "Search quality + performance eval toolkit",
    load: () => import("./commands/eval-group.js").then((m) => m.evalCommand),
  },
  backup: {
    description: "Create an online backup of the gateway's databases and config",
    load: () => import("./commands/backup.js").then((m) => m.backupCommand),
  },
  restore: {
    description:
      "Restore a gateway backup into a config directory (offline; stop the gateway first, or let a Docker install's launcher do it)",
    load: () => import("./commands/restore.js").then((m) => m.restoreCommand),
  },
  secure: {
    description: "Guided wizard: enable full at-rest encryption safely (backup + recovery first)",
    load: () => import("./commands/secure.js").then((m) => m.secureCommand),
  },
  export: {
    description: "Export documents (and analytics) to a portable JSON/CSV archive on the gateway",
    load: () => import("./commands/export.js").then((m) => m.exportCommand),
  },

  // ── Lifecycle (install/update/supervise) ─────────────────────────────
  service: {
    description: "Install and manage Omnesis as a background service (launchd / systemd)",
    load: () => import("./commands/service.js").then((m) => m.serviceCommand),
  },
  update: {
    description: "Update this host to the latest release and restart what it runs",
    load: () => import("./commands/update.js").then((m) => m.updateCommand),
  },
  uninstall: {
    description:
      "Remove Omnesis from this machine: services, agent integrations and the CLI (data stays unless --purge)",
    load: () => import("./commands/uninstall.js").then((m) => m.uninstallCommand),
  },
  "_portal-fleet-update-run": {
    description: "Run a previously approved portal fleet update",
    load: () =>
      import("./commands/portal-fleet-update-run.js").then((m) => m.portalFleetUpdateRunCommand),
  },

  // ── Daemon hosts (what `omnesis service` units exec) ─────────────────
  gateway: {
    description: "Run the Omnesis gateway",
    load: () => import("./commands/daemon.js").then((m) => m.gatewayCommand),
  },
  collector: {
    description: "Run the Omnesis collector",
    load: () => import("./commands/daemon.js").then((m) => m.collectorCommand),
  },
};

/**
 * Command names that still dispatch but no longer appear in `--help`. Keeping
 * one working costs nothing; listing it beside the name it duplicates is what
 * makes a help screen ambiguous.
 */
export const HIDDEN_COMMAND_ALIASES: ReadonlySet<string> = new Set(["subscriptions", "briefs"]);

/** Internal entry points invoked by Omnesis itself, never by an operator. */
export const HIDDEN_INTERNAL_COMMANDS: ReadonlySet<string> = new Set(["_portal-fleet-update-run"]);

/** What the CLI dispatches: each command name to the import that defines it. */
export const SUB_COMMANDS: SubCommandsDef = Object.fromEntries(
  Object.entries(COMMANDS).map(([name, entry]) => [name, entry.load]),
);

/**
 * The command tree as the top-level `--help` renders it: the listed commands
 * as inert stubs carrying only their summaries, so rendering imports no
 * command module.
 */
export function visibleSubCommands(): SubCommandsDef {
  return Object.fromEntries(
    Object.entries(COMMANDS)
      .filter(([name]) => !HIDDEN_COMMAND_ALIASES.has(name) && !HIDDEN_INTERNAL_COMMANDS.has(name))
      .map(([name, entry]) => [name, { meta: { name, description: entry.description } }]),
  );
}
