// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  keepIOSTrustServiceReplaced,
  trustServiceState,
  waitForIOSTrustService,
} from "./wait-ios-trust-service.mjs";

const UDID = "00000000-0000-4000-8000-000000000001";
const TRUSTD = "/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/usr/libexec/trustd";

// The trust-asset messages a hosted runner's simulator logged while trustd
// replaced its trust store twice, in order (the paths are left out).
const startup = (pid, second) => [
  entry(pid, second, "Using system trust store 2026040100 instead of asset trust store 0"),
  entry(pid, second + 1, "Current PKITrustStore status: unlocked"),
  entry(pid, second + 2, "Initial check with MobileAsset for newer PKITrustSupplementals asset"),
];
const firstTrustd = [
  ...startup(101, 0),
  entry(101, 60, "--- Received asset download notification ---"),
  entry(101, 72, "Will exit when clean to use downloaded asset. uptime: 1, system: 449s"),
  entry(101, 780, "begin download of OTATrust asset"),
];
const secondTrustd = [
  ...startup(202, 1110),
  entry(202, 1111, "--- New asset path obtained from MobileAsset ---"),
  entry(202, 1122, "Will exit when clean to use updated asset path. uptime: 1, system: 1500s"),
];
const thirdTrustd = [
  ...startup(303, 1250),
  entry(303, 1251, "Available version: 0, our current version: 2026040100, content locked: true"),
];
// Supplemental trust data, as a hosted runner's simulator logged it (#1252):
// mobileassetd announces it to the first trustd, which is waiting to exit and
// leaves it uninstalled, then again to the trustd that settled. Installing it
// rewrites the pinning database, and every evaluation waits until it is done.
const announcedToFirst = entry(
  101,
  300,
  "Got notification about a new PKITrustSupplementals asset from mobileassetd.",
);
const installByThird = [
  entry(303, 1330, "Got notification about a new PKITrustSupplementals asset from mobileassetd."),
  entry(303, 1342, "begin download of OTATrust asset"),
  entry(303, 1450, "Pinning database should update from version 121 to version 131"),
  entry(303, 1620, "updating asset version from 1013 to 1014"),
];
const installedByThird = entry(
  303,
  1680,
  "finished update to version 1014 from installed asset. purging asset.",
);
const withSupplementals = [
  ...firstTrustd.slice(0, 4),
  announcedToFirst,
  ...firstTrustd.slice(4),
  ...secondTrustd,
  ...thirdTrustd,
];

function entry(processID, second, eventMessage) {
  const time = new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();
  return { processID, timestamp: time.replace("T", " ").replace("Z", "+0000"), eventMessage };
}

/** A simulator log that grows by one snapshot per `log show` call. */
function simulator(snapshots) {
  const calls = [];
  let index = 0;
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    const entries = snapshots[Math.min(index, snapshots.length - 1)];
    index += 1;
    return `Filtering the log data using "${args.at(-1)}"\n${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  };
  return { run, calls };
}

function clock() {
  let time = 0;
  return { now: () => time, wait: (ms) => (time += ms) };
}

describe("the simulator's trust service", () => {
  test("is classified by its newest process", () => {
    expect(trustServiceState([]).state).toBe("unknown");
    expect(trustServiceState(startup(101, 0).slice(0, 1))).toMatchObject({
      state: "starting",
      pid: 101,
    });
    expect(trustServiceState(startup(101, 0))).toMatchObject({ state: "settled", pid: 101 });
    expect(trustServiceState(firstTrustd)).toMatchObject({ state: "replacing", pid: 101 });
    // A newer trustd that has not decided yet is starting, whatever its predecessor said.
    expect(trustServiceState([...firstTrustd, ...startup(202, 1110).slice(0, 1)])).toMatchObject({
      state: "starting",
      pid: 202,
    });
    expect(trustServiceState([...firstTrustd, ...secondTrustd])).toMatchObject({
      state: "replacing",
      pid: 202,
    });
    expect(trustServiceState([...firstTrustd, ...secondTrustd, ...thirdTrustd])).toMatchObject({
      state: "settled",
      pid: 303,
    });
  });

  test("waits for announced supplemental trust data to be installed, by whichever trustd", () => {
    expect(trustServiceState(withSupplementals)).toMatchObject({ state: "installing", pid: 303 });
    // Downloading it is not a departure: the trustd installing it is never asked to leave.
    expect(trustServiceState([...withSupplementals, ...installByThird.slice(0, 2)])).toMatchObject({
      state: "installing",
      pid: 303,
    });
    expect(
      trustServiceState([...withSupplementals, ...installByThird, installedByThird]),
    ).toMatchObject({ state: "settled", pid: 303 });
    // A later announcement is due again.
    expect(
      trustServiceState([
        ...withSupplementals,
        ...installByThird,
        installedByThird,
        entry(
          303,
          1700,
          "Got notification about a new PKITrustSupplementals asset from mobileassetd.",
        ),
      ]),
    ).toMatchObject({ state: "installing", pid: 303 });
    // A replacement still comes first.
    expect(
      trustServiceState([...firstTrustd.slice(0, 4), announcedToFirst, firstTrustd[4]]),
    ).toMatchObject({
      state: "replacing",
      pid: 101,
    });
  });

  test("waits through the install without signalling the trustd that makes it", () => {
    const { run } = simulator([
      withSupplementals,
      [...withSupplementals, ...installByThird.slice(0, 2)],
      [...withSupplementals, ...installByThird],
      [...withSupplementals, ...installByThird, installedByThird],
    ]);
    const signals = [];
    const lines = [];
    const time = clock();
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...time,
      command: () => TRUSTD,
      kill: (pid, name) => signals.push(`${name} ${pid}`),
      log: (text) => lines.push(text),
    });
    expect(status).toMatchObject({ state: "settled", pid: 303 });
    expect(signals).toEqual([]);
    expect(time.now()).toBe(15_000);
    expect(lines[0]).toContain("trustd 303) has had supplemental trust data to install");
    expect(lines.at(-1)).toBe("The simulator's trust service settled (trustd 303).");
  });

  test("starts anyway, without failing, when an install never logs its end", () => {
    const { run } = simulator([[...withSupplementals, ...installByThird]]);
    const lines = [];
    const time = clock();
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...time,
      timeoutMs: 60_000,
      log: (text) => lines.push(text),
    });
    expect(status).toMatchObject({ state: "installing", pid: 303 });
    expect(time.now()).toBe(60_000);
    expect(lines.at(-1)).toMatch(
      /no end to its trust data install within 60s; starting anyway[\s\S]*updating asset version/,
    );
  });

  test("keeps replacing each trustd that announces its exit until stopped", () => {
    const { run, calls } = simulator([
      startup(101, 0),
      firstTrustd.slice(0, 5),
      firstTrustd.slice(0, 5),
      [...firstTrustd, ...secondTrustd],
      [...firstTrustd, ...secondTrustd, ...thirdTrustd],
      withSupplementals,
    ]);
    const signals = [];
    const time = clock();
    keepIOSTrustServiceReplaced({
      udid: UDID,
      run,
      ...time,
      pollMs: 15_000,
      graceMs: 15_000,
      command: () => TRUSTD,
      kill: (pid, name) => signals.push(`${name} ${pid}`),
      log: () => {},
      stopped: () => calls.length >= 8,
    });
    // The install by the trustd that stays is left alone.
    expect(signals).toEqual(["SIGTERM 101", "SIGKILL 101", "SIGTERM 202"]);
  });

  test("waits through each replacement, asking each announced trustd to exit, until a new one settles", () => {
    const { run, calls } = simulator([
      firstTrustd,
      firstTrustd,
      firstTrustd,
      firstTrustd,
      [...firstTrustd, ...secondTrustd],
      [...firstTrustd, ...secondTrustd, ...thirdTrustd],
    ]);
    const signals = [];
    const lines = [];
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...clock(),
      pollMs: 5_000,
      graceMs: 15_000,
      command: () => TRUSTD,
      kill: (pid, name) => signals.push(`${name} ${pid}`),
      log: (text) => lines.push(text),
    });
    expect(status).toMatchObject({ state: "settled", pid: 303 });
    // trustd 101 does not leave after SIGTERM, so 15 s later it is killed.
    expect(signals).toEqual(["SIGTERM 101", "SIGKILL 101", "SIGTERM 202"]);
    expect(lines.join("\n")).toContain("trustd 101) is replacing its trust store");
    expect(lines.at(-1)).toBe("The simulator's trust service settled (trustd 303).");
    expect(calls[0]).toContain(`simctl spawn ${UDID} log show --last 2h --style ndjson`);
  });

  test("stops waiting once the leaving trustd has exited and nothing has started another", () => {
    const { run } = simulator([firstTrustd]);
    const signals = [];
    let alive = true;
    const time = clock();
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...time,
      undecidedMs: 120_000,
      command: () => (alive ? TRUSTD : ""),
      kill: (pid, name) => {
        signals.push(`${name} ${pid}`);
        alive = false;
      },
      log: () => {},
    });
    expect(status).toMatchObject({ state: "replacing", pid: 101 });
    expect(signals).toEqual(["SIGTERM 101"]);
    expect(time.now()).toBe(125_000);
  });

  test("stops waiting on a trustd that neither decides nor announces anything", () => {
    const { run } = simulator([startup(101, 0).slice(0, 1)]);
    const time = clock();
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...time,
      undecidedMs: 120_000,
      log: () => {},
    });
    expect(status).toMatchObject({ state: "starting", pid: 101 });
    expect(time.now()).toBe(120_000);
  });

  test("does not wait on a runtime whose trustd logs nothing about its trust store", () => {
    const { run, calls } = simulator([[]]);
    const lines = [];
    const status = waitForIOSTrustService({
      udid: UDID,
      run,
      ...clock(),
      log: (t) => lines.push(t),
    });
    expect(status.state).toBe("unknown");
    expect(calls).toHaveLength(1);
    expect(lines[0]).toContain("not waiting on it");
  });

  test("fails within its budget, naming trustd, and never signals a process that is not the simulator's trustd", () => {
    const { run } = simulator([firstTrustd]);
    const signals = [];
    const time = clock();
    expect(() =>
      waitForIOSTrustService({
        udid: UDID,
        run,
        ...time,
        timeoutMs: 60_000,
        // The process id was reused by something else.
        command: () => "/usr/libexec/trustd --agent",
        kill: (pid, name) => signals.push(`${name} ${pid}`),
        log: () => {},
      }),
    ).toThrow(
      /trust service \(trustd\) did not settle within 60s[\s\S]*begin download of OTATrust asset/,
    );
    expect(time.now()).toBe(60_000);
    expect(signals).toEqual([]);
  });
});
