// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { prepareIOSSimulator } from "./ci/prepare-ios-simulator.mjs";
import { waitForIOSDestination } from "./ci/wait-ios-destination.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const spec = parse(read("ios/project.yml"));

function baseIdentity(localConfig = "") {
  const config = read("ios/Config.xcconfig").replace('#include? "Local.xcconfig"', localConfig);
  const definitions = [...config.matchAll(/^OMNESIS_BUNDLE_ID\s*=\s*([^\s/]+)\s*$/gm)];
  return definitions.at(-1)?.[1];
}

function expanded(value, base) {
  return value.replaceAll("$(OMNESIS_BUNDLE_ID)", base);
}

function plistValue(path, key) {
  const xml = read(path);
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  expect(match, `${path} has ${key}`).not.toBeNull();
  return match[1];
}

/**
 * A target's base build setting, resolving the XcodeGen templates it uses:
 * the target's own setting wins, then its templates' with their
 * `${attribute}` placeholders filled from `templateAttributes`.
 */
function targetSetting(target, key) {
  const definition = spec.targets[target];
  const own = definition?.settings?.base?.[key];
  if (own !== undefined) return own;
  for (const name of definition?.templates ?? []) {
    const value = spec.targetTemplates[name]?.settings?.base?.[key];
    if (value === undefined) continue;
    return value.replace(/\$\{(\w+)\}/g, (_, attribute) =>
      attribute === "target_name" ? target : definition.templateAttributes[attribute],
    );
  }
  return undefined;
}

function targetIdentity(target, base) {
  const configured = targetSetting(target, "PRODUCT_BUNDLE_IDENTIFIER");
  return expanded(configured ?? spec.settings.base.PRODUCT_BUNDLE_IDENTIFIER, base);
}

describe("iOS build identities", () => {
  it.each([
    ["official", "", "dev.omnesis.ios"],
    ["independent", "OMNESIS_BUNDLE_ID = com.example.myomnesis", "com.example.myomnesis"],
  ])("expands the %s base across every target and companion relationship", (_, local, base) => {
    expect(baseIdentity(local)).toBe(base);
    const appTargets = [
      "Omnesis",
      "OmnesisDemo",
      "OmnesisNotificationService",
      "OmnesisWidgets",
      "OmnesisWatch",
      "OmnesisWatchWidgets",
      "OmnesisDemoWatch",
      "OmnesisDemoWatchWidgets",
    ];
    const identities = Object.fromEntries(
      appTargets.map((target) => [target, targetIdentity(target, base)]),
    );
    expect(identities).toEqual({
      Omnesis: base,
      OmnesisDemo: `${base}.demo`,
      OmnesisNotificationService: `${base}.notification-service`,
      OmnesisWidgets: `${base}.widgets`,
      OmnesisWatch: `${base}.watchkitapp`,
      OmnesisWatchWidgets: `${base}.watchkitapp.widgets`,
      OmnesisDemoWatch: `${base}.demo.watchkitapp`,
      OmnesisDemoWatchWidgets: `${base}.demo.watchkitapp.widgets`,
    });
    // Each watch app pairs with the iPhone app that embeds it.
    expect(
      plistValue("ios/Sources/OmnesisWatch/Info.plist", "WKCompanionAppBundleIdentifier"),
    ).toBe("$(OMNESIS_WATCH_COMPANION_BUNDLE_ID)");
    for (const [watch, phone] of [
      ["OmnesisWatch", "Omnesis"],
      ["OmnesisDemoWatch", "OmnesisDemo"],
    ]) {
      expect(expanded(targetSetting(watch, "OMNESIS_WATCH_COMPANION_BUNDLE_ID"), base)).toBe(
        identities[phone],
      );
      expect(spec.targets[phone].dependencies.map((dependency) => dependency.target)).toContain(
        watch,
      );
    }
    expect(plistValue("ios/Info.plist", "CFBundleIdentifier")).toBe("$(PRODUCT_BUNDLE_IDENTIFIER)");
    expect(plistValue("ios/Info-Demo.plist", "CFBundleIdentifier")).toBe(
      "$(PRODUCT_BUNDLE_IDENTIFIER)",
    );
  });

  it.each(["dev.omnesis.ios", "com.example.myomnesis"])(
    "keeps the app and notification extension on the same shared Keychain group for %s",
    (base) => {
      const shared = `${base}.notifications`;
      const production = read("ios/Omnesis.entitlements");
      const demo = read("ios/Omnesis-Demo.entitlements");
      const service = read("ios/OmnesisNotificationService.entitlements");
      const group = (xml) =>
        [...xml.matchAll(/<string>\$\(AppIdentifierPrefix\)([^<]+)<\/string>/g)].map((match) =>
          expanded(match[1], base),
        );
      expect(group(production)).toEqual([base, shared]);
      expect(group(demo)).toEqual([`${base}.demo`]);
      expect(group(service)).toEqual([shared]);
      expect(expanded(plistValue("ios/Info.plist", "OmnesisKeychainAccessGroup"), base)).toBe(
        `$(AppIdentifierPrefix)${shared}`,
      );
      expect(
        expanded(
          plistValue(
            "ios/Sources/OmnesisNotificationService/Info.plist",
            "OmnesisKeychainAccessGroup",
          ),
          base,
        ),
      ).toBe(`$(AppIdentifierPrefix)${shared}`);
    },
  );

  it("declares the signed APNs environment per configuration", () => {
    expect(spec.settings.configs.Debug.OMNESIS_APNS_ENVIRONMENT).toBe("development");
    expect(spec.settings.configs.Release.OMNESIS_APNS_ENVIRONMENT).toBe("production");
    expect(plistValue("ios/Omnesis.entitlements", "aps-environment")).toBe(
      "$(OMNESIS_APNS_ENVIRONMENT)",
    );
    expect(plistValue("ios/Omnesis-Demo.entitlements", "aps-environment")).toBe(
      "$(OMNESIS_APNS_ENVIRONMENT)",
    );
  });

  it("registers the watch complication link scheme the watch app parses", () => {
    const swift = read("ios/Sources/Omnesis/Intents/WatchComplication.swift");
    const scheme = swift.match(/static let scheme = "([^"]+)"/)?.[1];
    expect(scheme).toBeTruthy();
    const plist = read("ios/Sources/OmnesisWatch/Info.plist");
    const schemes = plist.match(
      /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    expect(schemes).toBe(scheme);
  });
});

// Exercise the production xcrun/xcodebuild command seam without owning a real
// simulator. Inventory mutations model the effects of installation and boot.
describe("hosted iOS simulator preparation", () => {
  const ios = "com.apple.CoreSimulator.SimRuntime.iOS-26-6";
  const watch = "com.apple.CoreSimulator.SimRuntime.watchOS-26-6";
  const phone = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
  const udid = "00000000-0000-0000-0000-000000000017";
  const device = (state = "Shutdown") => ({ name: "iPhone 17", udid, isAvailable: true, state });
  const inventory = () => ({
    runtimes: [
      { identifier: ios, version: "26.6", isAvailable: true },
      { identifier: watch, version: "26.6", isAvailable: true },
    ],
    devicetypes: [{ name: "iPhone 17", identifier: phone }],
    devices: { [ios]: [device()] },
  });

  function prepare(data, override) {
    const calls = [];
    const run = (command, args, timeout) => {
      calls.push({ command, args, timeout });
      const custom = override?.(command, args, data);
      if (custom !== undefined) return custom;
      if (command === "xcodebuild") {
        const platform = args[1];
        data.runtimes.push({
          identifier: platform === "iOS" ? ios : watch,
          version: "26.6",
          isAvailable: true,
        });
        return "Downloaded";
      }
      switch (args[1]) {
        case "list":
          return JSON.stringify(data);
        case "create":
          data.devices[ios] = [{ ...device(), name: "iPhone — Omnesis CI" }];
          return udid;
        case "boot":
          data.devices[ios][0].state = "Booted";
          return "";
        case "bootstatus":
          return "";
        default:
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      }
    };
    return { result: prepareIOSSimulator({ run, log: () => {} }), calls };
  }

  it("keeps minimum runtime versions aligned with the app and Watch deployment targets", () => {
    const helper = read("scripts/ci/prepare-ios-simulator.mjs");
    expect(Number(helper.match(/MIN_IOS_MAJOR = (\d+)/)[1])).toBe(
      Number(spec.options.deploymentTarget.iOS.split(".")[0]),
    );
    expect(Number(helper.match(/MIN_WATCH_MAJOR = (\d+)/)[1])).toBe(
      Number(spec.targetTemplates.WatchApp.deploymentTarget.split(".")[0]),
    );
  });

  it("boots and verifies an existing phone without downloading or creating anything", () => {
    const { result, calls } = prepare(inventory());
    expect(result).toBe(udid);
    expect(calls.map(({ args }) => args[1])).toEqual(["list", "boot", "bootstatus", "list"]);
    expect(calls.find(({ args }) => args[1] === "bootstatus").timeout).toBe(300_000);
  });

  it("allows cold CoreSimulator inventory and boot commands up to five bounded minutes", () => {
    const { calls } = prepare(inventory());
    expect(
      calls.filter(({ command }) => command === "xcrun").map(({ timeout }) => timeout),
    ).toEqual([300_000, 300_000, 300_000, 300_000]);
  });

  it("identifies the command and deadline when initial inventory times out", () => {
    const messages = [];
    const run = () => {
      throw new Error("spawnSync xcrun ETIMEDOUT");
    };
    expect(() => prepareIOSSimulator({ run, log: (message) => messages.push(message) })).toThrow(
      "xcrun simctl list --json failed (timeout limit 300s): spawnSync xcrun ETIMEDOUT",
    );
    expect(messages).toEqual(["Running xcrun simctl list --json (timeout 300s)."]);
  });

  it("waits for an already booted phone without attempting to boot it again", () => {
    const data = inventory();
    data.devices[ios] = [device("Booted")];
    expect(prepare(data).calls.map(({ args }) => args[1])).toEqual(["list", "bootstatus", "list"]);
  });

  it("creates a phone when the installed runtime has no registered devices", () => {
    const data = inventory();
    data.devices = {};
    const { calls } = prepare(data);
    expect(calls.find(({ args }) => args[1] === "create").args).toEqual([
      "simctl",
      "create",
      "iPhone — Omnesis CI",
      phone,
      ios,
    ]);
    expect(calls.some(({ command }) => command === "xcodebuild")).toBe(false);
  });

  it("reuses its own created phone on a later preparation call", () => {
    const data = inventory();
    data.devices = {};
    prepare(data);
    expect(prepare(data).calls.map(({ args }) => args[1])).toEqual(["list", "bootstatus", "list"]);
  });

  it.each(["iOS", "watchOS"])(
    "installs only the missing %s runtime then verifies it",
    (platform) => {
      const data = inventory();
      data.runtimes = data.runtimes.filter((item) => !item.identifier.includes(`.${platform}-`));
      const { calls } = prepare(data);
      expect(calls.filter(({ command }) => command === "xcodebuild")).toEqual([
        { command: "xcodebuild", args: ["-downloadPlatform", platform], timeout: 900_000 },
      ]);
    },
  );

  it("does not select unavailable or pre-deployment runtimes", () => {
    const data = inventory();
    data.runtimes[0].version = "16.4";
    data.runtimes[0].identifier = "com.apple.CoreSimulator.SimRuntime.iOS-16-4";
    data.runtimes.push({
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      version: "27.0",
      isAvailable: false,
    });
    expect(prepare(data).calls.some(({ command }) => command === "xcodebuild")).toBe(true);
  });

  it("propagates installation failures without exporting a destination", () => {
    const data = inventory();
    data.runtimes = [];
    expect(() =>
      prepare(data, (command) => {
        if (command === "xcodebuild") throw new Error("Runtime download failed");
      }),
    ).toThrow("Runtime download failed");
  });

  it("fails loudly when runtime installation does not register an available runtime", () => {
    const data = inventory();
    data.runtimes = [];
    expect(() =>
      prepare(data, (command) =>
        command === "xcodebuild" ? "Downloaded but unusable" : undefined,
      ),
    ).toThrow("No available iOS simulator runtime after download");
  });

  it("fails rather than exporting an unavailable or unbooted destination", () => {
    const data = inventory();
    expect(() => prepare(data, (_, args) => (args[1] === "boot" ? "" : undefined))).toThrow(
      "Simulator did not become available and booted",
    );
  });

  it("propagates boot failures without running tests on another simulator", () => {
    expect(() =>
      prepare(inventory(), (_, args) => {
        if (args[1] === "boot") throw new Error("Boot failed");
      }),
    ).toThrow("Boot failed");
  });

  it("validates the created identity and chooses a runtime-compatible iPhone type", () => {
    const data = inventory();
    data.devices = {};
    const supportedPhone = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
    data.runtimes[0].supportedDeviceTypes = [{ identifier: supportedPhone }];
    data.devicetypes.push({ name: "iPhone 16", identifier: supportedPhone });
    expect(prepare(data).calls.find(({ args }) => args[1] === "create").args[3]).toBe(
      supportedPhone,
    );
    expect(() =>
      prepare(inventory(), (_, args) =>
        args[1] === "list"
          ? JSON.stringify({ ...inventory(), devices: {} })
          : args[1] === "create"
            ? "not-a-uuid"
            : undefined,
      ),
    ).toThrow("Simulator creation returned no valid UDID");
  });

  it("wires every hosted iOS lane to preparation and an exact destination", () => {
    const workflow = parse(read(".github/workflows/ios.yml"));
    for (const [job, variable] of [
      ["build-and-test", "IOS_DESTINATION"],
      ["live-gateway-e2e", "OMNESIS_E2E_DEST"],
    ]) {
      const steps = workflow.jobs[job].steps;
      const setup = steps.findIndex((step) =>
        step.run?.includes("node scripts/ci/prepare-ios-simulator.mjs"),
      );
      expect(setup).toBeGreaterThan(0);
      expect(steps[setup].run).toContain(`${variable}=platform=iOS Simulator,id=$udid`);
      expect(setup).toBeLessThan(steps.findIndex((step) => step.name?.startsWith("lane [")));
      expect(workflow.jobs[job].env?.[variable]).toBeUndefined();
    }
    const journeys = parse(read(".github/workflows/mobile-journeys.yml")).jobs.ios.steps;
    expect(journeys.find((step) => step.name === "Prepare iPhone simulator").run).toContain(
      "OMNESIS_JOURNEY_IOS_UDID=$udid",
    );
    expect(read("scripts/run-mobile-journeys.sh")).toContain('udid="$OMNESIS_JOURNEY_IOS_UDID"');
  });
});

describe("Xcode simulator destination discovery", () => {
  const udid = "00000000-0000-0000-0000-000000000017";
  const destination = `platform=iOS Simulator,id=${udid}`;
  const heading = 'Available destinations for the "Omnesis" scheme:';
  const phone = `{ platform:iOS Simulator, arch:arm64, id:${udid}, OS:26.5, name:iPhone 17 }`;
  const placeholder =
    "{ platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS simulator }";

  function discovery(outputs, options = {}) {
    let elapsed = 0;
    const calls = [];
    const logs = [];
    return {
      calls,
      logs,
      elapsed: () => elapsed,
      invoke: () =>
        waitForIOSDestination({
          destination,
          timeoutMs: 5000,
          packageFlags: [
            "-clonedSourcePackagesDirPath",
            "build/packages",
            "-disableAutomaticPackageResolution",
          ],
          run: (command, args, timeout) => {
            calls.push({ command, args, timeout });
            const output = outputs[Math.min(calls.length - 1, outputs.length - 1)];
            if (output instanceof Error) throw output;
            return output;
          },
          now: () => elapsed,
          wait: (milliseconds) => {
            elapsed += milliseconds;
          },
          log: (message) => logs.push(message),
          ...options,
        }),
    };
  }

  it("waits for a concrete eligible phone after Xcode initially lists placeholders", () => {
    const check = discovery([`${heading}\n${placeholder}`, `${heading}\n${phone}`]);
    check.invoke();
    expect(check.calls).toHaveLength(2);
    expect(check.elapsed()).toBe(2000);
    expect(check.calls[0]).toEqual({
      command: "xcodebuild",
      args: [
        "-project",
        "Omnesis.xcodeproj",
        "-scheme",
        "Omnesis",
        "-showdestinations",
        "-clonedSourcePackagesDirPath",
        "build/packages",
        "-disableAutomaticPackageResolution",
      ],
      timeout: 5000,
    });
    expect(check.calls[1].timeout).toBe(3000);
  });

  it("bounds absent destinations by wall time and preserves the final inventory", () => {
    const inventory = `${heading}\n${placeholder}`;
    const check = discovery([inventory]);
    expect(check.invoke).toThrow("within 5s");
    expect(check.elapsed()).toBe(5000);
    expect(check.calls.map((call) => call.timeout)).toEqual([5000, 3000, 1000]);
    expect(check.logs.at(-1)).toContain(inventory);
  });

  it("does not accept the selected UDID from ineligible destinations", () => {
    const check = discovery([
      `${heading}\n${placeholder}\nIneligible destinations for the "Omnesis" scheme:\n${phone}`,
    ]);
    expect(check.invoke).toThrow("did not discover eligible destination");
  });

  it("honors explicit name, OS and architecture selectors", () => {
    const check = discovery(
      [
        `${heading}\n${phone.replace("26.5", "26.4")}`,
        `${heading}\n${phone.replace("arm64", "x86_64")}`,
        `${heading}\n${phone}`,
      ],
      { destination: "platform=iOS Simulator,name=iPhone 17,OS=26.5,arch=arm64" },
    );
    check.invoke();
    expect(check.calls).toHaveLength(3);
  });

  it("caps slow discovery probes and includes probe failure diagnostics", () => {
    let elapsed = 0;
    const check = discovery([], {
      timeoutMs: 35000,
      now: () => elapsed,
      wait: (milliseconds) => {
        elapsed += milliseconds;
      },
      run: (_command, _args, timeout) => {
        expect(timeout).toBe(elapsed === 0 ? 30000 : 3000);
        elapsed += timeout;
        const error = new Error("discovery probe timed out");
        error.stderr = "CoreSimulator discovery unavailable";
        throw error;
      },
    });
    expect(check.invoke).toThrow("within 35s");
    expect(elapsed).toBe(35000);
    expect(check.logs.at(-1)).toContain("CoreSimulator discovery unavailable");
  });
});

it("rejects OS=latest before probing instead of accepting an older phone", () => {
  expect(() =>
    waitForIOSDestination({
      destination: "platform=iOS Simulator,name=iPhone 17,OS=latest",
      run: () => {
        throw new Error("must not probe");
      },
    }),
  ).toThrow("Use a concrete OS version");
});

// Run the actual wrapper through startup failure without Xcode or a gateway.
// Child stubs record whether readiness failure cleans up and preserves evidence.
describe("iOS live gateway startup", () => {
  function failedStartup({ destination, simulatorFails = false, discoveryFails = false } = {}) {
    const fixture = mkdtempSync(join(tmpdir(), "ios-e2e-startup-"));
    try {
      const scripts = join(fixture, "scripts");
      const bin = join(fixture, "bin");
      const config = join(fixture, "config");
      const calls = join(fixture, "calls");
      mkdirSync(scripts);
      mkdirSync(join(scripts, "ci"));
      mkdirSync(join(fixture, "ios"));
      mkdirSync(bin);
      copyFileSync(join(root, "scripts/run-ios-e2e.sh"), join(scripts, "run-ios-e2e.sh"));
      function executable(path, source) {
        writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${source}`);
        chmodSync(path, 0o755);
      }
      executable(
        join(bin, "node"),
        `
        if [[ "$1" == */wait-ios-destination.mjs ]]; then
          echo "discover:$2" >> "$TEST_CALLS"
          ${discoveryFails ? "exit 71" : "exit 0"}
        fi
        echo "prepare:$*" >> "$TEST_CALLS"
        ${simulatorFails ? "exit 70" : 'echo "00000000-0000-0000-0000-000000000017"'}
      `,
      );
      executable(join(bin, "xcodegen"), 'echo "project" >> "$TEST_CALLS"');
      executable(join(scripts, "ci/resolve-ios-packages.sh"), 'echo "packages" >> "$TEST_CALLS"');
      executable(
        join(scripts, "synth-gateway.sh"),
        `
        echo "$1:$OMNESIS_SYNTH_READY_TIMEOUT" >> "$TEST_CALLS"
        if [[ "$1" == start ]]; then
          mkdir -p "$OMNESIS_CONFIG_DIR/logs"
          echo "synthetic startup diagnostic" > "$OMNESIS_CONFIG_DIR/logs/gateway.stdout.log"
          echo "SYNTH_GATEWAY_NOT_READY" >&2
          exit 23
        fi
      `,
      );
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OMNESIS_CONFIG_DIR: config,
        OMNESIS_SYNTH_READY_TIMEOUT: "300",
        TEST_CALLS: calls,
      };
      delete env.OMNESIS_E2E_DEST;
      if (destination) env.OMNESIS_E2E_DEST = destination;
      const result = spawnSync("bash", [join(scripts, "run-ios-e2e.sh")], {
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      return {
        ...result,
        calls: readFileSync(calls, "utf8").trim().split("\n"),
        log:
          simulatorFails || discoveryFails
            ? undefined
            : readFileSync(join(config, "logs/gateway.stdout.log"), "utf8"),
      };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("resolves an available iPhone before startup and cleans up failed startup", () => {
    const result = failedStartup();
    expect(result.status).toBe(1);
    expect(result.calls[0]).toMatch(/prepare:.*scripts\/ci\/prepare-ios-simulator.mjs$/);
    expect(result.calls.slice(1)).toEqual([
      "project",
      "packages",
      "discover:platform=iOS Simulator,id=00000000-0000-0000-0000-000000000017",
      "start:300",
      "stop:300",
    ]);
    expect(result.stderr).toContain("SYNTH_GATEWAY_NOT_READY");
    expect(result.stderr).toContain("synthetic startup diagnostic");
    expect(result.log).toBe("synthetic startup diagnostic\n");
  });

  it("honors a destination already prepared by CI", () => {
    const result = failedStartup({
      destination: "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000018",
    });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      "project",
      "packages",
      "discover:platform=iOS Simulator,id=00000000-0000-0000-0000-000000000018",
      "start:300",
      "stop:300",
    ]);
  });

  it("does not spawn a gateway when simulator preparation fails", () => {
    const result = failedStartup({ simulatorFails: true });
    expect(result.status).toBe(70);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatch(/^prepare:/);
  });

  it("does not spawn a gateway when Xcode cannot discover the prepared phone", () => {
    const result = failedStartup({ discoveryFails: true });
    expect(result.status).toBe(71);
    expect(result.calls.map((call) => call.split(":")[0])).toEqual([
      "prepare",
      "project",
      "packages",
      "discover",
    ]);
  });

  it("allows a cold macOS boot and uploads only failure logs after the live lane", () => {
    const job = parse(read(".github/workflows/ios.yml")).jobs["live-gateway-e2e"];
    expect(job.env.OMNESIS_SYNTH_READY_TIMEOUT).toBe("300");
    const upload = job.steps.find((step) => step.name === "Upload live gateway failure logs");
    expect(job.steps.indexOf(upload)).toBeGreaterThan(
      job.steps.findIndex((step) => step.name === "lane [ios-live-e2e]"),
    );
    expect(upload.if).toBe("failure()");
    expect(upload["continue-on-error"]).toBe(true);
    expect(upload.with.path).toBe("${{ env.OMNESIS_CONFIG_DIR }}/logs/*.log");
    expect(upload.with["retention-days"]).toBe(7);
  });
});
