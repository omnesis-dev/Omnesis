// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { tlsFiles } from "../test/support.js";
import { GatewayPublicSni } from "./acme-sni.js";
import type { SecureContext } from "node:tls";

test("public SNI replacement is case insensitive, leaves default/unknown names alone and preserves the old context on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-sni-")),
    sni = new GatewayPublicSni();
  const select = (hostname: string) =>
    new Promise<SecureContext | undefined>((resolve, reject) =>
      sni.callback(hostname, (error, context) => (error ? reject(error) : resolve(context))),
    );
  try {
    expect(await select("gateway.example.test")).toBeUndefined();
    const files = tlsFiles(directory),
      cert = await readFile(files.certFile, "utf8"),
      key = await readFile(files.keyFile, "utf8");
    sni.activate({ hostname: "Gateway.Example.Test", cert, key });
    const first = await select("GATEWAY.EXAMPLE.TEST");
    expect(first).toBeDefined();
    expect(await select("localhost")).toBeUndefined();
    expect(() =>
      sni.activate({ hostname: "gateway.example.test", cert: "invalid", key }),
    ).toThrow();
    expect(await select("gateway.example.test")).toBe(first);
    sni.activate({ hostname: "gateway.example.test", cert, key });
    expect(await select("gateway.example.test")).not.toBe(first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
