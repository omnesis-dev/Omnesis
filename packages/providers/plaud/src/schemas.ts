// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shapes Plaud's web API answers with, checked at the boundary.
 *
 * There is no published contract: these follow what Plaud's own web app
 * receives, as documented by the Riffado client. Every field the source does
 * not depend on is optional and unknown keys are dropped, so a field Plaud
 * adds or removes elsewhere changes nothing here; a field the source does
 * depend on that is missing or mistyped fails the response as malformed
 * rather than producing a document from a guess.
 */

import { z } from "zod";

/** Plaud answers a boolean as `true`/`false` on some endpoints and `0`/`1` on others. */
const flag = z
  .union([z.boolean(), z.number()])
  .optional()
  .nullable()
  .transform((v) => v === true || v === 1);

const optionalNumber = z.number().finite().optional().nullable();
const optionalString = z.string().optional().nullable();

/** Fields every `/auth/*` answer carries, at the top level or under `data`. */
const tokenFields = z.object({
  access_token: optionalString,
  refresh_token: optionalString,
  ut_expire_at: optionalNumber,
  urt_expire_at: optionalNumber,
});

export const sendCodeResponseSchema = z.object({
  status: z.number(),
  msg: optionalString,
  token: optionalString,
  data: z
    .object({ domains: z.object({ api: optionalString }).optional().nullable() })
    .optional()
    .nullable(),
});

export const tokenResponseSchema = tokenFields.extend({
  status: optionalNumber,
  msg: optionalString,
  data: tokenFields.optional().nullable(),
});

export const workspaceListSchema = z.object({
  status: z.number(),
  data: z
    .object({
      workspaces: z.array(
        z.object({
          workspace_id: z.string().min(1),
          workspace_type: z.union([z.string(), z.number()]).optional().nullable(),
        }),
      ),
    })
    .optional()
    .nullable(),
});

export const workspaceTokenSchema = z.object({
  status: z.number(),
  data: z.object({ workspace_token: optionalString }).optional().nullable(),
});

/** One recording in the listing. */
export const fileSummarySchema = z.object({
  id: z.string().min(1).max(128),
  filename: optionalString,
  filesize: optionalNumber,
  /** When recording started, ms since the epoch. */
  start_time: z.number().finite(),
  end_time: optionalNumber,
  /** Length of the recording in ms. */
  duration: optionalNumber,
  /** Last edit, in seconds or ms since the epoch depending on the deployment. */
  edit_time: optionalNumber,
  /** Bumped by Plaud on every edit, ms since the epoch. */
  version_ms: optionalNumber,
  serial_number: optionalString,
  filetag_id_list: z.array(z.string()).optional().nullable(),
  keywords: z.array(z.string()).optional().nullable(),
  is_trash: flag,
  is_trans: flag,
  is_summary: flag,
});

export const fileListingSchema = z.object({
  status: z.number(),
  msg: optionalString,
  data_file_total: optionalNumber,
  data_file_list: z.array(z.unknown()).optional().nullable(),
});

export const tempUrlSchema = z.object({
  status: optionalNumber,
  temp_url: optionalString,
  temp_url_opus: optionalString,
});

const contentItemSchema = z.object({
  data_id: optionalString,
  data_type: optionalString,
  task_status: optionalNumber,
  data_link: optionalString,
});

export const fileDetailSchema = z.object({
  status: z.number(),
  msg: optionalString,
  data: z
    .object({
      content_list: z.array(contentItemSchema).optional().nullable(),
      pre_download_content_list: z
        .array(z.object({ data_id: optionalString, data_content: optionalString }))
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
});

export const deviceListSchema = z.object({
  status: z.number(),
  data_devices: z
    .array(z.object({ sn: optionalString, name: optionalString, model: optionalString }))
    .optional()
    .nullable(),
});

export type FileSummary = z.infer<typeof fileSummarySchema>;
export type ContentItem = z.infer<typeof contentItemSchema>;
export type FileDetail = NonNullable<z.infer<typeof fileDetailSchema>["data"]>;
