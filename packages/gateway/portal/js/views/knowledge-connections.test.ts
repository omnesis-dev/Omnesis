// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain JavaScript portal module.
import * as connections from "./knowledge-connections.js";
const { connectionHref, ConnectionReference, groupConnectionEdges } = connections;

it("links source documents and synthesis owners to their canonical portal routes", () => {
  expect(connectionHref({ id: "source:example/one" })).toBe("/portal/doc/example%2Fone");
  expect(connectionHref({ id: "loop:example" })).toBe(
    "/portal/debug/cognition/knowledge/loop%3Aexample",
  );
});

it.each([
  ["source", "source:doc"],
  ["wiki", "wiki-example"],
  ["loop", "loop-example"],
])("deduplicates %s references across claims and relationship types per direction", (kind, id) => {
  const base = {
    id: "a",
    node: { id, kind, title: "Example reference" },
    relationship: "supports",
    dependency: true,
    direction: "outgoing",
    claimId: "first",
    ref: id,
  };
  const groups = groupConnectionEdges([
    base,
    { ...base, id: "b", claimId: "second" },
    { ...base, id: "c", relationship: "context", dependency: false },
    { ...base, id: "d", direction: "incoming" },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].edges).toHaveLength(3);
  expect(groups[1].edges).toHaveLength(1);
  const reference = ConnectionReference({ edge: groups[0] });
  const children = [reference.props.children].flat().filter(Boolean);
  expect(children).toHaveLength(1);
  expect(children[0].type).toBe("a");
  expect(children[0].props.href).toBe(connectionHref(base.node));
  const linkChildren = [children[0].props.children].flat().filter(Boolean);
  expect(linkChildren).toHaveLength(2);
  expect(typeof linkChildren[0].type).toBe("function");
  expect(linkChildren[0].props.id).toBe(id);
  expect(linkChildren[1]).toBe("Example reference");
});
