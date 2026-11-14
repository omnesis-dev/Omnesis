// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import * as tls from "../tls.js";
import { TlsIssuerCleanupUnconfirmedError } from "./issuer-cleanup.js";
import { createHostMinter } from "./minters.js";

const signal = () => new AbortController().signal;

describe("createHostMinter", () => {
  test("the self-signed tier mints in-process and never runs a binary", async () => {
    const runs: string[] = [];
    const minter = createHostMinter({
      run: async (file) => {
        runs.push(file);
      },
      selfSigned: () => Promise.resolve({ cert: "CERT", key: "KEY" }),
    });
    expect(await minter.mint("self-signed", ["localhost"], signal())).toEqual({
      cert: "CERT",
      key: "KEY",
    });
    expect(runs).toEqual([]);
  });

  test("the Tailscale tier renews the certificate's DNS name into scratch paths it then reads", async () => {
    const calls: string[][] = [];
    const minter = createHostMinter({
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === "status") return '{"BackendState":"Running"}';
        writeFileSync(args[2]!, "TS-CERT");
        writeFileSync(args[4]!, "TS-KEY");
        return undefined;
      },
    });
    const pem = await minter.mint("tailscale", ["gw.tail.example"], signal());
    expect(pem).toEqual({ cert: "TS-CERT", key: "TS-KEY" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["tailscale", "status", "--json"]);
    expect(calls[1]!.slice(0, 2)).toEqual(["tailscale", "cert"]);
    expect(calls[1]!.slice(-2)).toEqual(["--", "gw.tail.example"]);
  });

  test("a disconnected PATH CLI falls back to a connected macOS app for renewal", async () => {
    const calls: string[][] = [];
    const minter = createHostMinter({
      tailscaleCandidates: [
        { file: "tailscale", bundledApp: false },
        { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
      ],
      run: async (file, args, _signal, env) => {
        calls.push([file, ...args]);
        if (file === "tailscale") return '{"BackendState":"NeedsLogin"}';
        expect(env?.TAILSCALE_BE_CLI).toBe("1");
        if (args[0] === "status") return '{"BackendState":"Running"}';
        writeFileSync(args[2]!, "TS-CERT");
        writeFileSync(args[4]!, "TS-KEY");
        return undefined;
      },
    });
    expect(await minter.mint("tailscale", ["gw.tail.example"], signal())).toEqual({
      cert: "TS-CERT",
      key: "TS-KEY",
    });
    expect(calls.map(([file, command]) => [file, command])).toEqual([
      ["tailscale", "status"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "cert"],
    ]);
  });

  test("a renewal that finds no connected CLI names the one that answered, not the last absent one", async () => {
    const missing = (file: string) =>
      Object.assign(new Error(`\`${file}\` is not installed or not on the gateway's PATH`), {
        cause: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      });
    const minter = createHostMinter({
      tailscaleCandidates: [
        { file: "tailscale", bundledApp: false },
        { file: "/opt/homebrew/bin/tailscale", bundledApp: false },
        { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
        {
          file: "/Users/maya/Applications/Tailscale.app/Contents/MacOS/Tailscale",
          bundledApp: true,
        },
      ],
      run: async (file) => {
        if (file === "/opt/homebrew/bin/tailscale") return '{"BackendState":"NeedsLogin"}';
        throw missing(file);
      },
    });
    const error = await minter.mint("tailscale", ["gw.tail.example"], signal()).catch((e) => e);
    expect(error.message).toBe(
      "`/opt/homebrew/bin/tailscale` reports Tailscale is not connected (NeedsLogin)",
    );
  });

  test("with no CLI anywhere, the renewal error names every place it looked", async () => {
    const minter = createHostMinter({
      tailscaleCandidates: [
        { file: "tailscale", bundledApp: false },
        { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
      ],
      run: async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(minter.mint("tailscale", ["gw.tail.example"], signal())).rejects.toThrow(
      /^no Tailscale CLI the gateway can run: tried `tailscale`, `\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale` \(the gateway's PATH is /u,
    );
  });

  test("a hung Tailscale CLI is abandoned at the status bound and the next candidate renews", async () => {
    const calls: string[][] = [];
    const minter = createHostMinter({
      tailscaleStatusTimeoutMs: 50,
      tailscaleCandidates: [
        { file: "tailscale", bundledApp: false },
        { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
      ],
      run: async (file, args, runSignal) => {
        calls.push([file, ...args]);
        if (file === "tailscale") {
          // Hangs until the caller gives up on it.
          return new Promise((_resolve, reject) =>
            runSignal.addEventListener("abort", () => reject(runSignal.reason)),
          );
        }
        if (args[0] === "status") return '{"BackendState":"Running"}';
        expect(runSignal.aborted).toBe(false);
        writeFileSync(args[2]!, "TS-CERT");
        writeFileSync(args[4]!, "TS-KEY");
        return undefined;
      },
    });
    expect(await minter.mint("tailscale", ["gw.tail.example"], signal())).toEqual({
      cert: "TS-CERT",
      key: "TS-KEY",
    });
    expect(calls.map(([file, command]) => [file, command])).toEqual([
      ["tailscale", "status"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "cert"],
    ]);
  });

  test("a real CLI process that hangs is killed at the bound and said so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-minter-hung-"));
    try {
      const preload = join(dir, "block.cjs");
      const ready = join(dir, "ready");
      // Block before Node interprets the issuer's argv, so the real executable
      // exercises runBinary's cancellation on every supported platform.
      writeFileSync(
        preload,
        `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n`,
      );
      // Cache preparation is a fixture prerequisite, outside the issuer's measured budget.
      if (process.platform === "win32") core.windowsJobInvocation();
      vi.stubEnv("NODE_OPTIONS", `--require ${JSON.stringify(preload)}`);
      const cli = process.execPath;
      const minter = createHostMinter({
        tailscaleStatusTimeoutMs: 200,
        tailscaleCandidates: [{ file: cli, bundledApp: false }],
      });
      const started = Date.now();
      await expect(minter.mint("tailscale", ["gw.tail.example"], signal())).rejects.toThrow(
        `\`${process.execPath} status\` did not answer in time`,
      );
      expect(readFileSync(ready, "utf8")).toBe("ready");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the mkcert tier re-issues for every name the certificate carries", async () => {
    const calls: string[][] = [];
    const minter = createHostMinter({
      run: async (file, args) => {
        calls.push([file, ...args]);
        writeFileSync(args[1]!, "MK-CERT");
        writeFileSync(args[3]!, "MK-KEY");
      },
    });
    const names = ["localhost", "127.0.0.1", "studio.local"];
    expect(await minter.mint("mkcert", names, signal())).toEqual({
      cert: "MK-CERT",
      key: "MK-KEY",
    });
    expect(calls[0]!.slice(5)).toEqual(["--", ...names]);
  });

  test("an mkcert off the gateway's PATH is found in Homebrew's bin directory", async () => {
    const calls: string[] = [];
    const minter = createHostMinter({
      mkcertCandidates: ["mkcert", "/opt/homebrew/bin/mkcert"],
      run: async (file, args) => {
        calls.push(file);
        if (file === "mkcert")
          throw Object.assign(new Error("spawn mkcert ENOENT"), { code: "ENOENT" });
        writeFileSync(args[1]!, "MK-CERT");
        writeFileSync(args[3]!, "MK-KEY");
      },
    });
    expect(await minter.mint("mkcert", ["localhost"], signal())).toEqual({
      cert: "MK-CERT",
      key: "MK-KEY",
    });
    expect(calls).toEqual(["mkcert", "/opt/homebrew/bin/mkcert"]);
  });

  test("an mkcert that runs and fails is the reason; none at all names where it looked", async () => {
    const failing = createHostMinter({
      mkcertCandidates: ["mkcert", "/opt/homebrew/bin/mkcert"],
      run: async () => {
        throw new Error("`mkcert -cert-file` failed: ERROR: failed to read the CA key");
      },
    });
    await expect(failing.mint("mkcert", ["localhost"], signal())).rejects.toThrow(
      /failed to read the CA key/u,
    );
    const absent = createHostMinter({
      mkcertCandidates: ["mkcert", "/opt/homebrew/bin/mkcert"],
      run: async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(absent.mint("mkcert", ["localhost"], signal())).rejects.toThrow(
      /^no mkcert the gateway can run: tried `mkcert`, `\/opt\/homebrew\/bin\/mkcert`/u,
    );
  });

  test("a tier with nothing to renew, or a binary that fails, throws with the reason", async () => {
    const minter = createHostMinter({
      run: async () => {
        throw new Error("`tailscale cert` failed: HTTPS is not enabled");
      },
    });
    await expect(minter.mint("tailscale", ["127.0.0.1"], signal())).rejects.toThrow(/no DNS name/u);
    await expect(minter.mint("mkcert", [], signal())).rejects.toThrow(/no names/u);
    await expect(minter.mint("mkcert", ["localhost", "-uninstall"], signal())).rejects.toThrow(
      /unusable name: -uninstall/u,
    );
    await expect(minter.mint("tailscale", ["gw.tail.example"], signal())).rejects.toThrow(
      /HTTPS is not enabled/u,
    );
  });
});

test("the default self-signed issuer forwards its cancellation signal as generator options", async () => {
  const generator = vi
    .spyOn(tls, "generateSelfSigned")
    .mockResolvedValue({ cert: "CERT", key: "KEY", fingerprintSha256: "ab".repeat(32) });
  const controller = new AbortController();
  try {
    await createHostMinter().mint("self-signed", ["localhost"], controller.signal);
    expect(generator).toHaveBeenCalledWith({ signal: controller.signal });
  } finally {
    generator.mockRestore();
  }
});

test("Windows issuer default backend awaits an owned Job with literal arguments and the caller signal", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prepare = vi.spyOn(core, "ensurePrivateDirs").mockResolvedValue();
  vi.spyOn(core, "readSecretTextFile").mockImplementation((path) =>
    Promise.resolve(readFileSync(path, "utf8")),
  );
  const run = vi.spyOn(core, "execWindowsJob").mockImplementation((_file, args) => {
    writeFileSync(args[1]!, "invented public cert");
    writeFileSync(args[3]!, "invented private key");
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  const controller = new AbortController();
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const minter = createHostMinter({ mkcertCandidates: ["synthetic issuer.exe"] });
    expect(
      await minter.mint("mkcert", ["localhost", "studio.example.test"], controller.signal),
    ).toEqual({ cert: "invented public cert", key: "invented private key" });
    expect(run).toHaveBeenCalledWith(
      "synthetic issuer.exe",
      [
        "-cert-file",
        expect.any(String),
        "-key-file",
        expect.any(String),
        "--",
        "localhost",
        "studio.example.test",
      ],
      { signal: controller.signal, env: undefined },
    );
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.restoreAllMocks();
  }
});

test("unconfirmed issuer cleanup retains its private scratch and never tries another candidate", async () => {
  let scratch: string | undefined;
  const cleanup = new Error("Invented owned Job join failure");
  const run = vi.fn((_file: string, args: string[]) => {
    scratch = dirname(args[1]!);
    return Promise.reject(
      Object.assign(new Error("Invented missing command with unconfirmed cleanup"), {
        code: "ENOENT",
        cleanupFailure: cleanup,
      }),
    );
  });
  try {
    const minter = createHostMinter({ mkcertCandidates: ["first issuer", "second issuer"], run });
    const error = await minter
      .mint("mkcert", ["localhost"], signal())
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TlsIssuerCleanupUnconfirmedError);
    expect(error).toMatchObject({ cleanupFailure: cleanup, scratchDirectory: scratch });
    expect(run).toHaveBeenCalledOnce();
    expect(existsSync(scratch!)).toBe(true);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
});

test("Windows worker startup timeout keeps the existing status budget and permits a joined fallback", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  vi.spyOn(core, "ensurePrivateDirs").mockResolvedValue();
  vi.spyOn(core, "readSecretTextFile").mockImplementation((path) =>
    Promise.resolve(readFileSync(path, "utf8")),
  );
  const job = vi.spyOn(core, "execWindowsJob").mockImplementation((file, args, opts) => {
    if (args[0] === "status") {
      expect(opts?.timeout).toBe(50);
      if (file === "cold issuer")
        return Promise.reject(
          Object.assign(new Error("Invented worker startup timeout"), { code: "ETIMEDOUT" }),
        );
      return Promise.resolve({ stdout: '{"BackendState":"Running"}', stderr: "" });
    }
    writeFileSync(args[2]!, "invented certificate");
    writeFileSync(args[4]!, "invented key");
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const minter = createHostMinter({
      tailscaleStatusTimeoutMs: 50,
      tailscaleCandidates: [
        { file: "cold issuer", bundledApp: false },
        { file: "ready issuer", bundledApp: false },
      ],
    });
    expect(await minter.mint("tailscale", ["gateway.example.test"], signal())).toEqual({
      cert: "invented certificate",
      key: "invented key",
    });
    expect(job.mock.calls.map(([file, args]) => [file, args[0]])).toEqual([
      ["cold issuer", "status"],
      ["ready issuer", "status"],
      ["ready issuer", "cert"],
    ]);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.restoreAllMocks();
  }
});

test("an unconfirmed Windows status timeout refuses candidate fallback before any issuer scratch is created", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const prepare = vi.spyOn(core, "ensurePrivateDirs").mockResolvedValue();
  const cleanup = new Error("Invented status process join failure");
  const run = vi.spyOn(core, "execWindowsJob").mockRejectedValue(
    Object.assign(new Error("Invented status deadline"), {
      code: "ETIMEDOUT",
      cleanupFailure: cleanup,
    }),
  );
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const minter = createHostMinter({
      tailscaleStatusTimeoutMs: 50,
      tailscaleCandidates: [
        { file: "unconfirmed status", bundledApp: false },
        { file: "must not run", bundledApp: false },
      ],
    });
    await expect(
      minter.mint("tailscale", ["gateway.example.test"], signal()),
    ).rejects.toMatchObject({ cleanupFailure: cleanup });
    expect(run).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.restoreAllMocks();
  }
});
