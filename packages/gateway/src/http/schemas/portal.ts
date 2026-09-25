// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for `routes/portal.ts`.
 */
import { z } from "zod";
import { nonEmptyString } from "./common.js";

// POST /portal/api/login
export const portalLoginBody = z.object({
  token: nonEmptyString,
  // Stable, unique-per-browser display name the SPA mints once and persists in
  // localStorage, sent on every login. When the login redeems a *nameless*
  // portal pairing code it becomes the device's `suggestedName`, so two
  // different browsers get two distinct `portal` device rows instead of
  // collapsing onto one (which made each new pairing evict the other's
  // session). Ignored for token logins and when the pairing code carries an
  // explicit admin name (that wins). Absent from older cached SPAs.
  //
  // A best-effort cosmetic hint, not a gate: `.catch(undefined)` drops a
  // malformed / over-long value to `undefined` so a bad hint falls back to the
  // `portal` name rather than 400-ing the whole login.
  deviceName: z.string().max(120).optional().catch(undefined),
  // This browser's per-install identity, persisted next to `deviceName`; the
  // gateway adopts the `portal` row carrying it on re-login, whatever the row
  // has been renamed to. Same best-effort treatment.
  installId: z.string().max(120).optional().catch(undefined),
});
export type PortalLoginBody = z.infer<typeof portalLoginBody>;
