// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { z } from "zod";

/** Advisory device-observed path; never an authentication or trust decision. */
export const connectionPathSchema = z.enum(["local", "relay"]);
export type ConnectionPath = z.infer<typeof connectionPathSchema>;
export function parseConnectionPath(value: unknown): ConnectionPath | undefined {
  const parsed = connectionPathSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
