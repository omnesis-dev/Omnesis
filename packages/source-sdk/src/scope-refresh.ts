// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

/** Provider cursor evidence for one protocol-2 native refresh cut. Never sent to an old gateway. */
export interface ScopeRefreshBookmark {
  epoch: string;
  storeId?: string;
  requestId?: string;
  actorId?: string;
  authority: "holder" | "member";
  after?: string;
  completed?: boolean;
  restarting?: boolean;
}
export interface ScopeRefreshPlan {
  epoch?: string;
  bookmark?: ScopeRefreshBookmark;
  scan: boolean;
  restart: boolean;
  continueImmediately: boolean;
  controls: boolean;
}
export function isScopeRefreshBookmark(value: unknown): value is ScopeRefreshBookmark {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.epoch === "string" &&
    item.epoch.length > 0 &&
    item.epoch.length <= 128 &&
    (item.actorId === undefined ||
      (typeof item.actorId === "string" &&
        item.actorId.length > 0 &&
        item.actorId.length <= 128)) &&
    (item.requestId === undefined ||
      (typeof item.requestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.requestId))) &&
    (item.storeId === undefined ||
      (typeof item.storeId === "string" && item.storeId.length <= 128)) &&
    (item.authority === "holder" || item.authority === "member") &&
    (item.after === undefined || (typeof item.after === "string" && item.after.length <= 512)) &&
    (item.completed === undefined || typeof item.completed === "boolean") &&
    (item.restarting === undefined || typeof item.restarting === "boolean")
  );
}

/** Missing progress may be a lost cursor after partial publication: rotate that cut once first. */
export function planScopeRefresh(
  previous: ScopeRefreshBookmark | undefined,
  epoch: string | undefined,
  supported: boolean,
  role: "holder" | "member" = "holder",
  acknowledgedRequestId?: string,
  actorId?: string,
): ScopeRefreshPlan {
  if (!supported || !epoch)
    return { scan: false, restart: false, continueImmediately: false, controls: false };
  const bookmark =
    previous?.authority === role && (actorId === undefined || previous.actorId === actorId)
      ? previous
      : undefined;
  if (bookmark?.epoch === epoch && !bookmark.restarting)
    return {
      epoch,
      bookmark,
      scan: !bookmark.completed,
      restart: false,
      continueImmediately: true,
      controls: role === "holder",
    };
  if (
    role === "member" ||
    (bookmark?.restarting &&
      bookmark.requestId &&
      bookmark.epoch !== epoch &&
      acknowledgedRequestId === bookmark.requestId)
  )
    return {
      epoch,
      bookmark: {
        epoch,
        authority: role,
        ...(actorId ? { actorId } : {}),
        after: "",
        ...(bookmark?.requestId ? { requestId: bookmark.requestId } : {}),
      },
      scan: true,
      restart: false,
      continueImmediately: true,
      controls: role === "holder",
    };
  const retry = bookmark?.restarting && bookmark.epoch === epoch && !!bookmark.requestId;
  return {
    epoch,
    bookmark: {
      epoch,
      authority: role,
      ...(actorId ? { actorId } : {}),
      restarting: true,
      requestId: retry ? bookmark.requestId : randomUUID(),
    },
    scan: false,
    restart: true,
    // A changed epoch alone may belong to somebody else's cut; only the nonce acknowledges ours.
    continueImmediately: !retry,
    controls: true,
  };
}
