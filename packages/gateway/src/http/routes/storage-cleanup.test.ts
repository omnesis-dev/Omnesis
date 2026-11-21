// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { HttpError, NotFoundError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountStorageRoutes } from "./storage.js";
import type { AppEnv } from "./types.js";
import type { StorageService } from "../../storage/service.js";

function fixture(scopes: Scope[] = [SCOPE_ADMIN]) {
  const service = {
    job: vi.fn((_id: string): unknown => {
      throw new NotFoundError("Storage job not found");
    }),
    startCleanup: vi.fn(async (request) => ({ job: { ...request, state: "queued" } })),
    cleanupJobs: vi.fn(() => ({ jobs: [] })),
    cancelCleanup: vi.fn(async (id) => ({ job: { id, state: "cancelled" } })),
  };
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", deviceId: null, tokenId: null, scopes });
    await next();
  });
  mountStorageRoutes(strictRoute(app), service as unknown as StorageService);
  const post = (body: unknown, path = "/admin/storage/cleanup/jobs") =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, service, post };
}
const before = "2025-01-01T00:00:00.000Z";
describe("storage cleanup authority", () => {
  it("accepts each category, defaults to preserving the newest backup, and honors explicit opt-out", async () => {
    const { post, service } = fixture();
    for (const target of ["brain-transcripts", "conversations", "backups"]) {
      expect((await post({ target, before })).status).toBe(202);
      expect(service.startCleanup).toHaveBeenLastCalledWith({
        target,
        before,
        ...(target === "backups" ? { keepNewest: true } : {}),
      });
    }
    expect((await post({ target: "backups", before, keepNewest: false })).status).toBe(202);
    expect(service.startCleanup).toHaveBeenLastCalledWith({
      target: "backups",
      before,
      keepNewest: false,
    });
  });
  it("rejects noncanonical dates, unknown targets, paths and client-supplied deletion authority", async () => {
    const { post, service } = fixture();
    for (const input of [
      { target: "conversations", before: "invalid" },
      { target: "conversations", before: "2025-01-01" },
      { target: "conversations", before: "2025-01-01T00:00:00Z" },
      { target: "conversations", before, keepNewest: false },
      { target: "backups", before, path: "/fictional" },
      { target: "backups", before, pending: { id: "fictional" } },
      { target: "sources", before },
    ])
      expect((await post(input)).status).toBe(400);
    expect(service.startCleanup).not.toHaveBeenCalled();
  });
  it("requires administrator authority for listing, starting and cancelling", async () => {
    const { app, post, service } = fixture([SCOPE_READ]);
    expect((await app.request("/admin/storage/cleanup/jobs")).status).toBe(403);
    expect(
      (await app.request("/admin/storage/jobs/00000000-0000-4000-8000-000000000001")).status,
    ).toBe(403);
    expect((await post({ target: "backups", before })).status).toBe(403);
    expect(
      (await post({}, "/admin/storage/cleanup/jobs/00000000-0000-4000-8000-000000000001/cancel"))
        .status,
    ).toBe(403);
    expect(service.startCleanup).not.toHaveBeenCalled();
    expect(service.cancelCleanup).not.toHaveBeenCalled();
    expect(service.job).not.toHaveBeenCalled();
  });
  it("validates exact job ids and serves noncached public state for either job family", async () => {
    const { app, service } = fixture();
    const id = "00000000-0000-4000-8000-000000000001";
    expect((await app.request("/admin/storage/jobs/not-a-job")).status).toBe(400);
    expect(service.job).not.toHaveBeenCalled();
    const missing = await app.request(`/admin/storage/jobs/${id}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    for (const kind of ["trim", "cleanup"]) {
      const result = {
        kind,
        job: {
          id,
          state: "completed",
          ...(kind === "trim" ? { cleanupPending: true } : { hasPendingRemoval: false }),
        },
      };
      service.job.mockReturnValueOnce(result);
      const response = await app.request(`/admin/storage/jobs/${id}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(result);
      expect(service.job).toHaveBeenLastCalledWith(id);
    }
  });
  it("validates cancellation ids and returns noncached job state", async () => {
    const { app, post, service } = fixture();
    expect((await post({}, "/admin/storage/cleanup/jobs/not-a-job/cancel")).status).toBe(400);
    expect(service.cancelCleanup).not.toHaveBeenCalled();
    const id = "00000000-0000-4000-8000-000000000001";
    expect((await post({}, `/admin/storage/cleanup/jobs/${id}/cancel`)).status).toBe(200);
    expect(service.cancelCleanup).toHaveBeenCalledWith(id);
    const response = await app.request("/admin/storage/cleanup/jobs");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ jobs: [] });
  });
});
