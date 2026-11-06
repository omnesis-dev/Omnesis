// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { conversationScopeWork, SOURCE_SCOPE_MAX_PAGE_WORK } from "@omnesis/source-sdk";
import { z } from "zod";
import { scopeIdentifierSchema } from "./scope-policy.js";
import { conversationScopeUpdateSchema } from "./scope-conversations.js";
import { hierarchyUpdateSchema } from "./scope-hierarchy-validation.js";

const id = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim().length > 0);
const kind = z.enum(["conversation", "participant", "label", "folder"]);
const entityKind = z.enum(["conversation", "label", "folder"]);
const refreshEpochs = z.partialRecord(kind, z.string().min(1).max(128));
export const documentScopeFactsSchema = z
  .strictObject({
    refreshEpochs: refreshEpochs.optional(),
    kinds: z.array(kind).max(4).optional(),
    facts: z
      .array(
        z.union([
          z.strictObject({ kind: entityKind, id, label: z.string().min(1).max(512).optional() }),
          z.strictObject({ kind: z.literal("participant"), identifier: scopeIdentifierSchema }),
        ]),
      )
      .max(16384),
    complete: z
      .array(kind)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
  })
  .refine(
    (value) =>
      value.kinds === undefined ||
      [...value.facts.map((fact) => fact.kind), ...value.complete].every((item) =>
        value.kinds!.includes(item),
      ),
    { message: "Explicit facts must belong to their declared kinds." },
  );
const documentUpdate = z
  .strictObject({
    externalId: id,
    kinds: z
      .array(kind)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
    facts: documentScopeFactsSchema,
    tags: z.array(z.string().max(512)).max(16384).optional(),
    relevanceScore: z.number().min(0).max(1).optional(),
  })
  .refine(
    (value) =>
      [
        ...(value.facts.kinds ?? []),
        ...value.facts.facts.map((fact) => fact.kind),
        ...value.facts.complete,
      ].every((item) => value.kinds.includes(item)),
    { message: "Facts must belong to the replaced kinds." },
  );
export const sourceScopeUpdatesSchema = z
  .strictObject({
    documents: z.array(documentUpdate).max(256).optional(),
    entities: z
      .array(
        z.strictObject({
          kind: entityKind,
          id,
          label: z.string().min(1).max(512),
          parentId: id.optional(),
        }),
      )
      .max(256)
      .optional(),
    replaceEntityKinds: z.array(entityKind).max(3).optional(),
    readiness: z
      .array(z.strictObject({ kind, complete: z.boolean() }))
      .max(4)
      .optional(),
    refreshes: z
      .array(
        z.strictObject({
          kind,
          active: z.boolean(),
          epoch: id.optional(),
          restart: z.boolean().optional(),
          requestId: z.uuid().optional(),
        }),
      )
      .max(4)
      .optional(),
    hierarchy: hierarchyUpdateSchema.optional(),
    conversations: z
      .array(conversationScopeUpdateSchema)
      .max(256)
      .refine(
        (updates) =>
          updates.reduce((work, update) => work + conversationScopeWork(update), 0) <=
          SOURCE_SCOPE_MAX_PAGE_WORK,
        { message: "Conversation scope update page exceeds the native identifier work limit." },
      )
      .refine((updates) => new Set(updates.map((update) => update.id)).size === updates.length, {
        message: "A page may update each conversation once.",
      })
      .optional(),
  })
  .refine(
    (value) => {
      const unique = (values: readonly string[]) => new Set(values).size === values.length;
      return (
        unique((value.documents ?? []).map((item) => item.externalId)) &&
        unique((value.entities ?? []).map((item) => JSON.stringify([item.kind, item.id]))) &&
        unique(value.replaceEntityKinds ?? []) &&
        unique((value.readiness ?? []).map((item) => item.kind)) &&
        unique((value.refreshes ?? []).map((item) => item.kind))
      );
    },
    { message: "A scope update cannot repeat documents, entities, or kind states." },
  );
