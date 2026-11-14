// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { proveWindowsNativeAbort } from "./probe-windows-usearch.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "native-abort-protocol-"));
  roots.push(root);
  const path = join(root, "fixture.cjs");
  writeFileSync(
    path,
    `const {writeSync}=require('node:fs');for(const mode of ['abort','terminate']) exports[mode]=()=>{${body}};`,
  );
  return path;
}

test("records joined real-child status and ready proof without claiming a portable CRT contract", () => {
  const evidence = [];
  proveWindowsNativeAbort(
    fixture(
      "writeSync(1,'OMNESIS_NATIVE_ABORT_PROOF:'+mode+':entered'+(mode==='abort'?String.fromCharCode(10):String.fromCharCode(13,10)));process.exit(mode==='abort'?3:19);",
    ),
    { report: (item) => evidence.push(item) },
  );
  expect(
    evidence.map(({ mode, status, signal, entered }) => ({ mode, status, signal, entered })),
  ).toEqual([
    { mode: "abort", status: 3, signal: null, entered: true },
    { mode: "terminate", status: 19, signal: null, entered: true },
  ]);
});

test.each([
  [
    "return",
    "writeSync(1,'OMNESIS_NATIVE_ABORT_PROOF:'+mode+':entered'+String.fromCharCode(10));",
    "returned without aborting",
  ],
  ["missing marker", "process.exit(3);", "did not enter its callback"],
  ["callback failure", "throw Error('scripted callback failure');", "did not enter its callback"],
])("rejects %s instead of accepting an unexplained exit", (_name, body, message) => {
  expect(() => proveWindowsNativeAbort(fixture(body), { report: () => {} })).toThrow(message);
});

test("a missing addon fails before native entry instead of becoming an abort verdict", () => {
  const owner = fixture("process.exit(3);");
  expect(() =>
    proveWindowsNativeAbort(join(dirname(owner), "missing.node"), { report: () => {} }),
  ).toThrow("did not enter its callback");
});

test("bounded child timeout rejects after terminating the owned process", () => {
  expect(() =>
    proveWindowsNativeAbort(
      fixture("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);"),
      { timeoutMs: 100, report: () => {} },
    ),
  ).toThrow("did not exit within its process bound");
});
