// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  rebindLaunchdExecutable,
  rebindSystemdExecutable,
  serviceConfigDir,
  serviceGatewayBind,
  serviceGatewayPort,
  serviceUnitReferencesPath,
} from "./rebind.js";
import { generateLaunchdPlist, generateSystemdUnit } from "./units.js";
import type { ServiceSpec } from "./types.js";

const source = "/home/maya/.local/bin/omnesis";
const packageBin = "/home/maya/.npm-global/bin/omnesis";

function spec(): ServiceSpec {
  return {
    component: "gateway",
    configDir: "/srv/omnesis config",
    exec: [source, "gateway", "serve"],
    env: {
      OMNESIS_CONFIG_DIR: "/srv/omnesis config",
      OMNESIS_GATEWAY_PORT: "17600",
      CUSTOM_VALUE: "kept exactly",
    },
    credentials: [{ name: "omnesis-keyring-passphrase", path: "/secure/key file" }],
    logsDir: "/var/log/omnesis",
  };
}

describe("serviceConfigDir", () => {
  it("reads quoted systemd and escaped launchd config paths", () => {
    expect(serviceConfigDir("linux", generateSystemdUnit(spec()))).toBe("/srv/omnesis config");
    expect(serviceConfigDir("darwin", generateLaunchdPlist(spec()))).toBe("/srv/omnesis config");
  });
});

describe("rebindSystemdExecutable", () => {
  it("changes only ExecStart's executable and preserves custom unit bytes", () => {
    const before = generateSystemdUnit(spec());
    const after = rebindSystemdExecutable(before, source, packageBin);
    expect(after).toBe(before.replace(`ExecStart=${source}`, `ExecStart=${packageBin}`));
    expect(after).toContain('Environment="CUSTOM_VALUE=kept exactly"');
    expect(after).toContain("LoadCredential=omnesis-keyring-passphrase:/secure/key file");
  });

  it("is idempotent after the executable has already moved", () => {
    const moved = rebindSystemdExecutable(generateSystemdUnit(spec()), source, packageBin);
    expect(rebindSystemdExecutable(moved, source, packageBin)).toBe(moved);
  });

  it("refuses a foreign or ambiguous ExecStart", () => {
    const before = generateSystemdUnit(spec());
    expect(() =>
      rebindSystemdExecutable(before.replace(source, "/opt/other"), source, packageBin),
    ).toThrow(/expected ExecStart/u);
    expect(() =>
      rebindSystemdExecutable(
        before.replace("[Install]", `ExecStart=${source} collector run\n\n[Install]`),
        source,
        packageBin,
      ),
    ).toThrow(/one expected ExecStart/u);
  });

  it.each(["EnvironmentFile", "PassEnvironment", "UnsetEnvironment"])(
    "refuses an external %s environment source",
    (directive) => {
      const before = `${generateSystemdUnit(spec())}\n[Service]\n${directive}=OMNESIS_GATEWAY_PORT\n`;
      expect(() => rebindSystemdExecutable(before, source, packageBin)).toThrow(
        new RegExp(directive, "u"),
      );
    },
  );

  it.each([
    '  Environment = "OMNESIS_CONFIG_DIR=/other"',
    'Environment="OMNESIS_CONFIG_DIR=/other" "OMNESIS_GATEWAY_PORT=17601"',
  ])("refuses non-canonical Environment syntax: %s", (environment) => {
    const before = generateSystemdUnit(spec()).replace("ExecStart=", `${environment}\nExecStart=`);
    expect(() => rebindSystemdExecutable(before, source, packageBin)).toThrow(
      /unsupported Environment syntax/u,
    );
  });
});

describe("rebindLaunchdExecutable", () => {
  it("changes only ProgramArguments[0] and preserves environment bytes", () => {
    const before = generateLaunchdPlist(spec());
    const after = rebindLaunchdExecutable(before, source, packageBin);
    expect(after).toBe(
      before.replace(`<string>${source}</string>`, `<string>${packageBin}</string>`),
    );
    expect(after).toContain("<key>CUSTOM_VALUE</key>\n      <string>kept exactly</string>");
  });

  it("is idempotent and refuses a foreign first argument", () => {
    const before = generateLaunchdPlist(spec());
    const moved = rebindLaunchdExecutable(before, source, packageBin);
    expect(rebindLaunchdExecutable(moved, source, packageBin)).toBe(moved);
    expect(() =>
      rebindLaunchdExecutable(before.replace(source, "/opt/other"), source, packageBin),
    ).toThrow(/expected source launcher/u);
    expect(() =>
      rebindLaunchdExecutable(
        before.replace(
          `<string>${source}</string>`,
          `<string>/bin/sh</string>\n      <string>${source}</string>`,
        ),
        source,
        packageBin,
      ),
    ).toThrow(/ProgramArguments\[0\]/u);
  });

  it.each(["Program", "BundleProgram"])("refuses a launchd %s override", (key) => {
    const before = generateLaunchdPlist(spec()).replace(
      "<key>ProgramArguments</key>",
      `<key>${key}</key>\n  <string>/opt/foreign</string>\n  <key>ProgramArguments</key>`,
    );
    expect(() => rebindLaunchdExecutable(before, source, packageBin)).toThrow(/program override/u);
  });
});

describe("serviceGatewayPort", () => {
  it("reads preserved systemd and launchd environment values", () => {
    expect(serviceGatewayPort("linux", generateSystemdUnit(spec()))).toBe(17600);
    expect(serviceGatewayPort("darwin", generateLaunchdPlist(spec()))).toBe(17600);
  });

  it("uses the gateway default when a unit has no override", () => {
    const withoutPort = spec();
    delete withoutPort.env.OMNESIS_GATEWAY_PORT;
    expect(serviceGatewayPort("linux", generateSystemdUnit(withoutPort))).toBe(7600);
  });

  it("falls back to the config environment and prefers a unit override", () => {
    const withoutPort = spec();
    delete withoutPort.env.OMNESIS_GATEWAY_PORT;
    expect(
      serviceGatewayPort("linux", generateSystemdUnit(withoutPort), "OMNESIS_GATEWAY_PORT=17601\n"),
    ).toBe(17601);
    expect(
      serviceGatewayPort("linux", generateSystemdUnit(spec()), "OMNESIS_GATEWAY_PORT=17601\n"),
    ).toBe(17600);
  });

  it("matches the runtime's first-write-wins config parsing", () => {
    const withoutPort = spec();
    delete withoutPort.env.OMNESIS_GATEWAY_PORT;
    expect(
      serviceGatewayPort(
        "linux",
        generateSystemdUnit(withoutPort),
        "OMNESIS_GATEWAY_PORT=17600\nOMNESIS_GATEWAY_PORT=17601\n",
      ),
    ).toBe(17600);
  });
});

describe("serviceGatewayBind", () => {
  it("falls back to the config environment and prefers a unit override", () => {
    const withoutBind = spec();
    expect(
      serviceGatewayBind("linux", generateSystemdUnit(withoutBind), "OMNESIS_BIND=192.0.2.10\n"),
    ).toBe("192.0.2.10");
    withoutBind.env.OMNESIS_BIND = "127.0.0.1";
    expect(
      serviceGatewayBind("linux", generateSystemdUnit(withoutBind), "OMNESIS_BIND=192.0.2.10\n"),
    ).toBe("127.0.0.1");
  });
});

describe("serviceUnitReferencesPath", () => {
  it("finds a systemd-escaped checkout prefix inside a descendant argument", () => {
    expect(
      serviceUnitReferencesPath(
        "linux",
        'WorkingDirectory="/home/maya/a %%/source/tool"\n',
        "/home/maya/a %/source",
      ),
    ).toBe(true);
  });

  it("finds an XML-escaped checkout prefix inside a launchd descendant", () => {
    expect(
      serviceUnitReferencesPath(
        "darwin",
        "<string>/home/maya/a &amp; b/source/tool</string>",
        "/home/maya/a & b/source",
      ),
    ).toBe(true);
  });
});
