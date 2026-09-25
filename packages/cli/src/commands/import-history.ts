// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayJson,
  gatewayFetch,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  EXIT_FAILURE,
} from "../utils.js";
import type { HistoryImportSpec } from "@omnesis/source-sdk";

interface AdminSource {
  id: string;
  type: string;
}
interface DescriptorItem {
  id: string;
  unitName?: string;
  historyImport?: HistoryImportSpec;
}

/**
 * `omnesis sources import-history <sourceId>` (#588).
 *
 * Generic, source-agnostic: reads the source's `historyImport` form-spec from
 * its descriptor, prompts for each declared field, POSTs them to the gateway,
 * and streams the import progress over SSE. No source-specific knowledge here —
 * the source owns the artifact format + parsing.
 */
export const importHistoryCommand = defineCommand({
  meta: {
    name: "import-history",
    description: "Import a source's full history from a local backup/artifact",
  },
  async run(ctx) {
    const sourceId = (ctx.args._ as string[])[0];
    if (!sourceId) {
      throw new CliError(
        `${c.red}Usage: omnesis sources import-history <sourceId>${c.reset}\n\n` +
          `Imports a source's complete history from a local backup.\n` +
          `Example: ${c.cyan}omnesis sources import-history <sourceId>${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const sources = await gatewayJson<{ items: AdminSource[] }>(`/admin/sources`);
    const source = sources.items.find((s) => s.id === sourceId);
    if (!source) {
      throw new CliError(`${c.red}Source not found: ${sourceId}${c.reset}`, EXIT_USER_ERROR);
    }

    const descs = await gatewayJson<{ items: DescriptorItem[] }>(`/admin/source-descriptors`);
    const descriptor = descs.items.find((d) => d.id === source.type);
    const spec = descriptor?.historyImport;
    const unit = descriptor?.unitName ?? "item";
    if (!spec) {
      throw new CliError(
        `${c.red}Source ${sourceId} does not support history import.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const prompts = await import("@clack/prompts");
    prompts.intro(spec.label);
    if (spec.description) prompts.note(spec.description);

    const values: Record<string, string> = {};
    for (const field of spec.fields) {
      const message = field.help ? `${field.label} — ${field.help}` : field.label;
      const answer =
        field.type === "secret"
          ? await prompts.password({ message })
          : await prompts.text({ message, placeholder: field.help });
      if (prompts.isCancel(answer)) {
        prompts.cancel("Import cancelled.");
        process.exit(EXIT_CANCELLED);
      }
      const str = String(answer ?? "").trim();
      if (!str && field.required) {
        throw new CliError(`${c.red}${field.label} is required.${c.reset}`, EXIT_USER_ERROR);
      }
      values[field.key] = str;
    }

    const started = await gatewayJson<{ flowId: string }>(
      `/admin/sources/${encodeURIComponent(sourceId)}/import-history`,
      { method: "POST", body: JSON.stringify({ values }) },
    );
    const flowId = started.flowId;
    if (!flowId) throw new CliError(`${c.red}Import did not start.${c.reset}`, EXIT_FAILURE);

    const res = await gatewayFetch(
      `/admin/sources/${encodeURIComponent(sourceId)}/import-history/events?flowId=${encodeURIComponent(flowId)}`,
      { headers: { Accept: "text/event-stream" } },
    );
    if (!res.ok || !res.body) {
      throw new CliError(
        `${c.red}Import event stream failed: ${res.status}${c.reset}`,
        EXIT_FAILURE,
      );
    }

    const spinner = prompts.spinner();
    spinner.start("Importing…");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome: {
      ok: boolean;
      imported?: number;
      merged?: number;
      skipped?: number;
      error?: string;
    } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventName = "message";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (eventName !== "import" || !dataLine) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (payload.type === "progress") {
          const phase = String(payload.phase ?? "");
          const processed = Number(payload.processed ?? 0);
          const total = payload.total != null ? Number(payload.total) : undefined;
          spinner.message(total ? `${phase}: ${processed}/${total}` : `${phase}: ${processed}`);
        } else if (payload.type === "complete") {
          outcome = {
            ok: payload.ok === true,
            imported: payload.imported as number | undefined,
            merged: payload.merged as number | undefined,
            skipped: payload.skipped as number | undefined,
            error: payload.error as string | undefined,
          };
        }
      }
    }

    if (outcome?.ok) {
      spinner.stop("Import complete.");
      prompts.outro(
        `${c.green}Imported ${outcome.imported ?? 0} new ${unit}, ${outcome.merged ?? 0} already present, ${outcome.skipped ?? 0} skipped.${c.reset}`,
      );
    } else {
      spinner.stop("Import failed.");
      throw new CliError(
        `${c.red}Import failed: ${outcome?.error ?? "stream ended without a result"}${c.reset}`,
        EXIT_FAILURE,
      );
    }
  },
});
