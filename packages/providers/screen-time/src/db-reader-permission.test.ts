// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { KnowledgeDbReader } from "./db-reader.js";

const fixture = vi.hoisted(() => ({ code: "EACCES" }));
vi.mock("@omnesis/core", async (original) => ({
  ...(await original<typeof import("@omnesis/core")>()),
  openReadonlySqliteSnapshot: () => {
    throw Object.assign(new Error("Invented macOS database denial"), { code: fixture.code });
  },
}));

test.each(["EACCES", "EPERM"])(
  "maps the macOS reader's %s denial to source-scoped full disk access remediation",
  (code) => {
    fixture.code = code;
    let failure: unknown;
    try {
      new KnowledgeDbReader("fictional-knowledge.db");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SyncError);
    expect(failure).toMatchObject({
      kind: "permission",
      scope: "source",
      remediation: { executable: process.execPath },
    });
  },
);
