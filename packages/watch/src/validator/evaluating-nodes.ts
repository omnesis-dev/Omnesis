// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two nodes that evaluate something rather than merely combine signals.
 *
 * A **SQL node** queries the analytics store. Three properties make it
 * checkable without executing it: every table it reads must resolve in the
 * catalog and only there, every projected item must carry an explicit alias
 * (a column the validator cannot name is a column downstream references cannot
 * be checked against), and it must project a boolean `fires` column, which is
 * the node's firing signal. Time reaches it as bound parameters, never as a
 * clock read.
 *
 * An **LLM node** decides. In judge mode it sees only the typed evidence its
 * inputs carry; in investigation mode it holds read-only tools and a budget.
 * Its `fire_when` predicate reads its own declared output and nothing else, so
 * a comparison against an enum member that does not exist is a compile error
 * rather than a watch that never fires.
 */

import { parsePredicate, type Expression, type Predicate } from "../dsl/expression.js";
import {
  BOOLEAN,
  formatValueType,
  parseValueType,
  typesCompatible,
  type ValueType,
} from "../dsl/value-type.js";
import { parseExpression } from "../dsl/expression.js";
import { analyzeSql, type SqlAnalysis } from "./sql.js";
import type { LlmNode, SqlNode, WatchNode } from "../dsl/schema.js";
import type { FieldInfo } from "./node-output.js";
import type { OutputDeriver } from "./outputs.js";
import type { ReferenceResolver } from "./references.js";
import type { ValidationContext } from "./context.js";

/**
 * Functions a watch may not call, and why. Each message names the alternative,
 * because the compiler reads these and has to be able to act on them.
 */
const NONDETERMINISTIC_FUNCTIONS: Readonly<Record<string, string>> = {
  now: "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  current_timestamp:
    "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  current_localtimestamp:
    "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  localtimestamp:
    "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  get_current_timestamp:
    "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  transaction_timestamp:
    "A watch never reads a clock — the evaluation instant is bound as $now, which is what lets a backtest replay time.",
  current_date: "A watch never reads a clock — today's date is bound as $today.",
  today: "A watch never reads a clock — today's date is bound as $today.",
  current_time: "A watch never reads a clock — the evaluation instant is bound as $now.",
  current_localtime: "A watch never reads a clock — the evaluation instant is bound as $now.",
  localtime: "A watch never reads a clock — the evaluation instant is bound as $now.",
  get_current_time: "A watch never reads a clock — the evaluation instant is bound as $now.",
  random: "A watch must decide the same way twice; a random draw makes its firing unreproducible.",
  gen_random_uuid:
    "A watch must decide the same way twice; a generated id makes its firing unreproducible.",
  uuid: "A watch must decide the same way twice; a generated id makes its firing unreproducible.",
  nextval:
    "A sequence advances as a side effect, so evaluating a watch would change the world it observes.",
};

export class EvaluatingNodeChecker {
  constructor(
    private readonly ctx: ValidationContext,
    private readonly resolver: ReferenceResolver,
    private readonly outputs: OutputDeriver,
  ) {}

  checkSqlBearingNode(
    node: SqlNode | Extract<WatchNode, { type: "stateless.transform" }>,
    path: string,
  ): void {
    const analysis = analyzeSql(node.query);

    if (analysis.problem !== null) {
      this.ctx.diag.error(
        "SQL_UNPARSEABLE",
        `${path}/query`,
        `Query does not lex as SQL: ${analysis.problem}.`,
        {
          problem: analysis.problem,
        },
      );
      return;
    }

    if (node.type === "stateless.transform") {
      if (analysis.hasFrom || analysis.tables.length > 0) {
        this.ctx.diag.error(
          "SQL_FROM_NOT_ALLOWED",
          `${path}/query`,
          `A transform is a FROM-less expression. Reading a table makes it a 'sql' node.`,
          { tables: analysis.tables },
        );
      }
    } else {
      for (const table of analysis.tables) {
        if (this.ctx.ontology.table(table)) continue;
        this.ctx.diag.error(
          "SQL_TABLE_UNKNOWN",
          `${path}/query`,
          `No analytics table '${table}' in the catalog. SQL nodes read the analytics store only — document and cognitive data arrive through source nodes.`,
          { table, known: this.ctx.ontology.tableNames() },
        );
      }
    }

    this.checkDeterminism(analysis, `${path}/query`);

    if (!analysis.outputColumns.some((c) => c.toLowerCase() === "fires")) {
      this.ctx.diag.error(
        "SQL_MISSING_FIRES_COLUMN",
        `${path}/query`,
        `The query must project a boolean 'fires' column — that column is the node's firing signal.`,
        { projected: analysis.outputColumns },
      );
    }

    if (analysis.unaliasedOutputCount > 0) {
      this.ctx.diag.error(
        "SQL_SELECT_ITEM_UNALIASED",
        `${path}/query`,
        `Every projected item needs an explicit alias; a column the validator cannot name is a column downstream references cannot be checked against.`,
        { unaliased: analysis.unaliasedOutputCount, named: analysis.outputColumns },
      );
    }

    this.checkSqlParameters(node, analysis, `${path}/query`);
  }

  /**
   * A watch may not read a clock or roll a die, and SQL is the one place it
   * could. The evaluation instant arrives as the bound `$today` and `$now` —
   * that is what lets a backtest replay time instead of approximating it — and
   * a query calling `now()` would quietly opt out of the whole arrangement.
   */
  checkDeterminism(analysis: SqlAnalysis, path: string): void {
    for (const name of analysis.functions) {
      // The name comes from the query, so the lookup has to be own-property
      // only: `"constructor"()` or `"toString"()` would otherwise resolve up
      // the prototype chain and be reported as a nondeterministic function
      // whose reason is a function object.
      if (!Object.hasOwn(NONDETERMINISTIC_FUNCTIONS, name)) continue;
      const reason = NONDETERMINISTIC_FUNCTIONS[name];
      if (reason === undefined) continue;
      this.ctx.diag.error("SQL_NONDETERMINISTIC_FUNCTION", path, reason, { function: name });
    }
  }

  checkSqlParameters(node: WatchNode, analysis: SqlAnalysis, path: string): void {
    for (const parameter of analysis.parameters) {
      if (parameter.text === "$today" || parameter.text === "$now") continue;

      const parsed = parseExpression(parameter.text);
      if (!parsed.ok) {
        this.ctx.diag.error(
          "SQL_PARAMETER_UNKNOWN",
          path,
          `'${parameter.text}' is not a bindable reference. A query binds $today, $now, $key.*, $n.*.* and $const.*.`,
          { parameter: parameter.text },
        );
        continue;
      }
      // A query never reads a clock and never reaches into its own event.
      this.resolver.resolve(parsed.value, {
        node,
        path,
        event: null,
        edge: null,
        native: null,
        ownKey: this.ctx.keyComponents.get(node.id) ?? new Map(),
        requiresNonNull: true,
        nullableThroughBranch: this.outputs.nullableAncestors(node.id),
      });
    }
  }
  checkLlmNode(node: LlmNode, path: string): void {
    const fields = new Map<string, FieldInfo>();
    for (const [field, type] of Object.entries(node.output_schema)) {
      const parsed = parseValueType(type);
      if (parsed === null) {
        this.ctx.diag.error(
          "TYPE_EXPRESSION_INVALID",
          `${path}/output_schema/${field}`,
          `'${type}' is not a DSL type.`,
          { field, value: type },
        );
        continue;
      }
      fields.set(field, { type: parsed, nullable: false });
    }

    if (node.fire_when !== undefined) {
      const parsed = parsePredicate(node.fire_when);
      if (!parsed.ok) {
        this.ctx.diag.error(
          "EXPRESSION_PARSE_ERROR",
          `${path}/fire_when`,
          `${parsed.error.message} (at offset ${parsed.error.offset}).`,
          { offset: parsed.error.offset },
        );
      } else {
        this.checkFireWhen(parsed.value, fields, `${path}/fire_when`);
      }
    }

    if (node.mode === "investigation") {
      if (node.budget === undefined) {
        this.ctx.diag.warn(
          "LINT_INVESTIGATION_WITHOUT_BUDGET",
          `${path}/budget`,
          `An investigation node holds tools and a token budget of its own; declare 'budget' so the leash is visible in the plan.`,
          { nodeId: node.id },
        );
      }
    } else if (node.tools !== undefined || node.scope !== undefined) {
      this.ctx.diag.error(
        "JUDGE_MODE_HAS_INVESTIGATION_FIELDS",
        path,
        `Judge mode has no tools and no horizon — it decides from the typed evidence its inputs carry.`,
        {
          nodeId: node.id,
          declared: [node.tools ? "tools" : null, node.scope ? "scope" : null].filter(Boolean),
        },
      );
    }
  }
  /** `fire_when` reads the node's own typed output and nothing else. */
  checkFireWhen(predicate: Predicate, fields: ReadonlyMap<string, FieldInfo>, path: string): void {
    const resolveOperand = (expression: Expression): ValueType | null => {
      if (expression.kind === "literal") return expression.type;
      if (expression.kind === "native" && expression.path.length === 1) {
        const field = fields.get(expression.path[0]!);
        if (field) return field.type;
        this.ctx.diag.error(
          "REF_FIELD_UNKNOWN",
          path,
          `'${expression.path[0]}' is not a field of this node's output_schema.`,
          { field: expression.path[0], declared: [...fields.keys()] },
        );
        return null;
      }
      this.ctx.diag.error(
        "REF_FIELD_UNKNOWN",
        path,
        `A fire_when predicate reads only this node's own output fields.`,
        {},
      );
      return null;
    };

    const walk = (p: Predicate): void => {
      switch (p.kind) {
        case "and":
        case "or":
          p.operands.forEach(walk);
          return;
        case "not":
          walk(p.operand);
          return;
        case "truthy": {
          const type = resolveOperand(p.operand);
          if (type && !typesCompatible(type, BOOLEAN)) {
            this.ctx.diag.error(
              "TYPE_MISMATCH",
              path,
              `A bare operand must be boolean; this one is ${formatValueType(type)}.`,
              { expected: "boolean", actual: formatValueType(type) },
            );
          }
          return;
        }
        case "comparison": {
          const left = resolveOperand(p.left);
          const right = resolveOperand(p.right);
          if (left && right && !typesCompatible(left, right)) {
            this.ctx.diag.error(
              "TYPE_MISMATCH",
              path,
              `Cannot compare ${formatValueType(left)} with ${formatValueType(right)}.`,
              { left: formatValueType(left), right: formatValueType(right) },
            );
          }
          if (
            left?.kind === "enum" &&
            p.right.kind === "literal" &&
            typeof p.right.value === "string"
          ) {
            if (!left.values.includes(p.right.value)) {
              this.ctx.diag.error(
                "TYPE_MISMATCH",
                path,
                `'${p.right.value}' is not a member of ${formatValueType(left)}.`,
                { value: p.right.value, members: left.values },
              );
            }
          }
          return;
        }
      }
    };

    walk(predicate);
  }
}
