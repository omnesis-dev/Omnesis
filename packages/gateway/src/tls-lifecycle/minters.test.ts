// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync } from "node:fs";
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
        writeFileSync(args[2]!, "TS-CERT");
        writeFileSync(args[4]!, "TS-KEY");
      },
    });
    const pem = await minter.mint("tailscale", ["gw.tail.example"], signal());
    expect(pem).toEqual({ cert: "TS-CERT", key: "TS-KEY" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["tailscale", "cert"]);
    expect(calls[0]!.slice(-2)).toEqual(["--", "gw.tail.example"]);
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
