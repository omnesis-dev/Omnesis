// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  gw,
  buildCliFx,
  iconFor,
  linkify,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

export const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show a document by ID (or unambiguous prefix)",
  },
  args: {
    id: {
      type: "positional",
      description: "document ID (or unambiguous prefix)",
      required: true,
    },
    "metadata-only": {
      type: "boolean",
      description: "Skip rendering document content; show metadata only",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const id = args.id;
    const metadataOnly = args["metadata-only"];
    if (!id) {
      throw new CliError(`${c.red}Usage: omnesis show <id>${c.reset}`, EXIT_USER_ERROR);
    }

    const res = await withSpinner(`Loading document ${id}`, () =>
      gw(`/documents/${encodeURIComponent(id)}`),
    );
    const data = (await res.json()) as Record<string, unknown>;

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

    const metadata =
      typeof data.metadata === "string" ? JSON.parse(data.metadata as string) : data.metadata;

    const fx = await buildCliFx();
    const srcIcon = iconFor(String(data.source_id ?? ""), fx);
    const srcIconPrefix = srcIcon ? `${srcIcon} ` : "";

    console.log(`\n${c.bold}Document${c.reset} ${c.dim}${data.id}${c.reset}\n`);
    console.log(
      `  ${c.dim}Title:${c.reset}          ${srcIconPrefix}${c.bold}${data.title}${c.reset}`,
    );
    console.log(`  ${c.dim}Source:${c.reset}         ${c.cyan}${data.source_id}${c.reset}`);
    console.log(`  ${c.dim}Provider:${c.reset}       ${data.provider_id}`);
    console.log(`  ${c.dim}Created:${c.reset}        ${data.source_created_at}`);
    console.log(`  ${c.dim}Updated:${c.reset}        ${data.source_updated_at}`);
    if (metadata.sourceUrl) {
      console.log(
        `  ${c.dim}URL:${c.reset}            ${c.cyan}${linkify(metadata.sourceUrl, metadata.sourceUrl, fx)}${c.reset}`,
      );
    }
    if (metadata.documentType)
      console.log(`  ${c.dim}Type:${c.reset}           ${metadata.documentType}`);
    if (metadata.relevanceScore != null)
      console.log(
        `  ${c.dim}Relevance:${c.reset}      ${(metadata.relevanceScore * 100).toFixed(0)}%`,
      );

    if (metadata.people && Array.isArray(metadata.people) && metadata.people.length > 0) {
      console.log(`\n${c.bold}People${c.reset}`);
      const roleLabels: Record<string, string> = {
        sender: "Sender",
        author: "Author",
        recipient: "Recipients",
        attendee: "Attendees",
        participant: "Participants",
        owner: "Owner",
        contact: "Contact",
        mentioned: "Mentioned",
      };
      const byRole = new Map<
        string,
        Array<{ name?: string; emails?: string[]; phones?: string[]; lids?: string[] }>
      >();
      for (const p of metadata.people) {
        if (!byRole.has(p.role)) byRole.set(p.role, []);
        byRole.get(p.role)!.push(p);
      }
      for (const [role, persons] of byRole) {
        const label = roleLabels[role] ?? role;
        for (const p of persons) {
          const parts: string[] = [];
          if (p.name) parts.push(`${c.dim}name:${c.reset} ${p.name}`);
          if (p.emails?.length) parts.push(`${c.dim}email:${c.reset} ${p.emails.join(", ")}`);
          if (p.phones?.length) parts.push(`${c.dim}phone:${c.reset} ${p.phones.join(", ")}`);
          if (p.lids?.length) parts.push(`${c.dim}lid:${c.reset} ${p.lids.join(", ")}`);
          const line = parts.join("  ") || "(unknown)";
          console.log(`    ${c.dim}${label}:${c.reset}  ${line}`);
        }
      }
    }

    try {
      const peopleRes = await gw(`/documents/${encodeURIComponent(data.id as string)}/people`);
      if (peopleRes.ok) {
        const { people: resolvedPeople } = (await peopleRes.json()) as {
          people: Array<{
            personId: string;
            canonicalName: string;
            role: string;
            isSelf: boolean;
            aliases: Array<{ aliasType: string; alias: string }>;
          }>;
        };
        if (resolvedPeople.length > 0) {
          console.log(`\n${c.bold}Resolved People${c.reset}`);
          for (const p of resolvedPeople) {
            const selfTag = p.isSelf ? ` ${c.dim}(self)${c.reset}` : "";
            const aliasStr = p.aliases
              .filter((a) => a.aliasType !== "name")
              .map((a) => `${c.dim}${a.aliasType}:${c.reset}${a.alias}`)
              .join("  ");
            console.log(
              `    ${c.dim}${p.role}:${c.reset}  ${p.canonicalName}${selfTag}  ${aliasStr}`,
            );
          }
        }
      }
    } catch {
      /* skip */
    }

    try {
      const refsRes = await gw(`/documents/${encodeURIComponent(data.id as string)}/refs`);
      if (refsRes.ok) {
        const refs = (await refsRes.json()) as {
          outbound: Array<{
            rawTarget: string;
            targetDocId?: string;
            targetTitle?: string;
            linkType?: string;
          }>;
          inbound: Array<{ sourceDocId: string; sourceTitle: string; linkType?: string }>;
        };
        if (refs.outbound.length > 0 || refs.inbound.length > 0) {
          console.log(`\n${c.bold}References${c.reset}`);
          if (refs.outbound.length > 0) {
            console.log(`  ${c.dim}Outbound (${refs.outbound.length}):${c.reset}`);
            for (const ref of refs.outbound) {
              const label = ref.targetTitle ?? ref.rawTarget;
              const truncated = label.length > 80 ? label.slice(0, 77) + "..." : label;
              const resolved = ref.targetDocId ? "" : `${c.dim} (unresolved)${c.reset}`;
              const idHint = ref.targetDocId
                ? `  ${c.dim}${ref.targetDocId.slice(0, 8)}${c.reset}`
                : "";
              console.log(`    ${c.cyan}${truncated}${c.reset}${resolved}${idHint}`);
            }
          }
          if (refs.inbound.length > 0) {
            console.log(`  ${c.dim}Inbound (${refs.inbound.length}):${c.reset}`);
            for (const ref of refs.inbound) {
              const truncated =
                ref.sourceTitle.length > 80
                  ? ref.sourceTitle.slice(0, 77) + "..."
                  : ref.sourceTitle;
              console.log(
                `    ${c.cyan}${truncated}${c.reset}  ${c.dim}${ref.sourceDocId.slice(0, 8)}${c.reset}`,
              );
            }
          }
        }
      }
    } catch {
      /* skip */
    }

    if (!metadataOnly) {
      console.log(`\n${c.dim}${"─".repeat(60)}${c.reset}`);
      console.log(data.content);
    }
  },
});
