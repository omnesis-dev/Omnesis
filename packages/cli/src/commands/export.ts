// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis export` — portable, non-SQLite data export.
 *
 * Wraps the gateway's `/admin/export*` routes: POSTs to start an export,
 * then polls `/admin/export/status` at 2 Hz rendering the running document
 * count (mirroring `omnesis backup` — no WebSocket dependency).
 * `--list` prints the completed-export table from `/admin/exports`.
 *
 * The export runs on the gateway host and lands in
 * `<configDir>/exports/<timestamp>/` on that machine — the CLI only drives
 * and observes it. `--out` is not honored by the gateway today; the files
 * live next to the gateway's config dir and are copied off-host manually.
 */

import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  gatewayJson,
  formatDateShort,
  isJSON,
  CliError,
  EXIT_FAILURE,
  pickGatewayExitCode,
} from "../utils.js";

type ExportFormat = "json" | "csv";

interface ExportStatusResponse {
  running: boolean;
  current?: {
    exportId: string;
    startedAt: string;
    path: string;
    format: ExportFormat;
    sourceId?: string;
    documentCount: number;
  };
  lastResult?: {
    exportId: string;
    ok: boolean;
    error?: string;
    startedAt: string;
    finishedAt: string;
    path: string;
    format: ExportFormat;
    documentCount: number;
    files: string[];
  };
}

interface ListedExport {
  path: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  format: ExportFormat;
  sourceId?: string;
  documentCount?: number;
  files: string[];
}

const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runExport(opts: { format: ExportFormat; sourceId?: string }): Promise<void> {
  const body: { format?: ExportFormat; sourceId?: string } = { format: opts.format };
  if (opts.sourceId) body.sourceId = opts.sourceId;

  const res = await gatewayFetch("/admin/export", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    throw new CliError(
      `${c.red}An export is already running — check 'omnesis export --list' once it finishes.${c.reset}`,
      EXIT_FAILURE,
    );
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new CliError(
      `${c.red}Export rejected: ${res.status} ${txt}${c.reset}`,
      pickGatewayExitCode(res.status),
    );
  }
  const { exportId } = (await res.json()) as { exportId: string };

  if (!isJSON) {
    console.log(
      `${c.dim}Export started (format=${opts.format}${opts.sourceId ? `, source=${opts.sourceId}` : ""})…${c.reset}`,
    );
  }

  const startMs = Date.now();
  let lastLine = "";
  // Poll until the gateway reports our export as no longer current.
  for (;;) {
    const status = await gatewayJson<ExportStatusResponse>("/admin/export/status");
    const current = status.current;
    if (current && current.exportId === exportId) {
      if (!isJSON) {
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        const line = `\r  ${current.documentCount} document${current.documentCount === 1 ? "" : "s"} exported… [${elapsed}s]`;
        if (line !== lastLine) {
          process.stdout.write(line.padEnd(Math.max(line.length, lastLine.length)));
          lastLine = line;
        }
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const last = status.lastResult;
    if (!last || last.exportId !== exportId) {
      throw new CliError(
        `${c.red}✖${c.reset} Export disappeared from the gateway's status — check gateway logs.`,
        EXIT_FAILURE,
      );
    }
    if (!last.ok) {
      if (isJSON) {
        console.log(JSON.stringify(last));
        throw new CliError("", EXIT_FAILURE);
      }
      throw new CliError(
        `\n${c.red}✖${c.reset} Export failed: ${last.error ?? "unknown error"}`,
        EXIT_FAILURE,
      );
    }
    if (isJSON) {
      console.log(JSON.stringify(last));
    } else {
      if (lastLine) process.stdout.write("\n");
      console.log(
        `${c.green}✔${c.reset} Export complete: ${last.documentCount} documents, ${last.files.length} file(s)`,
      );
      for (const f of last.files) {
        console.log(`    ${f}`);
      }
      console.log(`  ${c.dim}Saved on the gateway host at${c.reset} ${last.path}`);
    }
    return;
  }
}

async function runList(): Promise<void> {
  const { exports } = await gatewayJson<{ exports: ListedExport[] }>("/admin/exports");
  if (isJSON) {
    console.log(JSON.stringify({ exports }));
    return;
  }
  if (exports.length === 0) {
    console.log("No exports yet. Run 'omnesis export' to create one.");
    return;
  }
  console.log();
  console.log(
    `${c.bold}${"STARTED".padEnd(18)} ${"FORMAT".padEnd(7)} ${"DOCS".padEnd(8)} ${"SOURCE".padEnd(20)} PATH${c.reset}`,
  );
  for (const e of exports) {
    const docs = e.documentCount === undefined ? "encrypted" : String(e.documentCount);
    console.log(
      `${formatDateShort(e.startedAt).padEnd(18)} ${e.format.padEnd(7)} ${docs.padEnd(8)} ${(e.sourceId ?? "all").padEnd(20)} ${e.path}`,
    );
  }
  console.log();
}

export const exportCommand = defineCommand({
  meta: {
    name: "export",
    description: "Export documents (and analytics) to a portable JSON/CSV archive on the gateway",
  },
  args: {
    list: {
      type: "boolean",
      description: "List completed exports instead of creating one",
    },
    format: {
      type: "string",
      description: "Output format: json (JSONL) or csv",
      default: "json",
    },
    source: {
      type: "string",
      description: "Limit the export to a single source id (e.g. gmail:you@example.com)",
    },
    out: {
      type: "string",
      description:
        "Output directory hint (reserved; exports currently land in <configDir>/exports on the gateway host)",
    },
    json: {
      type: "boolean",
      description: "Machine-readable output",
    },
  },
  async run(ctx) {
    if (ctx.args.list) {
      await runList();
      return;
    }
    const format = ctx.args.format;
    if (format !== "json" && format !== "csv") {
      throw new CliError(
        `${c.red}Invalid --format '${format}'. Use 'json' or 'csv'.${c.reset}`,
        EXIT_FAILURE,
      );
    }
    const sourceId =
      typeof ctx.args.source === "string" && ctx.args.source ? ctx.args.source : undefined;
    await runExport({ format, sourceId });
  },
});
