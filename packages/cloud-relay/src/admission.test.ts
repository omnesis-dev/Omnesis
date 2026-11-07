// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { LoginAdmission } from "./admission.js";

test("admission snapshots distinguish in-flight work, current-minute attempts and expired windows", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const admission = new LoginAdmission(2, 4);
  expect(admission.snapshot()).toEqual({
    activeLogins: 0,
    loginAttempts: 0,
    maxConcurrentLogins: 2,
    maxLoginsPerMinute: 4,
  });
  let release!: () => void;
  const work = admission.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(admission.snapshot()).toMatchObject({ activeLogins: 1, loginAttempts: 1 });
  vi.setSystemTime(1800000060000);
  expect(admission.snapshot()).toMatchObject({ activeLogins: 1, loginAttempts: 0 });
  release();
  await work;
  expect(admission.snapshot().activeLogins).toBe(0);
  vi.useRealTimers();
});
