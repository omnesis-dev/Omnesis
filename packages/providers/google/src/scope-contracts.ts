// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MAX_PEOPLE_PER_MESSAGE } from "./gmail-limits.js";
import type { SourceScopes } from "@omnesis/types";

/** Pure source-owned metadata, also packaged for gateways with older collectors. */
export const scopeContracts = {
  gmail: {
    revision: 2,
    items: [
      { kind: "participant", identifiers: ["email", "domain"], link: "fixed" },
      {
        kind: "label",
        noun: { one: "label", many: "labels" },
        picker: "search",
        link: "changes",
      },
    ],
    legacyProjection: {
      participants: {
        roles: ["sender", "recipient"],
        membership: "document",
        maxPeople: MAX_PEOPLE_PER_MESSAGE,
      },
    },
  },
  "google-drive": {
    revision: 3,
    items: [
      {
        kind: "folder",
        noun: { one: "folder", many: "folders" },
        picker: "tree",
        link: "hierarchy",
      },
    ],
  },
} satisfies Record<string, SourceScopes>;
