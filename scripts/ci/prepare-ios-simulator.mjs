// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Hosted images do not guarantee a particular named simulator, or that every
// platform runtime needed by the embedded Watch app has been installed.
// Print one booted iPhone UDID for callers to use as an exact destination.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_IOS_MAJOR = 17; // ios/project.yml deployment target
const MIN_WATCH_MAJOR = 10; // ios/project.yml Watch deployment target
const SIMULATOR_TIMEOUT_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function availableRuntimes(inventory, platform, minimumMajor) {
  return (inventory.runtimes ?? [])
    .filter(
      (runtime) =>
        runtime.isAvailable === true &&
        runtime.identifier?.startsWith(`com.apple.CoreSimulator.SimRuntime.${platform}-`) &&
        Number(runtime.version?.split(".")[0]) >= minimumMajor,
    )
    .sort((left, right) => right.version.localeCompare(left.version, "en", { numeric: true }));
}

function execute(command, args, timeout = SIMULATOR_TIMEOUT_MS) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

/** Use the real process seam in production; tests substitute command outcomes. */
export function prepareIOSSimulator({
  run = execute,
  log = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  const command = (name, args, timeout = SIMULATOR_TIMEOUT_MS) => {
    const description = `${name} ${args.join(" ")}`;
    log(`Running ${description} (timeout ${timeout / 1000}s).`);
    try {
      return run(name, args, timeout);
    } catch (error) {
      throw new Error(
        `${description} failed (timeout limit ${timeout / 1000}s): ${error.message}`,
        {
          cause: error,
        },
      );
    }
  };
  const list = () => {
    const inventory = JSON.parse(command("xcrun", ["simctl", "list", "--json"]));
    log(
      `Simulator runtimes: ${
        (inventory.runtimes ?? [])
          .map(
            (runtime) =>
              `${runtime.identifier} (${runtime.isAvailable ? "available" : "unavailable"})`,
          )
          .join(", ") || "none"
      }.`,
    );
    return inventory;
  };
  let inventory = list();
  for (const [platform, minimumMajor] of [
    ["iOS", MIN_IOS_MAJOR],
    ["watchOS", MIN_WATCH_MAJOR],
  ]) {
    if (availableRuntimes(inventory, platform, minimumMajor).length) continue;
    log(`No compatible ${platform} simulator runtime; downloading it for the selected Xcode.`);
    command("xcodebuild", ["-downloadPlatform", platform], 15 * 60_000);
    inventory = list();
    if (!availableRuntimes(inventory, platform, minimumMajor).length) {
      throw new Error(
        `No available ${platform} simulator runtime after download: ${JSON.stringify(inventory.runtimes)}`,
      );
    }
  }
  const runtimes = availableRuntimes(inventory, "iOS", MIN_IOS_MAJOR);
  let device;
  let runtime;
  for (const candidate of runtimes) {
    const phones = (inventory.devices?.[candidate.identifier] ?? []).filter(
      (item) =>
        item.isAvailable === true && item.name?.startsWith("iPhone") && UUID.test(item.udid),
    );
    device = phones.find((item) => item.name === "iPhone 17") ?? phones[0];
    if (device) {
      runtime = candidate;
      break;
    }
  }
  if (!device) {
    runtime = runtimes[0];
    const supported = runtime.supportedDeviceTypes?.map((type) => type.identifier);
    const types = (inventory.devicetypes ?? []).filter(
      (type) =>
        type.name?.startsWith("iPhone") && (!supported || supported.includes(type.identifier)),
    );
    const type = types.find((item) => item.name === "iPhone 17") ?? types.at(-1);
    if (!type) throw new Error(`No compatible iPhone simulator type for ${runtime.identifier}`);
    const udid = command("xcrun", [
      "simctl",
      "create",
      "iPhone — Omnesis CI",
      type.identifier,
      runtime.identifier,
    ]);
    if (!UUID.test(udid)) throw new Error("Simulator creation returned no valid UDID");
    device = { udid, state: "Shutdown" };
  }
  log(`Preparing iPhone simulator ${device.udid} (${runtime.identifier}).`);
  if (device.state !== "Booted") command("xcrun", ["simctl", "boot", device.udid]);
  command("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  const ready = list();
  const selected = ready.devices?.[runtime.identifier]?.find((item) => item.udid === device.udid);
  if (
    selected?.isAvailable !== true ||
    selected.state !== "Booted" ||
    !availableRuntimes(ready, "iOS", MIN_IOS_MAJOR).some(
      (item) => item.identifier === runtime.identifier,
    )
  ) {
    throw new Error(`Simulator did not become available and booted: ${JSON.stringify(selected)}`);
  }
  return device.udid;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${prepareIOSSimulator()}\n`);
  } catch (error) {
    process.stderr.write(`iOS simulator setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
