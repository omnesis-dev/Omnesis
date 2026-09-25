// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "omnesis-ios-spike-classifier-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function classify({ row, events, pipeline = "" }) {
  const report = join(directory, "report-" + Math.random() + ".json");
  const state = join(directory, "state-" + Math.random() + ".jsonl");
  const pipelineLog = join(directory, "pipeline-" + Math.random() + ".log");
  writeFileSync(report, JSON.stringify({ delivered: row ? [row] : [] }));
  writeFileSync(state, events.map((event) => JSON.stringify(event)).join("\n"));
  writeFileSync(pipelineLog, pipeline);
  return JSON.parse(
    execFileSync(
      "python3",
      ["scripts/fixtures/classify-ios-push-spike.py", report, state, pipelineLog],
      { encoding: "utf8" },
    ),
  );
}

const completedEvents = [
  { path: "/notifications/claim", body: {} },
  { path: "/notifications/confirm", body: { id: "delivery_spike_1" } },
];
const fetched = {
  title: "Fetched title from the paired gateway",
  body: "Fetched body from the paired gateway.",
  badge: 7,
  interruptionLevel: "time-sensitive",
};

test("blocks when separate-extension completion is not proven", () => {
  assert.equal(classify({ row: null, events: [] }).result, "blocked");
});

test("identifies CoreSimulatorBridge local-request injection", () => {
  const result = classify({
    row: null,
    events: [],
    pipeline:
      "CoreSimulatorBridge [dev.omnesis.ios] Adding notification request ABCD to destinations: Default",
  });
  assert.equal(result.result, "blocked");
  assert.equal(result.simulatorBridgeInjectedRequest, true);
  assert.match(result.reason, /local notification request/);
});

test("reports a valid negative after claim, confirm, and content rewrite", () => {
  assert.equal(
    classify({
      row: { ...fetched, interruptionLevel: "active" },
      events: completedEvents,
    }).result,
    "negative",
  );
});

test("reports positive only when interruption level and badge both survive", () => {
  assert.equal(classify({ row: fetched, events: completedEvents }).result, "positive");
  assert.equal(
    classify({ row: { ...fetched, badge: 0 }, events: completedEvents }).result,
    "negative",
  );
});

test("streams the remote probe through zsh to bash with every argument intact", (context) => {
  const script = readFileSync("scripts/ios-push-spike.sh", "utf8");
  const marker = "<<'REMOTE_SCRIPT'";
  const markerStart = script.indexOf(marker);
  const bodyStart = script.indexOf("\n", markerStart) + 1;
  const bodyEnd = script.indexOf("\nREMOTE_SCRIPT\n", bodyStart);
  const commandFormat = script.match(/printf -v REMOTE_COMMAND '([^']+)'/)?.[1];

  assert.ok(markerStart >= 0, "remote probe must use a literal heredoc");
  assert.ok(bodyStart > markerStart && bodyEnd > bodyStart, "remote probe heredoc is complete");
  assert.equal(commandFormat, "bash -l -s -- %q %q %q %q %q %q %q %q");
  assert.match(script, /"\$\{SSH_CMD\[@\]\}" "\$HOST" "\$REMOTE_COMMAND" <<'REMOTE_SCRIPT'/);
  assert.doesNotMatch(script, /"bash -lc '/);
  assert.match(script, /mktemp "\$RESOLVED_TARGET\/xcodebuild\.log\.XXXXXX"/);
  assert.doesNotMatch(script, />\/tmp\/omnesis-ios-push-spike-xcodebuild\.log/);

  const remoteBody = script.slice(bodyStart, bodyEnd);
  execFileSync("bash", ["-n"], { input: remoteBody, stdio: ["pipe", "ignore", "pipe"] });

  const args = [
    "/Users/reviewer/omnesis-ios-push-spike",
    "iPhone 17 (Review-Test)",
    "dev.omnesis.ios",
    "ABCDE12345",
    "/Users/reviewer/omnesis-ios-push-spike/pairing.json",
    "/Users/reviewer/omnesis-ios-push-spike/wake.json",
    "/Users/reviewer/omnesis-ios-push-spike/delivered.json",
    "/Users/reviewer/omnesis-ios-push-spike/notification-pipeline.log",
  ];
  const remoteCommand = execFileSync(
    "bash",
    [
      "-c",
      'format="$1"; shift; printf -v command "$format" "$@"; printf %s "$command"',
      "remote-command-builder",
      commandFormat,
      ...args,
    ],
    { encoding: "utf8" },
  );

  let transported;
  try {
    transported = execFileSync("zsh", ["-c", remoteCommand], {
      input: "printf '%s\\n' \"$@\"\n",
      encoding: "utf8",
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      context.skip("zsh is unavailable on this host");
      return;
    }
    throw error;
  }
  assert.deepEqual(transported.trimEnd().split("\n"), args);
});

test("rejects SSH option and remote-path injection before starting SSH", () => {
  const marker = join(directory, "must-not-exist");
  const baseEnv = {
    ...process.env,
    OMNESIS_IOS_DEVELOPMENT_TEAM: "ABCDE12345",
  };
  const unsafeHost = spawnSync("bash", ["scripts/ios-push-spike.sh"], {
    env: {
      ...baseEnv,
      OMNESIS_EPIC_MACOS_HOST: `-oProxyCommand=touch ${marker}`,
    },
    encoding: "utf8",
  });
  assert.equal(unsafeHost.status, 64);
  assert.match(unsafeHost.stderr, /invalid macOS SSH alias/);

  const unsafePath = spawnSync("bash", ["scripts/ios-push-spike.sh"], {
    env: {
      ...baseEnv,
      OMNESIS_EPIC_MACOS_HOST: "review-mac",
      OMNESIS_EPIC_MACOS_IOS_PUSH_WORKTREE: `/tmp/review";touch ${marker};#`,
    },
    encoding: "utf8",
  });
  assert.equal(unsafePath.status, 64);
  assert.match(unsafePath.stderr, /remote scratch path contains unsupported characters/);
  assert.equal(existsSync(marker), false);
});
