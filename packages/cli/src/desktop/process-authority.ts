// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readdir } from "node:fs/promises";
import { z } from "zod";
import { readDesktopGeneration } from "./generation.js";
import { readDesktopPrivateRecord, writeDesktopPrivateRecord } from "./private-record.js";
import { DesktopProcessAuthorityFailure } from "./process-authority-errors.js";
import type { DesktopProfile } from "./profile.js";

const schema = z
  .object({
    version: z.literal(3),
    owner: z.literal("omnesis-desktop"),
    instance: z.string(),
    secretService: z.string(),
  })
  .strict();
export async function assertDesktopProcessAuthority(profile: DesktopProfile): Promise<void> {
  try {
    const value = await readDesktopPrivateRecord(profile, "process-authority.json", (input) =>
      schema.parse(input),
    );
    if (
      !value ||
      value.instance !== profile.instance ||
      value.secretService !== profile.secretService
    )
      throw new DesktopProcessAuthorityFailure();
  } catch {
    throw new DesktopProcessAuthorityFailure();
  }
}

const eraseCertificate = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string(),
    secretService: z.string(),
    operationId: z.string().uuid(),
    mode: z.literal("erase-data"),
    phase: z.literal("complete"),
    root: z
      .object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
      .strict(),
  })
  .strict();

/** Caller holds install lease and passes the journal it just claimed/read under that lease. */
export async function certifyFreshDesktopProcessAuthority(
  profile: DesktopProfile,
  journal: { phase: string; processAuthorityVersion?: 3; instance: string; secretService: string },
): Promise<void> {
  if (
    journal.phase !== "claimed" ||
    journal.processAuthorityVersion !== 3 ||
    journal.instance !== profile.instance ||
    journal.secretService !== profile.secretService
  )
    throw new DesktopProcessAuthorityFailure();
  const existing = await readDesktopPrivateRecord(profile, "process-authority.json", (input) =>
    schema.parse(input),
  );
  if (existing?.instance === profile.instance && existing.secretService === profile.secretService)
    return;
  const entries = await readdir(profile.configDir);
  if (entries.some((name) => name !== "desktop-install.json"))
    throw new DesktopProcessAuthorityFailure();
  const generation = readDesktopGeneration(profile.configDir);
  if (!existing && generation) throw new DesktopProcessAuthorityFailure();
  if (existing) {
    // A fresh-generation commit retains the old certificate until the new claimed journal exists.
    const erased = await readDesktopPrivateRecord(profile, "retirement.json", (input) =>
      eraseCertificate.parse(input),
    );
    if (
      !generation ||
      !erased ||
      generation.previous.instance !== existing.instance ||
      generation.previous.secretService !== existing.secretService ||
      erased.instance !== existing.instance ||
      erased.secretService !== existing.secretService ||
      erased.operationId !== generation.previous.retirementId
    )
      throw new DesktopProcessAuthorityFailure();
  }
  await writeDesktopPrivateRecord(profile, "process-authority.json", {
    version: 3,
    owner: "omnesis-desktop",
    instance: profile.instance,
    secretService: profile.secretService,
  });
  await assertDesktopProcessAuthority(profile);
}
