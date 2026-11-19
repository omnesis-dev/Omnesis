// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { createDatabase } from "./db.js";
import { createServer } from "./server.js";

const cleanup = vi.hoisted(() => ({ brain: vi.fn(), analytics: vi.fn() }));
vi.mock("./brain/admin-http.js", () => ({
  mountBrainAdminRoutes: () => ({ close: cleanup.brain }),
}));
vi.mock("./http/routes/analytics.js", () => ({
  mountAnalyticsRoutes: () => ({ close: cleanup.analytics }),
}));

test("server close attempts every owned route disposer and preserves all failures", async () => {
  const db = createDatabase(":memory:");
  const brainError = new Error("invented Brain cleanup failure");
  const analyticsError = new Error("invented analytics cleanup failure");
  cleanup.brain.mockImplementation(() => {
    throw brainError;
  });
  cleanup.analytics.mockRejectedValue(analyticsError);
  const app = createServer(db);
  try {
    const closing = app.close();
    expect(app.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [brainError, analyticsError] });
    expect(cleanup.brain).toHaveBeenCalledOnce();
    expect(cleanup.analytics).toHaveBeenCalledOnce();
    expect(db.open).toBe(true);
    expect(db.prepare("SELECT 1 AS retained").get()).toEqual({ retained: 1 });
  } finally {
    db.close();
    vi.resetAllMocks();
  }
});
