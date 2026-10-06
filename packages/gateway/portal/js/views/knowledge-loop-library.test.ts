// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import {
  loopDeadline,
  loopDeadlineLabel,
  loopLibraryNode,
  loopLibraryPath,
  sortLibraryLoops,
} from "./knowledge-loop-library.js";
it("keeps canonical outcomes readable without a synthesis mirror", () => {
  const node = loopLibraryNode({
    id: "outcome/one",
    title: "Prepare materials",
    state: "done",
    description: "Materials are ready.",
    importance: 0.8,
    deadline: { kind: "by", date: "2030-04-10" },
    lastUpdate: "2030-04-01",
  });
  expect(node.canonicalFields.state).toBe("done");
  expect(node.validity).toBeUndefined();
  expect(node.plainText).toBe("Materials are ready.");
  expect(loopLibraryPath(node.id)).toBe(
    "/portal/debug/cognition/knowledge/outcome%2Fone?kind=loop",
  );
});
it("sorts loaded outcomes by meaningful dates or canonical importance without mutating cursor order", () => {
  const nodes = [
    loopLibraryNode({ id: "none", importance: 0.9, deadline: null, lastUpdate: "2030-04-01" }),
    loopLibraryNode({
      id: "later",
      importance: 0.2,
      deadline: { kind: "by", date: "2030-05-01" },
      lastUpdate: "2030-04-03",
    }),
    loopLibraryNode({
      id: "first",
      importance: 0.4,
      deadline: { kind: "by", date: "2030-04-10" },
      lastUpdate: "2030-04-02",
    }),
  ];
  expect(sortLibraryLoops(nodes, "deadline").map((node) => node.id)).toEqual([
    "first",
    "later",
    "none",
  ]);
  expect(sortLibraryLoops(nodes, "importance").map((node) => node.id)).toEqual([
    "none",
    "first",
    "later",
  ]);
  expect(sortLibraryLoops(nodes, "updated").map((node) => node.id)).toEqual([
    "later",
    "first",
    "none",
  ]);
  expect(nodes.map((node) => node.id)).toEqual(["none", "later", "first"]);
  expect(loopDeadline({ unknown: "Not a date" })).toBeNull();
});

it("preserves approximate and undated deadline meaning", () => {
  expect(loopDeadlineLabel({ type: "any_time" })).toBe("Any time");
  expect(loopDeadlineLabel({ type: "approximate", note: "After materials arrive" })).toBe(
    "After materials arrive",
  );
  expect(loopDeadlineLabel({ type: "approximate", date: "2030-04-10" })).toBe("Around 2030-04-10");
  expect(loopDeadlineLabel({ type: "on_day", date: "2030-04-10" })).toBe("On 2030-04-10");
});
