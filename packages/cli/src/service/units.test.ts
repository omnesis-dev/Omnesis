// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  buildServiceSpec,
  darwinLogsDir,
  escapeXml,
  generateLaunchdPlist,
  generateSystemdUnit,
  launchdLabel,
  launchdLogPaths,
  launchdPlistPath,
  systemdUnitName,
  systemdUnitPath,
  MIN_LOAD_CREDENTIAL_SYSTEMD,
  loadCredentialSupportWarning,
  parseSystemdVersion,
} from "./units.js";
import type { ServiceSpec } from "./types.js";

const HOME = "/home/maya";

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    component: "gateway",
    configDir: "/home/maya/.config/omnesis",
    exec: ["/usr/local/bin/omnesis", "gateway", "serve"],
    env: {
      OMNESIS_CONFIG_DIR: "/home/maya/.config/omnesis",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
    logsDir: "/home/maya/Library/Logs/Omnesis",
    ...overrides,
  };
}

describe("unit naming", () => {
  it("launchd label without instance", () => {
    expect(launchdLabel("gateway")).toBe("dev.omnesis.gateway");
    expect(launchdLabel("collector")).toBe("dev.omnesis.collector");
  });

  it("launchd label with instance suffix", () => {
    expect(launchdLabel("gateway", "staging")).toBe("dev.omnesis.gateway.staging");
  });

  it("launchd plist path lands in ~/Library/LaunchAgents", () => {
    expect(launchdPlistPath(HOME, "gateway")).toBe(
      "/home/maya/Library/LaunchAgents/dev.omnesis.gateway.plist",
    );
    expect(launchdPlistPath(HOME, "collector", "staging")).toBe(
      "/home/maya/Library/LaunchAgents/dev.omnesis.collector.staging.plist",
    );
  });

  it("systemd unit name without instance", () => {
    expect(systemdUnitName("gateway")).toBe("omnesis-gateway.service");
  });

  it("systemd unit name with instance suffix", () => {
    expect(systemdUnitName("collector", "staging")).toBe("omnesis-collector-staging.service");
  });

  it("systemd unit path lands in ~/.config/systemd/user", () => {
    expect(systemdUnitPath(HOME, "gateway")).toBe(
      "/home/maya/.config/systemd/user/omnesis-gateway.service",
    );
  });

  it("launchd log paths derive from the label", () => {
    const { out, err } = launchdLogPaths("/logs", "gateway", "staging");
    expect(out).toBe("/logs/dev.omnesis.gateway.staging.log");
    expect(err).toBe("/logs/dev.omnesis.gateway.staging.err.log");
  });
});

describe("buildServiceSpec", () => {
  const base = {
    component: "gateway" as const,
    configDir: "/cfg",
    exec: ["/bin/omnesis", "gateway", "serve"],
    extraEnv: {},
    platform: "linux" as const,
    homeDir: HOME,
    nodeBinDir: "/opt/node/bin",
  };

  it("bakes OMNESIS_CONFIG_DIR and a PATH containing the node bin dir", () => {
    const s = buildServiceSpec(base);
    expect(s.env.OMNESIS_CONFIG_DIR).toBe("/cfg");
    expect(s.env.PATH.startsWith("/opt/node/bin:")).toBe(true);
    expect(s.env.PATH).toContain("/usr/bin");
  });

  it("extra env wins over the defaults", () => {
    const s = buildServiceSpec({
      ...base,
      extraEnv: { PATH: "/custom", OMNESIS_GATEWAY_PORT: "17600" },
    });
    expect(s.env.PATH).toBe("/custom");
    expect(s.env.OMNESIS_GATEWAY_PORT).toBe("17600");
    expect(s.env.OMNESIS_CONFIG_DIR).toBe("/cfg");
  });

  it("uses an OMNESIS_CONFIG_DIR env override as the effective service config dir", () => {
    const s = buildServiceSpec({
      ...base,
      extraEnv: { OMNESIS_CONFIG_DIR: "/srv/omnesis/config" },
    });
    const unit = generateSystemdUnit(s);

    expect(s.configDir).toBe("/srv/omnesis/config");
    expect(unit).toContain("Environment=OMNESIS_CONFIG_DIR=/srv/omnesis/config");
    expect(unit).toContain("ReadWritePaths=/srv/omnesis/config ");
    expect(unit).not.toContain("ReadWritePaths=/cfg ");
  });

  it("uses ~/Library/Logs/Omnesis on darwin", () => {
    const s = buildServiceSpec({ ...base, platform: "darwin" });
    expect(s.logsDir).toBe(darwinLogsDir(HOME));
    expect(s.logsDir).toBe("/home/maya/Library/Logs/Omnesis");
  });

  it("carries the instance only when provided", () => {
    expect(buildServiceSpec(base).instance).toBeUndefined();
    expect(buildServiceSpec({ ...base, instance: "staging" }).instance).toBe("staging");
  });

  it("marks generated user services for privileged lifecycle capability checks", () => {
    const linux = buildServiceSpec({
      ...base,
      extraEnv: { OMNESIS_SERVICE_MANAGER: "forged", OMNESIS_SERVICE_INSTANCE: "forged" },
    });
    expect(linux.env.OMNESIS_SERVICE_MANAGER).toBe("systemd-user");
    expect(linux.env.OMNESIS_SERVICE_INSTANCE).toBeUndefined();

    const darwin = buildServiceSpec({ ...base, platform: "darwin", instance: "staging" });
    expect(darwin.env.OMNESIS_SERVICE_MANAGER).toBe("launchd-user");
    expect(darwin.env.OMNESIS_SERVICE_INSTANCE).toBe("staging");
  });

  it("copies the exec array", () => {
    const exec = ["/bin/omnesis", "gateway", "serve"];
    const s = buildServiceSpec({ ...base, exec });
    exec.push("mutated");
    expect(s.exec).toEqual(["/bin/omnesis", "gateway", "serve"]);
  });

  it("bakes the secret-store backend into the unit env", () => {
    const s = buildServiceSpec({ ...base, secretStore: "passphrase" });
    expect(s.env.OMNESIS_SECRET_STORE).toBe("passphrase");
    expect(generateSystemdUnit(s)).toContain("Environment=OMNESIS_SECRET_STORE=passphrase");
  });

  it("an explicit --env OMNESIS_SECRET_STORE still wins over --secret-store", () => {
    const s = buildServiceSpec({
      ...base,
      secretStore: "passphrase",
      extraEnv: { OMNESIS_SECRET_STORE: "file" },
    });
    expect(s.env.OMNESIS_SECRET_STORE).toBe("file");
  });

  it("wires a passphrase credential into the systemd unit via LoadCredential", () => {
    const s = buildServiceSpec({
      ...base,
      secretStore: "passphrase",
      passphraseCredentialPath: "/etc/omnesis/keyring.pass",
    });
    expect(s.credentials).toEqual([
      { name: "omnesis-keyring-passphrase", path: "/etc/omnesis/keyring.pass" },
    ]);
    const unit = generateSystemdUnit(s);
    expect(unit).toContain("LoadCredential=omnesis-keyring-passphrase:/etc/omnesis/keyring.pass");
    expect(unit).toContain("Environment=OMNESIS_SECRET_STORE=passphrase");
  });

  it("wires a passphrase file into the daemon env, on systemd and launchd", () => {
    const linux = buildServiceSpec({
      ...base,
      secretStore: "passphrase",
      passphraseFilePath: "/etc/omnesis/keyring.pass",
    });
    expect(linux.env.OMNESIS_KEYRING_PASSPHRASE_FILE).toBe("/etc/omnesis/keyring.pass");
    expect(linux.credentials).toBeUndefined();
    expect(generateSystemdUnit(linux)).toContain(
      "Environment=OMNESIS_KEYRING_PASSPHRASE_FILE=/etc/omnesis/keyring.pass",
    );

    const darwin = buildServiceSpec({
      ...base,
      platform: "darwin",
      component: "collector",
      secretStore: "passphrase",
      passphraseFilePath: "/etc/omnesis/keyring.pass",
    });
    const plist = generateLaunchdPlist(darwin);
    // launchd has no credential concept; the passphrase travels as an env var.
    expect(plist).not.toContain("LoadCredential");
    expect(plist).toContain("<key>OMNESIS_KEYRING_PASSPHRASE_FILE</key>");
    expect(plist).toContain("<string>/etc/omnesis/keyring.pass</string>");
  });

  it("a systemd unit without credentials emits no LoadCredential line", () => {
    expect(generateSystemdUnit(buildServiceSpec(base))).not.toContain("LoadCredential");
  });

  it("keeps the user-safe sandbox directives but omits CapabilityBoundingSet", () => {
    const unit = generateSystemdUnit(buildServiceSpec(base));
    // These work in a `systemd --user` service and are kept.
    for (const d of ["NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=read-only"]) {
      expect(unit).toContain(d);
    }
    // Clearing the capability bounding set needs CAP_SETPCAP, which a --user
    // service lacks — it fails the unit with 218/CAPABILITIES on boot.
    expect(unit).not.toContain("CapabilityBoundingSet");
  });
});

describe("escapeXml", () => {
  it("escapes all five XML special characters", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("leaves plain strings untouched", () => {
    expect(escapeXml("/usr/local/bin/omnesis")).toBe("/usr/local/bin/omnesis");
  });
});

describe("generateLaunchdPlist", () => {
  it("renders label, program arguments in order, and supervision keys", () => {
    const plist = generateLaunchdPlist(spec());
    expect(plist).toContain("<string>dev.omnesis.gateway</string>");
    const argsIdx = [
      plist.indexOf("<string>/usr/local/bin/omnesis</string>"),
      plist.indexOf("<string>gateway</string>"),
      plist.indexOf("<string>serve</string>"),
    ];
    expect(argsIdx.every((i) => i > 0)).toBe(true);
    expect(argsIdx).toEqual([...argsIdx].sort((a, b) => a - b));
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
    // Restart on a crash, stay stopped after a clean exit — the launchd
    // spelling of the systemd unit's `Restart=on-failure`, so a daemon that
    // stops deliberately is not relooped every ThrottleInterval.
    expect(plist).toContain(
      "<key>KeepAlive</key>\n    <dict>\n      <key>SuccessfulExit</key>\n      <false/>\n    </dict>",
    );
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
    // Longer than the gateway's 60 s shutdown budget, so launchd never
    // SIGKILLs a daemon that is still closing its stores.
    expect(plist).toContain("<key>ExitTimeOut</key>\n    <integer>90</integer>");
    expect(plist).toContain("<key>ProcessType</key>\n    <string>Background</string>");
    expect(plist).toContain("<key>Umask</key>\n    <integer>63</integer>");
  });

  it("renders the environment dict", () => {
    const plist = generateLaunchdPlist(
      spec({ env: { OMNESIS_CONFIG_DIR: "/cfg", OMNESIS_GATEWAY_PORT: "17600" } }),
    );
    expect(plist).toContain("<key>OMNESIS_CONFIG_DIR</key>\n      <string>/cfg</string>");
    expect(plist).toContain("<key>OMNESIS_GATEWAY_PORT</key>\n      <string>17600</string>");
  });

  it("points stdout/stderr at per-label files under logsDir", () => {
    const plist = generateLaunchdPlist(spec({ instance: "staging" }));
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n    <string>/home/maya/Library/Logs/Omnesis/dev.omnesis.gateway.staging.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n    <string>/home/maya/Library/Logs/Omnesis/dev.omnesis.gateway.staging.err.log</string>",
    );
  });

  it("suffixes the label with the instance", () => {
    const plist = generateLaunchdPlist(spec({ instance: "staging" }));
    expect(plist).toContain("<string>dev.omnesis.gateway.staging</string>");
  });

  it("XML-escapes exec args and env values", () => {
    const plist = generateLaunchdPlist(
      spec({
        exec: ["/opt/dir with <amp>&/omnesis", "gateway", "serve"],
        env: { OMNESIS_NOTE: `quotes " and ' here` },
      }),
    );
    expect(plist).toContain("<string>/opt/dir with &lt;amp&gt;&amp;/omnesis</string>");
    expect(plist).toContain("<string>quotes &quot; and &apos; here</string>");
    expect(plist).not.toContain("<amp>");
  });

  it("is valid-looking XML with matching plist envelope", () => {
    const plist = generateLaunchdPlist(spec());
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
  });
});

describe("generateSystemdUnit", () => {
  it("renders all three sections with the documented keys", () => {
    const unit = generateSystemdUnit(spec());
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=Omnesis gateway");
    expect(unit).toContain("Documentation=https://github.com/omnesis-dev/Omnesis");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/local/bin/omnesis gateway serve");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=2");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("PrivateTmp=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=read-only");
    expect(unit).toContain(
      "ReadWritePaths=/home/maya/.config/omnesis /home/maya/Library/Logs/Omnesis",
    );
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("renders Environment lines for every env entry", () => {
    const unit = generateSystemdUnit(
      spec({ env: { OMNESIS_CONFIG_DIR: "/cfg", OMNESIS_GATEWAY_PORT: "17600" } }),
    );
    expect(unit).toContain("Environment=OMNESIS_CONFIG_DIR=/cfg");
    expect(unit).toContain("Environment=OMNESIS_GATEWAY_PORT=17600");
  });

  it("allows explicit data and log-file directories through systemd write hardening", () => {
    const unit = generateSystemdUnit(
      spec({
        env: {
          OMNESIS_CONFIG_DIR: "/cfg",
          OMNESIS_DB_PATH: "/srv/omnesis/omnesis.db",
          OMNESIS_INDEX_DB_PATH: "/srv/omnesis/index/index.db",
          OMNESIS_ANALYTICS_DB_PATH: "/srv/omnesis/analytics/analytics.db",
          OMNESIS_LOG_FILE: "/var/log/omnesis/gateway.log",
        },
      }),
    );
    expect(unit).toContain(
      "ReadWritePaths=/home/maya/.config/omnesis /home/maya/Library/Logs/Omnesis /srv/omnesis /srv/omnesis/index /srv/omnesis/analytics /var/log/omnesis",
    );
  });

  it("mentions the instance in the description", () => {
    const unit = generateSystemdUnit(spec({ instance: "staging" }));
    expect(unit).toContain("Description=Omnesis gateway (staging)");
  });

  it("orders after the gateway unit when afterUnit is given (collector)", () => {
    const unit = generateSystemdUnit(spec({ component: "collector" }), {
      afterUnit: "omnesis-gateway.service",
    });
    expect(unit).toContain("After=omnesis-gateway.service");
    expect(unit).toContain("Wants=omnesis-gateway.service");
  });

  it("has no gateway ordering without afterUnit", () => {
    const unit = generateSystemdUnit(spec({ component: "collector" }));
    expect(unit).not.toContain("After=omnesis-gateway.service");
    expect(unit).not.toContain("Wants=omnesis-gateway.service");
  });

  it("quotes ExecStart args containing whitespace", () => {
    const unit = generateSystemdUnit(spec({ exec: ["/opt/my tools/omnesis", "gateway", "serve"] }));
    expect(unit).toContain('ExecStart="/opt/my tools/omnesis" gateway serve');
  });

  it("doubles literal percent signs (systemd specifier escape)", () => {
    const unit = generateSystemdUnit(
      spec({
        exec: ["/bin/omnesis", "gateway", "serve"],
        env: { OMNESIS_QUOTA: "80%" },
      }),
    );
    expect(unit).toContain("Environment=OMNESIS_QUOTA=80%%");
  });

  it("quotes Environment assignments containing whitespace", () => {
    const unit = generateSystemdUnit(spec({ env: { OMNESIS_LABEL: "two words" } }));
    expect(unit).toContain('Environment="OMNESIS_LABEL=two words"');
  });

  it("escapes embedded quotes and backslashes in quoted values", () => {
    const unit = generateSystemdUnit(spec({ env: { OMNESIS_NOTE: 'say "hi" \\now' } }));
    expect(unit).toContain('Environment="OMNESIS_NOTE=say \\"hi\\" \\\\now"');
  });

  it("ends with a trailing newline", () => {
    expect(generateSystemdUnit(spec()).endsWith("\n")).toBe(true);
  });
});

describe("loadCredentialSupportWarning", () => {
  it("warns for a systemd that predates LoadCredential=", () => {
    // The unit starts anyway on such a host — systemd logs the unknown key and
    // carries on — so nothing downstream would report the missing passphrase.
    const warning = loadCredentialSupportWarning("systemd 245 (245.4-4ubuntu3.24)\n+PAM +AUDIT\n");
    expect(warning).toMatch(/245/);
    expect(warning).toMatch(/--keyring-passphrase-file/);
  });

  it("says nothing for a supported version", () => {
    expect(loadCredentialSupportWarning("systemd 247 (247.3-7)\n")).toBeNull();
    expect(loadCredentialSupportWarning("systemd 255 (255.4-1ubuntu8.15)\n")).toBeNull();
  });

  it("says nothing when the version cannot be read", () => {
    // Silence beats a warning invented from an unparseable answer: this exists
    // to catch a version known to be too old.
    expect(loadCredentialSupportWarning("")).toBeNull();
    expect(loadCredentialSupportWarning("command not found")).toBeNull();
  });

  it("puts the boundary exactly at the release that added the directive", () => {
    const below = MIN_LOAD_CREDENTIAL_SYSTEMD - 1;
    expect(loadCredentialSupportWarning(`systemd ${below} (${below}-1)`)).not.toBeNull();
    expect(loadCredentialSupportWarning(`systemd ${MIN_LOAD_CREDENTIAL_SYSTEMD} (x)`)).toBeNull();
  });

  it("reads the version out of real systemctl output shapes", () => {
    expect(parseSystemdVersion("systemd 255 (255.4-1ubuntu8.15)\n+PAM +AUDIT")).toBe(255);
    expect(parseSystemdVersion("systemd 239 (239-78.el8)")).toBe(239);
    expect(parseSystemdVersion("systemd 256~rc3 (256~rc3-1)")).toBe(256);
  });
});
