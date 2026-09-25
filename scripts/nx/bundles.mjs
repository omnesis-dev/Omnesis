// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const e2eRoot = "packages/collector/src/e2e";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import picomatch from "picomatch";

export const bundles = {
  "source-lifecycle": {
    kind: "e2e",
    tests: [
      "*lifecycle*.e2e.test.ts",
      "multi-*.e2e.test.ts",
      "source-*.e2e.test.ts",
      "*lease*.e2e.test.ts",
      "*replica*.e2e.test.ts",
      "*replicated*.e2e.test.ts",
      "*partitioned*.e2e.test.ts",
      "*handoff*.e2e.test.ts",
      "device-*.e2e.test.ts",
      "phone-cursor-authority.e2e.test.ts",
      "things-multi-device.e2e.test.ts",
      "needs-auth-reminder.e2e.test.ts",
      "permission-remediation.e2e.test.ts",
      "self-identity-registry.e2e.test.ts",
      "snapshot-absence*.e2e.test.ts",
      "sync-tombstone-cascade.e2e.test.ts",
      "structured-claims.e2e.test.ts",
      "state-migration.e2e.test.ts",
      "auth-challenge.e2e.test.ts",
      "old-collector-wire.e2e.test.ts",
      "new-collector-old-gateway.e2e.test.ts",
    ],
  },
  "search-graph": {
    kind: "e2e",
    tests: [
      "*search*.e2e.test.ts",
      "golden-corpus.e2e.test.ts",
      "adjacency-retrieval.e2e.test.ts",
      "*graph*.e2e.test.ts",
      "*link*.e2e.test.ts",
      "*identity*.e2e.test.ts",
      "people-*.e2e.test.ts",
      "merge-*.e2e.test.ts",
      "near-dup*.e2e.test.ts",
      "temporal-*.e2e.test.ts",
      "embed*.e2e.test.ts",
    ],
  },
  "agent-brain-watch": {
    kind: "e2e",
    tests: [
      "agent-*.e2e.test.ts",
      "*-agent.e2e.test.ts",
      "brain-*.e2e.test.ts",
      "briefs-*.e2e.test.ts",
      "interactive-memory.e2e.test.ts",
      "omnesis-chat.e2e.test.ts",
      "operator-instructions.e2e.test.ts",
      "replay-scenarios.e2e.test.ts",
      "mcp-*.e2e.test.ts",
      "watch-*.e2e.test.ts",
      "japan-trip-deep-research.e2e.test.ts",
    ],
  },
  "browser-capture": {
    kind: "e2e",
    tests: ["browser-*.e2e.test.ts"],
  },
  portal: {
    kind: "e2e",
    tests: ["portal.e2e.test.ts"],
  },
  "ingestion-providers": {
    kind: "e2e",
    tests: [
      "apple-*.e2e.test.ts",
      "coinbase.e2e.test.ts",
      "finance.e2e.test.ts",
      "github-source.e2e.test.ts",
      "granola.e2e.test.ts",
      "onedrive.e2e.test.ts",
      "outlook-calendar.e2e.test.ts",
      "plaid.e2e.test.ts",
      "whatsapp-*.e2e.test.ts",
      "attachments.e2e.test.ts",
      "ocr.e2e.test.ts",
      "pipeline.e2e.test.ts",
      "synth-*.e2e.test.ts",
      "transcribe.e2e.test.ts",
      "mobile-source-modes.e2e.test.ts",
      "local-transcripts-multi-device.e2e.test.ts",
      "packages/providers/**/*.e2e.test.ts",
    ],
  },
  "security-notifications": {
    kind: "e2e",
    tests: [
      "answer-boundary.e2e.test.ts",
      "notification-queue.e2e.test.ts",
      "push-transport-selection.e2e.test.ts",
      "relay-push.e2e.test.ts",
      "secure-storage*.e2e.test.ts",
      "sidecar-encryption.e2e.test.ts",
      "tofu.e2e.test.ts",
      "reverse-proxy.e2e.test.ts",
      "mobile-permission-health.e2e.test.ts",
      "restart-durability.e2e.test.ts",
    ],
  },
  "gateway-core": {
    kind: "e2e",
    tests: [
      "access-connections.e2e.test.ts",
      "advanced.e2e.test.ts",
      "analytics-row-key.e2e.test.ts",
      "cli.e2e.test.ts",
      "declared-edges.e2e.test.ts",
      "fleet-update.e2e.test.ts",
      "portal-fleet-host-update.e2e.test.ts",
      "harness-plugin-conformance.e2e.test.ts",
      "websocket.e2e.test.ts",
      "phone-region.e2e.test.ts",
      "scheduler-heartbeat.e2e.test.ts",
      "packages/gateway/**/*.e2e.test.ts",
      "packages/cli/**/*.e2e.test.ts",
    ],
  },
  "ios-logic": { kind: "native", nativeKind: "ios-logic" },
  "ios-snapshot": { kind: "native", nativeKind: "ios-snapshot" },
  "android-logic": { kind: "native", nativeKind: "android-logic" },
  "android-render": { kind: "native", nativeKind: "android-render" },
  "ios-build": { kind: "native", nativeKind: "ios-build" },
  "android-build": { kind: "native", nativeKind: "android-build" },
  "ios-e2e": { kind: "native", nativeKind: "ios-e2e" },
  "android-e2e": { kind: "native", nativeKind: "android-e2e" },
};

export const allE2EBundles = Object.keys(bundles).filter((name) => bundles[name].kind === "e2e");
export const allNativeBundles = Object.keys(bundles).filter(
  (name) => bundles[name].kind === "native",
);

export function repositoryE2ETests() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*e2e.test.ts"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter(existsSync)
    .sort();
}

export function bundleTestArgs(name, candidates = repositoryE2ETests()) {
  const patterns = (bundles[name]?.tests ?? []).map((pattern) =>
    pattern.includes("/") ? pattern : `${e2eRoot}/${pattern}`,
  );
  const match = picomatch(patterns);
  return candidates.filter(match);
}

export function uncoveredE2ETests() {
  const candidates = repositoryE2ETests();
  const covered = new Set(allE2EBundles.flatMap((name) => bundleTestArgs(name, candidates)));
  return candidates.filter((file) => !covered.has(file));
}

const nativeBridgeBundles = new Map([
  ["scripts/ios-logic.sh", "ios-logic"],
  ["scripts/ios-snapshot.sh", "ios-snapshot"],
  ["scripts/run-ios-e2e.sh", "ios-e2e"],
  ["scripts/android-logic.sh", "android-logic"],
  ["scripts/android-render.sh", "android-render"],
  ["scripts/run-android-e2e.sh", "android-e2e"],
]);

const areas = [
  {
    test: (p) => /packages\/(?:core|types|config|source-sdk|gateway-client)\/src\//.test(p),
    bundles: ["gateway-core"],
  },
  { test: (p) => p.startsWith("ios/"), bundles: ["ios-logic"] },
  {
    test: (p) => p.startsWith("ios/") && /(?:UI|View|Screen|Snapshot|Preview)/.test(p),
    bundles: ["ios-snapshot"],
  },
  {
    test: (p) =>
      p.startsWith("ios/") &&
      /(?:project\.yml|\.xcconfig|Info\.plist|Package\.swift|GatewayLiveE2E)/.test(p),
    bundles: ["ios-build", "ios-e2e"],
  },
  { test: (p) => p.startsWith("android/"), bundles: ["android-logic"] },
  {
    test: (p) => p.startsWith("android/") && /(?:ui|screen|compose|screenshot)/i.test(p),
    bundles: ["android-render"],
  },
  {
    test: (p) =>
      p.startsWith("android/") &&
      /(?:build\.gradle|settings\.gradle|AndroidManifest|androidTest)/.test(p),
    bundles: ["android-build", "android-e2e"],
  },
  { test: (p) => p.startsWith("extension/"), bundles: ["browser-capture"] },
  { test: (p) => p.startsWith("packages/gateway/portal/"), bundles: ["portal"] },
  {
    test: (p) =>
      /packages\/(?:core|types|gateway-client|gateway)\/.*(?:protocol|http|dto|ws|pairing|device)/.test(
        p,
      ),
    bundles: ["ios-logic", "android-logic", "ios-e2e", "android-e2e"],
  },
  {
    test: (p) =>
      p.startsWith("packages/") &&
      /(?:search|embed|indexer|search-index|ranking|people|identity|graph|link|temporal|near-dup)/.test(
        p,
      ),
    bundles: ["search-graph"],
  },
  {
    test: (p) =>
      p.startsWith("packages/") && /(?:brain|brief|watch|agent|mcp|memory|replay)/.test(p),
    bundles: ["agent-brain-watch"],
  },
  {
    test: (p) =>
      p.startsWith("packages/") &&
      /(?:notification|push|privacy|permission|auth|security|secret|encrypt|tofu)/.test(p),
    bundles: ["security-notifications"],
  },
  {
    test: (p) => p.startsWith("packages/providers/") || p.startsWith("packages/providers-synth/"),
    bundles: ["ingestion-providers", "source-lifecycle"],
  },
  {
    test: (p) =>
      p.startsWith("packages/") &&
      /(?:source|sync|collector|device|lease|replica|membership|ownership|cursor|snapshot)/.test(p),
    bundles: ["source-lifecycle"],
  },
  {
    test: (p) =>
      (p.startsWith("packages/gateway/") && !p.startsWith("packages/gateway/portal/")) ||
      p.startsWith("packages/collector/") ||
      p.startsWith("packages/cli/"),
    bundles: ["gateway-core"],
  },
];

export function behavioralBundles(files) {
  const selected = new Set();
  for (const file of files) {
    // Narrative and repository-maintenance text can mention a subsystem without
    // changing it. Do not turn docs/brain.md into a Brain E2E request merely
    // because the path contains the word "brain".
    if (
      /^(?:docs|website|\.claude|\.agents|\.changeset)\//.test(file) ||
      /(?:^|\/)(?:CHANGELOG|README)\.md$/.test(file) ||
      /^(?:AGENTS|CLAUDE|README|CONTRIBUTING|ARCHITECTURE|SECURITY|SUPPORT|CODE_OF_CONDUCT|CHANGELOG|CLA|LICENSE|THIRD_PARTY_NOTICES|TRADEMARKS)\.md$/.test(
        file,
      )
    )
      continue;
    const nativeBundle = nativeBridgeBundles.get(file);
    if (nativeBundle) {
      selected.add(nativeBundle);
      continue;
    }
    for (const area of areas)
      if (area.test(file)) area.bundles.forEach((name) => selected.add(name));
  }
  return [...selected].sort();
}
