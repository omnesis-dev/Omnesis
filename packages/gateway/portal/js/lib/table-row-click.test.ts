// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { rowActivateHandler } from "./table-row-click.js";

/**
 * Builds a cell whose click handler is under test.
 *
 * The handler is driven with an explicit `{target, currentTarget}` pair rather
 * than a dispatched event: the DOM implementation these tests run under does
 * not bubble a click from a cell's child up to the cell, so a dispatched event
 * would never reach the handler that is being tested.
 */
function cellWith(innerHtml: string) {
  const { document } = parseHTML(
    `<html><body><table><tbody><tr><td id="cell">${innerHtml}</td></tr></tbody></table></body></html>`,
  );
  const currentTarget = document.querySelector("#cell");
  return {
    currentTarget,
    at(selector: string) {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Missing ${selector}`);
      return { target, currentTarget };
    },
  };
}

describe("rowActivateHandler", () => {
  it("activates when the click lands on bare cell space", () => {
    const activate = vi.fn();
    const cell = cellWith("<span id='text'>plain</span>");
    rowActivateHandler(activate)({ target: cell.currentTarget, currentTarget: cell.currentTarget });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("activates from an inert element inside the cell", () => {
    const activate = vi.fn();
    const cell = cellWith("<span id='text'>plain</span>");
    rowActivateHandler(activate)(cell.at("#text"));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  for (const [name, markup, selector] of [
    ["a button", "<button id='x'>Go</button>", "#x"],
    ["a link", "<a id='x' href='#'>Go</a>", "#x"],
    ["an input", "<input id='x' />", "#x"],
    ["a select", "<select id='x'></select>", "#x"],
    ["a menu", "<div role='menu'><span id='x'>Item</span></div>", "#x"],
  ] as const) {
    it(`leaves ${name} to do its own job`, () => {
      const activate = vi.fn();
      const cell = cellWith(markup);
      rowActivateHandler(activate)(cell.at(selector));
      expect(activate).not.toHaveBeenCalled();
    });
  }

  it("ignores a click nested deep inside a control", () => {
    const activate = vi.fn();
    const cell = cellWith("<button><span id='x'>Label</span></button>");
    rowActivateHandler(activate)(cell.at("#x"));
    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores a target whose ancestry never reaches the cell", () => {
    // A control that removes itself on click leaves a target detached from the
    // row. The row must not treat that as bare space and activate.
    const activate = vi.fn();
    const cell = cellWith("<span id='text'>plain</span>");
    const { document } = parseHTML("<html><body><span id='gone'>x</span></body></html>");
    rowActivateHandler(activate)({
      target: document.querySelector("#gone"),
      currentTarget: cell.currentTarget,
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("ignores a target with no ancestry at all", () => {
    const activate = vi.fn();
    const cell = cellWith("<span id='text'>plain</span>");
    rowActivateHandler(activate)({ target: null, currentTarget: cell.currentTarget });
    expect(activate).not.toHaveBeenCalled();
  });

  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    it(`leaves a ${modifier} click to the browser`, () => {
      // Otherwise the row would swallow open-in-new-tab and range-select.
      const activate = vi.fn();
      const cell = cellWith("<span id='text'>plain</span>");
      rowActivateHandler(activate)({
        target: cell.currentTarget,
        currentTarget: cell.currentTarget,
        [modifier]: true,
      });
      expect(activate).not.toHaveBeenCalled();
    });
  }

  it("ignores a click on a role-based control", () => {
    const activate = vi.fn();
    const cell = cellWith("<div role='switch'><span id='x'>on</span></div>");
    rowActivateHandler(activate)(cell.at("#x"));
    expect(activate).not.toHaveBeenCalled();
  });
});
