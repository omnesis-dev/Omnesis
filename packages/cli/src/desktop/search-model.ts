// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readDesktopInstall } from "./bootstrap.js";
import { requestDesktopGateway } from "./gateway-access.js";
import type { DesktopProfile } from "./environment.js";

const overviewSchema = z.object({
  installed: z.array(z.object({ id: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/i) })),
  activeDownloads: z.array(
    z.object({
      modelId: z.string(),
      progress: z.object({
        downloadedBytes: z.number().nonnegative(),
        totalBytes: z.number().nonnegative(),
      }),
    }),
  ),
});
const configSchema = z.object({
  config: z.object({
    inference: z
      .object({
        assignments: z.object({ embedder: z.string().nullable().optional() }).optional(),
      })
      .optional(),
  }),
});

export type DesktopSearchModel =
  | { state: "ready" | "user-selected" }
  | { state: "downloading"; downloadedBytes: number; totalBytes: number }
  | { state: "needs-download" };

/** The selected model is immutable desktop setup policy until the owner changes it. */
export async function desktopSearchModel(
  profile: DesktopProfile,
  options: { start?: boolean; signal?: AbortSignal } = {},
  dependencies = { install: readDesktopInstall, request: requestDesktopGateway },
): Promise<DesktopSearchModel> {
  options.signal?.throwIfAborted();
  const install = await dependencies.install(profile);
  if (!install || install.phase !== "configured" || install.mode !== "home" || !install.embedder) {
    throw new Error("A configured home library is required for local model setup");
  }
  const config = configSchema.parse(
    await dependencies.request(profile, "/admin/config", { signal: options.signal }),
  );
  const assigned = config.config.inference?.assignments?.embedder;
  if (assigned !== install.embedder && assigned !== `local/${install.embedder}`) {
    return { state: "user-selected" };
  }
  const overview = overviewSchema.parse(
    await dependencies.request(profile, "/admin/models", { signal: options.signal }),
  );
  if (overview.installed.some((entry) => entry.id === install.embedder)) return { state: "ready" };
  const download = overview.activeDownloads.find((entry) => entry.modelId === install.embedder);
  if (download) return { state: "downloading", ...download.progress };
  if (!options.start) return { state: "needs-download" };
  // The gateway owns capacity admission, verified download and indexer activation.
  // A failed job remains an explicit retry, rather than an automatic download loop.
  await dependencies.request(profile, "/admin/models/install", {
    method: "POST",
    body: { id: install.embedder },
    signal: options.signal,
  });
  return { state: "downloading", downloadedBytes: 0, totalBytes: 0 };
}
