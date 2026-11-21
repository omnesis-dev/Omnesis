// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "./structured-source.js";

/** Profile path of the project folder a coding session started in. */
export const LOCAL_AGENT_SESSION_PROJECT_FOLDER_FIELD = "extra.projectFolder";

const PROJECT_FOLDER = { one: "project folder", many: "project folders" };

/** Queryable metadata shared by local coding-agent transcript documents. */
export function createLocalAgentSessionDocumentEventProfile(options: {
  harnessId: string;
  agentName: string;
  /**
   * The source's `outputRevision` from which its documents carry the project
   * folder the session started in.
   */
  projectFolderSince: number;
}): DocumentEventProfile {
  return {
    documentTypes: ["conversation"],
    personRoles: ["participant"],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description:
          "Source harness, terminal channel, and project name when the session records one.",
        canonicalValues: [options.harnessId, "cli"],
      },
      {
        path: "extra.agent",
        type: "string",
        description: "Display name of the coding agent that produced the session.",
        allowedValues: [options.agentName],
      },
      {
        path: "extra.channel",
        type: "string",
        description: "Surface where the coding session ran. Always 'cli'.",
        allowedValues: ["cli"],
        valueAliases: { cli: ["terminal", "command line", "locally"] },
      },
      {
        path: "extra.chatId",
        type: "string",
        description: "Stable source-native session identifier.",
      },
      {
        path: "extra.project",
        type: "string",
        description: "Basename of the session working directory, when recorded.",
      },
      {
        path: "extra.cwd",
        type: "string",
        description: "Working directory recorded by the coding agent.",
      },
      {
        path: LOCAL_AGENT_SESSION_PROJECT_FOLDER_FIELD,
        type: "string",
        description:
          "Id of the project folder the session started in: the working directory the coding agent recorded when the session began, as an absolute path on the device that ran it. Nothing later in the session changes it. Absent when the session file recorded no directory.",
        // A session has one starting folder or an unknown one, never none, so
        // the field is a single value: a list could say "no folder", which a
        // filter would read as safe to share.
        filter: {
          capability: "tree",
          minVersion: options.projectFolderSince,
          // A path only means something on the machine it is on.
          scope: "device",
          noun: PROJECT_FOLDER,
          levels: [PROJECT_FOLDER],
          picker: "tree",
          inside: PROJECT_FOLDER,
        },
      },
      {
        path: "extra.branch",
        type: "string",
        description: "Git branch recorded for the session, when available.",
      },
      {
        path: "extra.model",
        type: "string",
        description: "Last model recorded on the active session path.",
      },
      {
        path: "extra.parentSessionId",
        type: "string",
        description: "Parent or fork source session identifier, when available.",
      },
      {
        path: "extra.messageCount",
        type: "number",
        description: "Number of indexed user and final-assistant turns in this session day.",
      },
    ],
  };
}
