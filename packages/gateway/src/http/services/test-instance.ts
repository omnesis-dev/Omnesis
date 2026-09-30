// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface TestInstance {
  session?: string;
  purpose?: string;
}

/** Labels belong to isolated development processes, never the stored user config. */
export function readTestInstance(env: NodeJS.ProcessEnv = process.env): TestInstance | null {
  if (env.OMNESIS_TEST_INSTANCE !== "1") return null;
  // Test labels are single-line display text; reject terminal control characters.
  // eslint-disable-next-line no-control-regex
  const controls = /[\u0000-\u001f\u007f-\u009f]/u;
  const label = (value: string | undefined, limit: number): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed || [...trimmed].length > limit || controls.test(value ?? "")) {
      return undefined;
    }
    return trimmed;
  };
  const session = label(env.OMNESIS_TEST_SESSION, 200);
  const purpose = label(env.OMNESIS_TEST_PURPOSE, 1000);
  return {
    ...(session ? { session } : {}),
    ...(purpose ? { purpose } : {}),
  };
}
