// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createHostMinter } from "./minters.js";

const signal = () => new AbortController().signal;

describe("createHostMinter", () => {
  test("the self-signed tier mints in-process and never runs a binary", async () => {
    const runs: string[] = [];
    const minter = createHostMinter({
      run: async (file) => {
        runs.push(file);
      },
      selfSigned: () => ({ cert: "CERT", key: "KEY" }),
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
      const cli = join(dir, "tailscale");
      writeFileSync(cli, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      const minter = createHostMinter({
        tailscaleStatusTimeoutMs: 200,
        tailscaleCandidates: [{ file: cli, bundledApp: false }],
      });
      const started = Date.now();
      await expect(minter.mint("tailscale", ["gw.tail.example"], signal())).rejects.toThrow(
        /`.*tailscale status` did not answer in time/u,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
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
