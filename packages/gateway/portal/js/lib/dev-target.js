// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Derive a developer-annotation target from the current parsed route.
 *
 * The floating capture button (`components/dev-annotation-button.js`) auto-
 * attaches a note to whatever entity the operator is looking at, so one
 * affordance covers every entity type. This maps the router's parsed route
 * object (see `lib/router.js`) to a `{ targetType, targetId, label, deepLink }`
 * descriptor the gateway understands. Any route without a recognised entity
 * falls back to a free-form `route` note carrying the current path — so a note
 * can always be filed, even from a list or settings screen.
 *
 * Kept pure (no DOM / no globals beyond the passed `pathname`) so it is unit
 * testable and cheap to call on every render.
 *
 * @param {{ view?: string, [k: string]: unknown }} route parsed route object
 * @param {string} pathname current `location.pathname`
 * @param {string | null} [activeConvoId] the currently-open agent conversation id
 *   (from app state) — used as the source of truth for the agent view, since a
 *   resumed/auto-loaded conversation rewrites the URL silently and leaves
 *   `route.convoId` null even though a conversation is open.
 * @returns {{ targetType: string, targetId: string | null, label: string, deepLink: string }}
 */
export function deriveDevTarget(route, pathname, activeConvoId = null) {
  const deepLink = pathname || "";
  switch (route?.view) {
    case "document":
      return {
        targetType: "document",
        targetId: route.id ?? null,
        label: route.id ? `Document ${route.id}` : "Document",
        deepLink,
      };
    case "agent": {
      // Prefer the live active conversation (covers resuming a past
      // conversation, where the URL is rewritten silently and `route.convoId`
      // is null); fall back to the parsed route id.
      const convoId = activeConvoId || route.convoId;
      if (convoId) {
        return {
          targetType: "conversation",
          targetId: convoId,
          label: `Conversation ${convoId}`,
          deepLink,
        };
      }
      break;
    }
    case "debug":
      // The cognition inspector renders loops / runs / briefs / calendar
      // annotations in addressable panes; a selected id maps to that entity.
      if (route.tab === "cognition" && route.cognitionId) {
        const map = {
          loops: { type: "open_loop", noun: "Loop" },
          runs: { type: "agent_run", noun: "Run" },
          briefs: { type: "brief", noun: "Brief" },
          "temporal-annotations": {
            type: "temporal_annotation",
            noun: "Temporal annotation",
          },
          // Compatibility for deep links created before the terminology split.
          "time-index": {
            type: "temporal_annotation",
            noun: "Temporal annotation",
          },
        };
        const entry = map[route.cognitionTab];
        if (entry) {
          return {
            targetType: entry.type,
            targetId: route.cognitionId,
            label: `${entry.noun} ${route.cognitionId}`,
            deepLink,
          };
        }
      }
      break;
    default:
      break;
  }
  // No addressable entity in focus — a free-form note tagged with the route.
  return {
    targetType: "route",
    targetId: null,
    label: deepLink ? `General note — ${deepLink}` : "General note",
    deepLink,
  };
}
