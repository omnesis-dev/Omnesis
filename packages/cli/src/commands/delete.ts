// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  gw,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

/**
 * `omnesis delete <id>` — remove a single document from the corpus for
 * privacy (#1065). The document and its extracted-attachment children are
 * deleted from search. By default a durable tombstone keeps a later re-sync /
 * re-capture from bringing the page back (until the whole source is removed &
 * re-added); `--copy` deletes only this copy and lets the source bring it
 * back. Mirrors the `DELETE /documents/:id` endpoint.
 */
export const deleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete a single document from the corpus (privacy)",
  },
  args: {
    id: {
      type: "positional",
      description: "document ID (or unambiguous prefix)",
      required: true,
    },
    copy: {
      type: "boolean",
      description:
        "Delete only this copy; the next sync or capture may bring the document back (default: delete for good)",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip the confirmation prompt",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const id = args.id;
    if (!id) {
      throw new CliError(`${c.red}Usage: omnesis delete <id>${c.reset}`, EXIT_USER_ERROR);
    }

    // Confirm before a destructive, hard-to-undo delete — unless `--yes`.
    // In a non-interactive context (piped / `--json`) we never block on a
    // prompt: require `--yes` explicitly so a script can't hang.
    let keepCopy = args.copy === true;
    if (!args.yes) {
      if (isJSON || !process.stdout.isTTY) {
        throw new CliError(
          `${c.red}Refusing to delete without confirmation. Re-run with --yes.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const prompts = await import("@clack/prompts");
      // Cancel is first and preselected so a reflexive Enter never deletes.
      const answer = await prompts.select({
        message: `Delete document ${id} from the corpus?`,
        options: [
          { value: "cancel", label: "Cancel" },
          {
            value: "for-good",
            label: "Delete for good",
            hint: "a later sync or capture will not add it back",
          },
          {
            value: "copy",
            label: "Delete this copy",
            hint: "a later sync or capture may add it again",
          },
        ],
        initialValue: keepCopy ? "copy" : "cancel",
      });
      if (prompts.isCancel(answer) || answer === "cancel") {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
      keepCopy = answer === "copy";
    }

    const res = await withSpinner(`Deleting document ${id}`, () =>
      gw(`/documents/${encodeURIComponent(id)}${keepCopy ? "?tombstone=0" : ""}`, {
        method: "DELETE",
      }),
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok) {
      if (data.matches) {
        throw new CliError(
          `${c.red}Ambiguous ID prefix. Matches: ${(data.matches as string[]).join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const code =
        res.status === 401 || res.status === 403
          ? EXIT_AUTH
          : res.status === 404
            ? EXIT_USER_ERROR
            : res.status >= 500
              ? EXIT_GATEWAY_ERROR
              : EXIT_FAILURE;
      throw new CliError(
        `${c.red}${String(data.error ?? `Request returned ${res.status}`)}${c.reset}`,
        code,
      );
    }

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const deleted = typeof data.deleted === "number" ? data.deleted : 0;
    const suffix = deleted === 1 ? "" : ` (${deleted} rows incl. attachments)`;
    const outcome = keepCopy
      ? "; the next sync or capture may bring it back"
      : "; it will not come back";
    console.log(
      `${c.green}Deleted document ${c.bold}${id}${c.reset}${c.green}${suffix}${outcome}${c.reset}`,
    );
  },
});
