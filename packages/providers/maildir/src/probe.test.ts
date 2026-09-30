// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { probeMaildirReadAccess } from "./probe.js";
import {
  createMailbox,
  createThunderbirdFolder,
  deliverMessage,
  storeThunderbirdMessage,
} from "./testing/maildir-writer.js";

const isRoot = process.getuid?.() === 0;
const signal = new AbortController().signal;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omnesis-maildir-probe-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a tree whose mailboxes list and whose messages open is readable, however large", async () => {
  const inbox = createMailbox(join(root, "INBOX"));
  for (let i = 0; i < 600; i++) deliverMessage(inbox, `${i}.x`, "Subject: x\r\n\r\nx");
  createMailbox(root);
  expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "readable" });
});

test("a missing root, or one with no mailbox near the top, is unavailable", async () => {
  expect(await probeMaildirReadAccess(join(root, "gone"), signal)).toEqual({
    status: "unavailable",
  });
  mkdirSync(join(root, "empty"));
  expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "unavailable" });
});

test.skipIf(isRoot)("a mailbox the process may not list is denied", async () => {
  const inbox = createMailbox(join(root, "INBOX"));
  chmodSync(join(inbox, "cur"), 0o000);
  try {
    expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "denied" });
  } finally {
    chmodSync(join(inbox, "cur"), 0o755);
  }
});

test.skipIf(isRoot)("a message file the process may not open is denied", async () => {
  const inbox = createMailbox(join(root, "INBOX"));
  const path = deliverMessage(inbox, "1.x", "Subject: x\r\n\r\nx");
  chmodSync(path, 0o000);
  expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "denied" });
});

test("Thunderbird's folders, which have no new directory, are readable", async () => {
  createThunderbirdFolder(join(root, "Inbox"));
  expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "readable" });
  storeThunderbirdMessage(join(root, "Sent"), "1.a", "Subject: x\r\n\r\nx");
  expect(await probeMaildirReadAccess(root, signal)).toEqual({ status: "readable" });
});
