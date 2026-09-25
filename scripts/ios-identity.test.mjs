// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

function targetIdentity(target, base) {
  const configured = spec.targets[target]?.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER;
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
    });
    expect(
      expanded(
        plistValue("ios/Sources/OmnesisWatch/Info.plist", "WKCompanionAppBundleIdentifier"),
        base,
      ),
    ).toBe(base);
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
