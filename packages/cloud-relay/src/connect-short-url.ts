// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

function https(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A short address a relay may advertise for its connect page, such as a front door that redirects
 * there. It is only ever shown to a person: nothing fetches it, trusts it or redirects from it.
 */
export const connectShortUrlSchema = z
  .string()
  .max(200)
  .refine((value) => https(value) !== undefined)
  .transform((value) => https(value)!.href);

/** The relay's own setting is held to more: an address with nothing to strip or mistake. */
export function configuredConnectShortUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = connectShortUrlSchema.safeParse(value.trim());
  if (!parsed.success || /[?#]/.test(value))
    throw new Error(
      "OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL must be an https URL of at most 200 characters without credentials, query or fragment",
    );
  return parsed.data;
}
