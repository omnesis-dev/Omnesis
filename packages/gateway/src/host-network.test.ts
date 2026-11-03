// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHostNetwork } from "./host-network.js";

describe("readHostNetwork", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-host-network-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is null without a record", () => {
    expect(readHostNetwork(dir)).toBeNull();
  });

  it("reads the launcher's record afresh on every call", () => {
    writeFileSync(join(dir, "host-network"), "port 7600\ninterface en0 192.168.1.20\n");
    expect(readHostNetwork(dir)).toMatchObject({
      port: 7600,
      identities: [{ kind: "lan", address: "192.168.1.20" }],
    });
    // The router handed the host a new address; the launcher rewrote the file.
    writeFileSync(join(dir, "host-network"), "port 7600\ninterface en0 192.168.1.50\n");
    expect(readHostNetwork(dir)?.identities.map((i) => i.address)).toEqual(["192.168.1.50"]);
  });

  it("refuses a file far larger than any record", () => {
    writeFileSync(join(dir, "host-network"), `port 7600\n${"#".repeat(70 * 1024)}\n`);
    expect(readHostNetwork(dir)).toBeNull();
  });
});
