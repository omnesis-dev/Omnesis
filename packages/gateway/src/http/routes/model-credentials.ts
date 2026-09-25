// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname as osHostname } from "node:os";
import {
  clearProviderCredentials,
  createLogger,
  validateCredentialFields,
  writeProviderCredentials,
} from "@omnesis/core";
import { buildPage } from "@omnesis/types";
import {
  getModelProviderSpec,
  listModelCredentialEntries,
  type ModelCredentialEntry,
} from "../../model-credentials.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { setModelCredentialsBody } from "../schemas/index.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { RouteApp } from "./types.js";

const log = createLogger("gateway:http").child("routes:model-credentials");

export interface ModelCredentialsRoutesDeps {
  /** Gateway-host config dir — e.g. `~/.config/omnesis`. */
  configDir: string;
  /**
   * Called after a successful credential write/clear so the gateway can
   * re-evaluate model availability without a restart. Best-effort —
   * failures are logged but don't fail the HTTP request, since the file
   * write succeeded.
   */
  onCredentialsChanged?: (fileKey: string) => Promise<void> | void;
}

/**
 * Gateway-local model-provider credential routes — peer to
 * `/admin/credentials/*` (which proxies to the collector for source
 * credentials), but for credentials the gateway itself consumes
 * (Anthropic API key, future OpenAI / Mistral). No WS hop; the file
 * lives on the gateway host's config dir.
 *
 * Auth: every route declares `scope.admin()` at its mount site (the auth
 * middleware no longer pattern-matches paths).
 */
export function mountModelCredentialsRoutes(app: RouteApp, deps: ModelCredentialsRoutesDeps): void {
  const { configDir, onCredentialsChanged } = deps;

  app.get("/admin/model-credentials", scope.admin(), (c) => {
    const entries: ModelCredentialEntry[] = listModelCredentialEntries(configDir);
    // One row per provider — small, capped. Shape mirrors
    // `/admin/credentials`: Page<T> for the entries plus `hostname`
    // sibling.
    return c.json({
      ...buildPage(entries, { hasMore: false, limit: entries.length }),
      hostname: osHostname(),
    });
  });

  app.post(
    "/admin/model-credentials/:fileKey",
    scope.admin(),
    validateJson(setModelCredentialsBody),
    async (c) => {
      const fileKey = c.req.param("fileKey");
      const spec = getModelProviderSpec(fileKey);
      if (!spec) {
        throw new NotFoundError(`Unknown model-provider fileKey: ${fileKey}`);
      }
      const { fields } = c.req.valid("json");
      const result = validateCredentialFields(fields, spec);
      if (!result.ok) throw new BadRequestError(result.error);
      await writeProviderCredentials(fileKey, result.cleaned, configDir);
      log.info(`Model-provider credentials written for ${fileKey}`);
      if (onCredentialsChanged) {
        try {
          await onCredentialsChanged(fileKey);
        } catch (err) {
          log.warn(
            `onCredentialsChanged callback for ${fileKey} threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return c.json({ ok: true, fileKey });
    },
  );

  app.delete("/admin/model-credentials/:fileKey", scope.admin(), async (c) => {
    const fileKey = c.req.param("fileKey");
    if (!getModelProviderSpec(fileKey)) {
      throw new NotFoundError(`Unknown model-provider fileKey: ${fileKey}`);
    }
    await clearProviderCredentials(fileKey, configDir);
    log.info(`Model-provider credentials cleared for ${fileKey}`);
    if (onCredentialsChanged) {
      try {
        await onCredentialsChanged(fileKey);
      } catch (err) {
        log.warn(
          `onCredentialsChanged callback for ${fileKey} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return c.json({ ok: true, fileKey });
  });
}
