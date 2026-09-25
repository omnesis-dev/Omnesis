// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openReadonlySqliteSnapshot } from "./sqlite-snapshot.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sqlite-recovery-contract-"));
  roots.push(root);
  const source = join(root, "fixture.db");
  writeFileSync(source, "fictional database");
  return source;
}

it("recovers before readonly reopen and owns idempotent close/cleanup", () => {
  const source = fixture();
  const order: string[] = [];
  const snapshot = openReadonlySqliteSnapshot(source, (path, options) => {
    expect(path).not.toBe(source);
    expect(options.fileMustExist).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const mode = options.readonly ? "readonly" : "recover";
    order.push("open:" + mode);
    return {
      prepare: () => ({
        get: () => {
          order.push("read:" + mode);
        },
      }),
      close: () => {
        order.push("close:" + mode);
      },
    };
  });
  expect(order).toEqual([
    "open:recover",
    "read:recover",
    "close:recover",
    "open:readonly",
    "read:readonly",
  ]);
  snapshot.cleanup();
  snapshot.cleanup();
  expect(order.at(-1)).toBe("close:readonly");
  expect(order.filter((s) => s === "close:readonly")).toHaveLength(1);
  expect(existsSync(dirname(snapshot.path))).toBe(false);
  expect(readFileSync(source, "utf8")).toBe("fictional database");
});

it.each(["recover-open", "recover-read", "readonly-open", "readonly-read"])(
  "cleans owned scratch on %s failure",
  (stage) => {
    const source = fixture();
    let copy = "";
    const closed: string[] = [];
    expect(() =>
      openReadonlySqliteSnapshot(source, (path, { readonly }) => {
        copy = path;
        const mode = readonly ? "readonly" : "recover";
        if (stage === mode + "-open") throw Error("fixture refusal");
        return {
          prepare: () => ({
            get: () => {
              if (stage === mode + "-read") throw Error("fixture refusal");
            },
          }),
          close: () => {
            closed.push(mode);
          },
        };
      }),
    ).toThrow("fixture refusal");
    expect(copy).not.toBe("");
    expect(existsSync(dirname(copy))).toBe(false);
    if (stage !== "recover-open") expect(closed).toContain("recover");
    if (stage === "readonly-read") expect(closed).toContain("readonly");
  },
);

it("refuses external super-journal references before invoking the driver", () => {
  const source = fixture();
  const other = join(dirname(source), "external-super-journal");
  writeFileSync(other, "must remain untouched");
  const name = Buffer.from(other);
  const footer = Buffer.alloc(16);
  footer.writeUInt32BE(name.length);
  footer.writeUInt32BE(
    name.reduce((sum, b) => sum + b, 0),
    4,
  );
  Buffer.from("d9d505f920a163d7", "hex").copy(footer, 8);
  writeFileSync(source + "-journal", Buffer.concat([Buffer.alloc(512), name, footer]));
  const open = vi.fn(() => ({ prepare: () => ({ get: () => undefined }), close: () => {} }));
  expect(() => openReadonlySqliteSnapshot(source, open)).toThrow("referencing another database");
  expect(open).not.toHaveBeenCalled();
  expect(readFileSync(other, "utf8")).toBe("must remain untouched");
});

it("retains cleanup ownership when closing the recovery handle fails", () => {
  const source = fixture();
  let copy = "";
  let closeCalls = 0;
  expect(() =>
    openReadonlySqliteSnapshot(source, (path) => {
      copy = path;
      return {
        prepare: () => ({ get: () => undefined }),
        close: () => {
          if (++closeCalls === 1) throw Error("fixture close failure");
        },
      };
    }),
  ).toThrow("fixture close failure");
  expect(closeCalls).toBe(2);
  expect(existsSync(dirname(copy))).toBe(false);
});
