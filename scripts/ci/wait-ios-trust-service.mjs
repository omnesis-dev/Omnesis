// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Wait for a freshly booted simulator's trust service to finish replacing its
// trust store before anything in the simulator opens a TLS connection.
//
// Every TLS handshake in the simulator, the app's and the UI test runner's,
// asks the simulator's trustd to evaluate the server's certificate. After a
// boot, trustd fetches trust store assets from Apple and, once one arrives,
// announces that it will exit when it has no clients left so that a new
// trustd can load the asset. Until that new trustd starts, evaluations wait:
// on a hosted runner the handover has taken from seconds to more than five
// minutes, and it lands 20 to 25 minutes after the boot, when the journeys
// begin. A client whose handshake is waiting can keep trustd from being
// clean; such stalls have ended only when the gateway dropped a handshake
// that had waited two minutes (#1206).
//
// The trust service is settled once its newest process has made its startup
// decision about the trust store (it logs the store's status) and has not
// announced an exit or started a download. A trustd that announced its exit is
// asked to leave at once (SIGTERM, then SIGKILL): nothing else in the
// simulator is using it yet, and the simulator's launchd starts a new trustd,
// which loads the asset, on the next request. A runtime whose trustd logs none
// of these messages is not waited on.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** The newest trustd has decided which trust store it serves. */
const DECIDED = /Current PKITrustStore status/;
/** The newest trustd is on its way out: it will exit to load a new asset. */
const LEAVING =
  /Will exit when clean|begin download of OTATrust asset|New asset path obtained|Received asset download notification/;
const PREDICATE = 'process == "trustd" AND category == "OTATrust"';
/** The executable of a simulator runtime's trustd, as `ps` shows it. */
const SIMULATOR_TRUSTD = /\/RuntimeRoot\/usr\/libexec\/trustd$/;

/**
 * Classify the simulator's trustd from its trust-asset log entries, oldest
 * first: `settled`, `starting` (its newest process has not decided yet),
 * `replacing` (it announced an exit or a download), or `unknown` (no entries).
 */
export function trustServiceState(entries) {
  if (entries.length === 0) return { state: "unknown" };
  const started = new Map();
  for (const entry of entries) {
    if (!started.has(entry.processID)) started.set(entry.processID, entry.timestamp);
  }
  const [pid] = [...started].reduce((newest, candidate) =>
    candidate[1] > newest[1] ? candidate : newest,
  );
  const own = entries.filter((entry) => entry.processID === pid);
  const leaving = own.find((entry) => LEAVING.test(entry.eventMessage));
  if (leaving) return { state: "replacing", pid, since: leaving.timestamp, own };
  if (!own.some((entry) => DECIDED.test(entry.eventMessage)))
    return { state: "starting", pid, own };
  return { state: "settled", pid, own };
}

function readEntries(udid, run) {
  const output = run("xcrun", [
    "simctl",
    "spawn",
    udid,
    "log",
    "show",
    "--last",
    "2h",
    "--style",
    "ndjson",
    "--predicate",
    PREDICATE,
  ]);
  return output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.processID !== undefined && typeof entry.eventMessage === "string")
    .sort((left, right) => (left.timestamp < right.timestamp ? -1 : 1));
}

/** The command line of a host process, or "" when it is gone. */
function commandOf(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

function execute(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Substitute process and clock seams to verify the wait without a simulator. */
export function waitForIOSTrustService({
  udid,
  run = execute,
  now = Date.now,
  wait = (milliseconds) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  timeoutMs = 600_000,
  pollMs = 5_000,
  graceMs = 15_000,
  undecidedMs = 120_000,
  command = commandOf,
  kill = signal,
  log = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  if (!UUID.test(udid ?? "")) throw new Error(`Expected a simulator UDID: ${udid}`);
  const deadline = now() + timeoutMs;
  // When each leaving trustd was asked to exit.
  const asked = new Map();
  // When each undecided trustd was first seen.
  const undecided = new Map();
  let reported = "";
  let status;
  for (;;) {
    status = trustServiceState(readEntries(udid, run));
    if (status.state === "unknown") {
      log("The simulator's trust service logged nothing about its trust store; not waiting on it.");
      return status;
    }
    if (status.state === "settled") {
      if (reported) log(`The simulator's trust service settled (trustd ${status.pid}).`);
      return status;
    }
    // A simulator's processes are host processes, so the simulator log's
    // process id is the host's. The command line is checked before any
    // signal, so a process id the system has since reused is never signalled.
    const gone = status.state === "replacing" && !SIMULATOR_TRUSTD.test(command(status.pid));
    // A trustd that has neither decided nor announced anything for this long
    // logs its decision some other way; it is not on its way out. A trustd
    // that has left is replaced on the next request, by then with the asset in
    // place, and nothing may ask for one before the journeys do.
    if (status.state === "starting" || gone) {
      if (!undecided.has(status.pid)) undecided.set(status.pid, now());
      if (now() - undecided.get(status.pid) >= undecidedMs) {
        log(
          gone
            ? `trustd ${status.pid} has exited and no new trustd started in ${undecidedMs / 1000}s; the next request starts one.`
            : `trustd ${status.pid} logged no trust store decision in ${undecidedMs / 1000}s and announced no exit; not waiting on it.`,
        );
        return status;
      }
    }
    const line =
      status.state === "replacing"
        ? `The simulator's trust service (trustd ${status.pid}) is replacing its trust store since ${status.since}; waiting for the new trustd before any TLS connection.`
        : `The simulator's trust service (trustd ${status.pid}) is starting; waiting for it to load its trust store.`;
    if (line !== reported) log(line);
    reported = line;
    if (status.state === "replacing" && !gone) {
      if (!asked.has(status.pid)) {
        log(`Asking trustd ${status.pid} to exit now, as it announced.`);
        kill(status.pid, "SIGTERM");
        asked.set(status.pid, now());
      } else if (now() - asked.get(status.pid) >= graceMs) {
        kill(status.pid, "SIGKILL");
      }
    }
    if (now() >= deadline) break;
    wait(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  const tail = status.own
    .slice(-8)
    .map((entry) => `  ${entry.timestamp} ${entry.eventMessage}`)
    .join("\n");
  throw new Error(
    `the simulator's trust service (trustd) did not settle within ${timeoutMs / 1000}s, ` +
      `and every TLS connection in the simulator waits on it. Its last trust store messages:\n${tail}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const seconds = Number(process.env.OMNESIS_JOURNEY_TRUST_TIMEOUT ?? 600);
    waitForIOSTrustService({ udid: process.argv[2], timeoutMs: seconds * 1000 });
  } catch (error) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  }
}
