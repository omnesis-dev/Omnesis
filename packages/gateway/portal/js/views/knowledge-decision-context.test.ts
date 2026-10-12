// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// @ts-nocheck — structural checks for plain-JavaScript portal components.
import { expect, it } from "vitest";
import { DecisionSubject } from "./knowledge-decision-subject.js";
import { NodeReviewDetails, DecisionContextDetails } from "./knowledge-decision-context.js";

it("uses canonical subject metadata for links and keeps hostile titles inert", () => {
  const tree = DecisionSubject({ subject: { kind: "source", id: "fictional/doc", sourceId: "fixture-source", title: "<script>not markup</script>" } });
  expect(tree.type).toBe("a");
  expect(tree.props.href).toBe("/portal/doc/fictional%2Fdoc");
  expect(tree.props.dangerouslySetInnerHTML).toBeUndefined();
  expect(tree.props.children).toContain("<script>not markup</script>");
  expect(DecisionSubject({ subject: { kind: "loop", id: "loop_fixture", title: "Workshop follow-up" } }).props.href).toContain("kind=loop");
});
it("opens node review history lazily without claiming it caused the current schedule", () => {
  const tree = NodeReviewDetails({ node: { id: "wiki_fixture", metadata: { nextReviewAt: 1700000000000 } } });
  expect(tree.type).toBe(DecisionContextDetails);
  expect(tree.props.contextKey).toContain("wiki_fixture:");
  expect(tree.props.contextKey).toContain("1700000000000");
  expect(tree.props.load).toBeTypeOf("function");
  expect(tree.props.note).toContain("historical judgements");
  expect(tree.props.note).toContain("Later scheduling changes");
});
