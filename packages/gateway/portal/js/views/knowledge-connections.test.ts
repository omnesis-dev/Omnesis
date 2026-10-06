// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it } from "vitest";
// @ts-expect-error Plain JavaScript portal module.
import * as connections from "./knowledge-connections.js";
const { connectionHref, connectionLabel, ConnectionCard, groupConnectionEdges } = connections;
it("preserves hierarchy direction for project and subtask relationships", () => {
  expect(connectionLabel({ relationship: "part_of", direction: "outgoing" })).toBe(
    "Parent of this page",
  );
  expect(connectionLabel({ relationship: "part_of", direction: "incoming" })).toBe(
    "Part of this page",
  );
  expect(connectionLabel({ relationship: "belongs_to_project", direction: "incoming" })).toBe(
    "Belongs to this project",
  );
  expect(connectionLabel({ relationship: "supersedes", direction: "incoming" })).toBe(
    "Replaces this page",
  );
});
it("distinguishes background context from support and organization", () => {
  const tree = ConnectionCard({
    edge: {
      direction: "outgoing",
      relationship: "context",
      dependency: false,
      ref: "wiki:page",
      node: { id: "page", kind: "wiki", title: "Example page" },
    },
  });
  expect(JSON.stringify(tree)).toContain("Context reference");
  expect(JSON.stringify(tree)).not.toContain("Organization link");
  expect(connectionLabel({ relationship: "supports", direction: "incoming" })).toBe(
    "Uses this page as support",
  );
});
it("links source documents and synthesis owners to their canonical portal routes", () => {
  expect(connectionHref({ id: "source:example/one" })).toBe("/portal/doc/example%2Fone");
  expect(connectionHref({ id: "loop:example" })).toBe(
    "/portal/debug/cognition/knowledge/loop%3Aexample",
  );
});

it("groups multiple claim references without conflating relation or direction", () => {
  const base = {
    id: "a",
    node: { id: "source:doc", kind: "source", title: "Example" },
    relationship: "supports",
    dependency: true,
    direction: "outgoing",
    claimId: "first",
    ref: "source:doc",
  };
  const groups = groupConnectionEdges([
    base,
    { ...base, id: "b", claimId: "second" },
    { ...base, id: "c", relationship: "context", dependency: false },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].edges).toHaveLength(2);
  expect(JSON.stringify(ConnectionCard({ edge: groups[0] }))).toContain("2");
  expect(groups[1].edges).toHaveLength(1);
});
