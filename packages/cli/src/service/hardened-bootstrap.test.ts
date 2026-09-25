// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { CliError } from "@omnesis/cli-shared";
import {
  CREDENTIAL_EXPORT,
  commitOnRemote,
  hardenedAdminInstalled,
  hardenedBootstrapCommand,
  hardenedBootstrapFlags,
  hardenedGatewayUpdateCommand,
  repositoryNeedsCredential,
  resolveBootstrapTarget,
  shellQuote,
  updateTarget,
  versionTarget,
  type BootstrapCommandInput,
  type GitProbe,
  type GitProbeResult,
} from "./hardened-bootstrap.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const base: BootstrapCommandInput = {
  target: { kind: "version", version: "0.4.9" },
  port: 7600,
  keyring: { kind: "passphrase" },
  needsCredential: false,
  installed: false,
};

describe("hardenedBootstrapCommand", () => {
  it("pipes the published script into a root shell for this release", () => {
    expect(hardenedBootstrapCommand(base)).toBe(
      "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --version 0.4.9",
    );
  });

  it("names the commit of a checkout that sits on no release tag", () => {
    expect(hardenedBootstrapCommand({ ...base, target: { kind: "ref", ref: SHA } })).toBe(
      `curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --ref ${SHA}`,
    );
  });

  it("carries a port other than the default and leaves the default unsaid", () => {
    expect(hardenedBootstrapCommand({ ...base, port: 8443 })).toContain(
      "install --version 0.4.9 --port 8443",
    );
    expect(hardenedBootstrapCommand(base)).not.toContain("--port");
  });

  it("names the keyring choice, quoting a path the shell would split", () => {
    expect(hardenedBootstrapCommand({ ...base, keyring: { kind: "none" } })).toMatch(
      / --no-keyring$/,
    );
    expect(
      hardenedBootstrapCommand({
        ...base,
        keyring: { kind: "file", path: "/home/maya/gateway pass" },
      }),
    ).toMatch(/ --keyring-passphrase-file '\/home\/maya\/gateway pass'$/);
  });

  it("hands a token to root in its environment, never as a word on the command line", () => {
    const command = hardenedBootstrapCommand({ ...base, needsCredential: true });
    expect(command).toBe(
      `(${CREDENTIAL_EXPORT}; curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo --preserve-env=OMNESIS_GIT_TOKEN sh -s -- install --version 0.4.9)`,
    );
    // sudo's own arguments name the variable to keep, and no assignment: its
    // command line is what every account can list and what sudo logs.
    const sudoWords = command.slice(command.indexOf("| sudo") + 2).split(" ");
    expect(sudoWords.some((word) => word.startsWith("OMNESIS_GIT_TOKEN="))).toBe(false);
    expect(CREDENTIAL_EXPORT).toContain("git credential fill");
    expect(CREDENTIAL_EXPORT).toContain("GIT_TERMINAL_PROMPT=0");
  });

  it("moves an installed gateway with the admin command instead of installing", () => {
    expect(hardenedBootstrapCommand({ ...base, installed: true })).toBe(
      "sudo omnesis-gateway-admin update --version 0.4.9",
    );
    expect(
      hardenedBootstrapCommand({
        ...base,
        installed: true,
        needsCredential: true,
        target: { kind: "ref", ref: SHA },
      }),
    ).toBe(
      `(${CREDENTIAL_EXPORT}; sudo --preserve-env=OMNESIS_GIT_TOKEN omnesis-gateway-admin update --ref ${SHA})`,
    );
  });
});

describe("versionTarget", () => {
  it("uses --version for a stable release and the release tag for anything else", () => {
    expect(versionTarget("0.4.9")).toEqual({ kind: "version", version: "0.4.9" });
    expect(versionTarget("0.5.0-beta.1")).toEqual({ kind: "ref", ref: "v0.5.0-beta.1" });
  });
});

describe("shellQuote", () => {
  it("leaves plain words alone and single-quotes the rest", () => {
    expect(shellQuote("/etc/omnesis-gateway/keyring.pass")).toBe(
      "/etc/omnesis-gateway/keyring.pass",
    );
    expect(shellQuote("maya's pass")).toBe(`'maya'\\''s pass'`);
    expect(shellQuote("$(reboot)")).toBe("'$(reboot)'");
  });
});

describe("hardenedBootstrapFlags", () => {
  const refuses = (
    args: Record<string, unknown>,
    env: Record<string, string>,
    message: RegExp,
    installed = false,
  ) => {
    expect(() => hardenedBootstrapFlags(args, env, installed)).toThrow(CliError);
    expect(() => hardenedBootstrapFlags(args, env, installed)).toThrow(message);
  };

  it("reads the defaults when nothing is asked for", () => {
    expect(hardenedBootstrapFlags({}, {}, false)).toEqual({
      port: 7600,
      keyring: { kind: "passphrase" },
    });
  });

  it("refuses the flags that describe a unit, which root's install writes itself", () => {
    refuses({ exec: "/usr/local/bin/omnesis" }, {}, /--exec only applies when root writes/);
    refuses({ "secret-store": "file" }, {}, /--secret-store only applies/);
    refuses(
      { "keyring-passphrase-credential": "/etc/pass" },
      {},
      /--keyring-passphrase-credential only applies/,
    );
  });

  it("takes only the port through --env, and only a real one", () => {
    expect(hardenedBootstrapFlags({}, { OMNESIS_GATEWAY_PORT: "8443" }, false).port).toBe(8443);
    refuses({}, { OMNESIS_LOG_LEVEL: "debug" }, /only OMNESIS_GATEWAY_PORT.*OMNESIS_LOG_LEVEL/);
    for (const bad of ["0", "70000", "https"]) {
      refuses({}, { OMNESIS_GATEWAY_PORT: bad }, /Invalid OMNESIS_GATEWAY_PORT/);
    }
  });

  it("maps each keyring choice, and refuses contradictions and relative paths", () => {
    expect(hardenedBootstrapFlags({ "no-keyring": true }, {}, false).keyring).toEqual({
      kind: "none",
    });
    expect(
      hardenedBootstrapFlags({ "keyring-passphrase-file": "/home/maya/pass" }, {}, false).keyring,
    ).toEqual({ kind: "file", path: "/home/maya/pass" });
    refuses(
      { "no-keyring": true, "keyring-passphrase-file": "/home/maya/pass" },
      {},
      /contradict each other/,
    );
    refuses({ "keyring-passphrase-file": "pass" }, {}, /must be an absolute path/);
  });

  it("refuses a port or keyring choice for a gateway already installed", () => {
    expect(hardenedBootstrapFlags({}, {}, true)).toEqual({
      port: 7600,
      keyring: { kind: "passphrase" },
    });
    refuses({}, { OMNESIS_GATEWAY_PORT: "8443" }, /keeps the port and keyring/, true);
    refuses({ "no-keyring": true }, {}, /keeps the port and keyring/, true);
  });
});

function probe(answers: Record<string, Partial<GitProbeResult>>): GitProbe {
  return (args) => ({ code: 128, stdout: "", stderr: "", ...answers[args.join(" ")] });
}

describe("resolveBootstrapTarget", () => {
  it("names the version for a package install, which has no checkout", () => {
    expect(resolveBootstrapTarget("0.4.9", null, probe({}))).toEqual({
      kind: "version",
      version: "0.4.9",
    });
    expect(resolveBootstrapTarget("0.5.0-beta.1", null, probe({}))).toEqual({
      kind: "ref",
      ref: "v0.5.0-beta.1",
    });
  });

  it("names the version for a checkout on that version's release tag", () => {
    const git = probe({ "describe --exact-match --tags HEAD": { code: 0, stdout: "v0.4.9\n" } });
    expect(resolveBootstrapTarget("0.4.9", "/home/maya/omnesis/", git)).toEqual({
      kind: "version",
      version: "0.4.9",
    });
  });

  it("names the commit for a checkout anywhere else, including another release's tag", () => {
    for (const described of [
      { code: 128, stdout: "" },
      { code: 0, stdout: "v0.4.8\n" },
    ]) {
      const git = probe({
        "describe --exact-match --tags HEAD": described,
        "rev-parse HEAD": { code: 0, stdout: `${SHA}\n` },
      });
      expect(resolveBootstrapTarget("0.4.9", "/home/maya/omnesis/", git)).toEqual({
        kind: "ref",
        ref: SHA,
      });
    }
  });

  it("falls back to the version when git cannot say", () => {
    expect(resolveBootstrapTarget("0.4.9", "/home/maya/omnesis/", probe({}))).toEqual({
      kind: "version",
      version: "0.4.9",
    });
  });
});

describe("updateTarget", () => {
  it("follows the update's version, and the checkout's commit for an edge update", () => {
    const git = probe({ "rev-parse HEAD": { code: 0, stdout: `${SHA}\n` } });
    expect(updateTarget("0.4.9", "0.4.8", "/home/maya/omnesis/", git)).toEqual({
      kind: "version",
      version: "0.4.9",
    });
    expect(updateTarget("0.5.0-beta.1", "0.4.8", "/home/maya/omnesis/", git)).toEqual({
      kind: "ref",
      ref: "v0.5.0-beta.1",
    });
    expect(updateTarget(null, "0.4.9", "/home/maya/omnesis/", git)).toEqual({
      kind: "ref",
      ref: SHA,
    });
  });
});

describe("commitOnRemote", () => {
  it("is true only when a remote branch contains the commit", () => {
    const on = probe({ [`branch -r --contains ${SHA}`]: { code: 0, stdout: "  origin/main\n" } });
    const off = probe({ [`branch -r --contains ${SHA}`]: { code: 0, stdout: "" } });
    expect(commitOnRemote(SHA, "/home/maya/omnesis/", on)).toBe(true);
    expect(commitOnRemote(SHA, "/home/maya/omnesis/", off)).toBe(false);
    expect(commitOnRemote(SHA, null, on)).toBe(false);
  });
});

describe("repositoryNeedsCredential", () => {
  it("reads the repository the way root will, ignoring this account's git configuration", () => {
    const seen: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
    const git: GitProbe = (args, _cwd, env) => {
      seen.push({ args, env });
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(repositoryNeedsCredential(git, "https://example.org/omnesis")).toBe(false);
    expect(seen[0]).toEqual({
      args: ["ls-remote", "--exit-code", "https://example.org/omnesis", "HEAD"],
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  });

  it("counts a refusal as needing a token, and an unreachable network as not", () => {
    const answering =
      (stderr: string): GitProbe =>
      () => ({ code: 128, stdout: "", stderr });
    expect(
      repositoryNeedsCredential(
        answering(
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        ),
      ),
    ).toBe(true);
    expect(
      repositoryNeedsCredential(answering("fatal: unable to access: Could not resolve host")),
    ).toBe(false);
  });
});

describe("hardenedGatewayUpdateCommand", () => {
  it("names the admin update where installed, and the install otherwise", () => {
    const target = { kind: "version", version: "0.4.9" } as const;
    expect(hardenedGatewayUpdateCommand(target, true, false)).toBe(
      "sudo omnesis-gateway-admin update --version 0.4.9",
    );
    expect(hardenedGatewayUpdateCommand(target, false, false)).toBe(
      "curl -fsSL https://omnesis.dev/hardened-gateway.sh | sudo sh -s -- install --version 0.4.9",
    );
  });
});

describe("hardenedAdminInstalled", () => {
  it("looks for the root-owned admin command", () => {
    const asked: string[] = [];
    expect(
      hardenedAdminInstalled((path) => {
        asked.push(path);
        return true;
      }),
    ).toBe(true);
    expect(asked).toEqual(["/usr/local/sbin/omnesis-gateway-admin"]);
  });
});
