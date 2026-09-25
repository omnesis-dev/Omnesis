// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A coverage claim is durable, so a source that makes one on some pages and
 * reports progress without it on others pins its first claim permanently.
 *
 * That shape is not visible in review — each page reads correctly on its own,
 * and the omission is what does the damage. It reached three of eleven
 * claimants before anyone looked: a messaging source whose emission gate
 * withheld precisely the all-clear, a mail source that claimed once during a
 * recovery and never again, and a banking source whose later phases went
 * quiet. So the rule is checked mechanically instead.
 *
 * The rule: within one file, if any progress object names `coverage`, they all
 * must. A source that never mentions coverage is untouched — silence is a
 * legitimate answer, and it is only *inconsistent* silence that strands a
 * claim.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import ts from "typescript";

const SCANNED_ROOTS = [join("packages", "providers"), join("packages", "source-sdk")];

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Could not locate the repository root from the source-sdk package");
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
}

/**
 * Every object literal assigned to a `progress:` property, and whether it
 * names `coverage`.
 *
 * Two shapes count: the literal assigned straight to a `progress:` property,
 * and the branches of a conditional assigned to a variable named `progress` —
 * the hoisted `const progress = cond ? {…} : undefined` that two sources use,
 * which is the same hazard wearing different syntax. A progress object built
 * elsewhere and passed by name is a helper — the pattern the consistent
 * sources use, and the one this check steers toward — so it is not a finding.
 *
 * What this does not see, stated plainly, because a guard trusted for more
 * than it does is worse than none: it works a file at a time, so a source
 * split across two files is never compared against itself; and a file holding
 * fewer than two progress literals is skipped, so a helper-shaped source can
 * acquire one silently. Both are why the per-source review that found these
 * defects is not replaced by this check.
 */
function progressLiterals(
  source: string,
  fileName: string,
): { line: number; named: boolean; subject: boolean }[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: { line: number; named: boolean; subject: boolean }[] = [];

  // Property names a same-file helper puts on the object it returns.
  //
  // A spread is where these sources actually keep their coverage, so treating
  // every spread as "names everything" made the check unable to fail, and
  // treating it as "names nothing" made it fail on sources that are correct.
  // Resolving the common shape — a function declared in this file whose
  // returns are object literals — is what makes the answer real. Anything it
  // cannot resolve still counts as naming, because a rule is only worth having
  // if every failure it reports is one.
  const helperProps = (name: string): Set<string> | undefined => {
    const props = new Set<string>();
    let found = false;
    const scan = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
        found = true;
        const walk = (n: ts.Node): void => {
          if (ts.isReturnStatement(n) && n.expression) {
            const expr = n.expression;
            const collect = (e: ts.Expression): void => {
              if (ts.isObjectLiteralExpression(e)) {
                for (const prop of e.properties) {
                  if (ts.isSpreadAssignment(prop)) props.add("*");
                  else if (prop.name && ts.isIdentifier(prop.name)) props.add(prop.name.text);
                }
              } else if (ts.isConditionalExpression(e)) {
                collect(e.whenTrue);
                collect(e.whenFalse);
              } else props.add("*");
            };
            collect(expr);
          }
          ts.forEachChild(n, walk);
        };
        walk(node.body);
      }
      ts.forEachChild(node, scan);
    };
    scan(sf);
    return found ? props : undefined;
  };

  /** Does this literal name `key`, directly or through a resolvable spread? */
  const names = (literal: ts.ObjectLiteralExpression, key: string): boolean =>
    literal.properties.some((p) => {
      if (p.name && ts.isIdentifier(p.name) && p.name.text === key) return true;
      if (!ts.isSpreadAssignment(p)) return false;
      const carries = (expr: ts.Expression): boolean => {
        let e = expr;
        while (ts.isParenthesizedExpression(e)) e = e.expression;
        // `...(cond ? A : B)` carries the key if either arm does.
        if (ts.isConditionalExpression(e)) return carries(e.whenTrue) || carries(e.whenFalse);
        if (ts.isObjectLiteralExpression(e)) return names(e, key);
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
          const props = helperProps(e.expression.text);
          if (props) return props.has(key) || props.has("*");
        }
        // Unresolvable: assume it carries the key rather than report a failure
        // that may not be real.
        return true;
      };
      return carries(p.expression);
    });

  const record = (literal: ts.ObjectLiteralExpression): void => {
    const named = names(literal, "coverage");
    const subject = names(literal, "coverageSubject");
    found.push({
      line: sf.getLineAndCharacterOfPosition(literal.getStart(sf)).line + 1,
      named,
      subject,
    });
  };

  // A conditional's branches are each a progress object in their own right.
  const recordFrom = (expr: ts.Expression): void => {
    if (ts.isObjectLiteralExpression(expr)) record(expr);
    else if (ts.isConditionalExpression(expr)) {
      recordFrom(expr.whenTrue);
      recordFrom(expr.whenFalse);
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "progress"
    ) {
      recordFrom(node.initializer);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "progress" &&
      node.initializer
    ) {
      recordFrom(node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

describe("a source names its coverage subject on every claim, or on none", () => {
  test("no source names a coverage subject on some claims and omits it on others", () => {
    // Subject-keying is what tells the host whether two claims are about
    // different things (keep the weakest) or one thing revised (believe the
    // later). A source that names a subject on some claiming pages and not
    // others sends part of its claims to the unnamed key, where they are
    // ranked against each other instead of replacing each other — the same
    // class of bug the rule above catches, in the mechanism the whole scheme
    // rests on.
    const root = repoRoot();
    const files: string[] = [];
    for (const r of SCANNED_ROOTS) {
      const dir = join(root, r);
      if (existsSync(dir)) walkTsFiles(dir, files);
    }

    const offenders: string[] = [];
    for (const file of files) {
      const literals = progressLiterals(readFileSync(file, "utf8"), file);
      const claiming = literals.filter((l) => l.named);
      if (claiming.length < 2) continue;
      const subjected = claiming.filter((l) => l.subject);
      if (subjected.length === 0 || subjected.length === claiming.length) continue;
      offenders.push(
        `${relative(root, file)} — names a coverage subject on ${subjected.length} of ` +
          `${claiming.length} claims; silent at line(s) ` +
          claiming
            .filter((l) => !l.subject)
            .map((l) => l.line)
            .join(", "),
      );
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("a source states its history coverage on every page, or on none", () => {
  test("no source names coverage on some progress pages and omits it on others", () => {
    const root = repoRoot();
    const files: string[] = [];
    for (const r of SCANNED_ROOTS) {
      const dir = join(root, r);
      if (existsSync(dir)) walkTsFiles(dir, files);
    }
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const literals = progressLiterals(readFileSync(file, "utf8"), file);
      if (literals.length < 2) continue;
      const claiming = literals.filter((l) => l.named);
      if (claiming.length === 0 || claiming.length === literals.length) continue;
      const silent = literals.filter((l) => !l.named).map((l) => l.line);
      offenders.push(
        `${relative(root, file)} — states coverage on ${claiming.length} of ${literals.length} ` +
          `progress pages; silent at line(s) ${silent.join(", ")}`,
      );
    }

    expect(
      offenders,
      "A durable coverage claim is only revised by a page that states one. A source that\n" +
        "states it on some pages and not others therefore pins whichever claim it happened to\n" +
        "make first — including, in the case that bit us, pinning a caveat over an all-clear it\n" +
        "never got to report.\n\n" +
        "Either state coverage on every progress page (a single helper the returns share is the\n" +
        "shape that stays right), or state it on none.\n\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
