// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  getPerson,
  resolvePerson,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";

interface CallEntry {
  time: string;
  direction: "incoming" | "outgoing";
  callType:
    | "incoming"
    | "outgoing"
    | "missed"
    | "voicemail"
    | "rejected"
    | "blocked"
    | "answered_externally";
  medium: "voice" | "video";
  durationSeconds: number;
  connected: boolean;
  /** Cast personRef for the peer (resolved via `getPerson`/`resolvePerson`), or null if unidentifiable. */
  counterparty: string | null;
}

interface DailyCallLogEntry {
  externalId: string;
  date: string;
  calls: CallEntry[];
}

let callLogCache: DailyCallLogEntry[] | null = null;
export function loadCallLog(): DailyCallLogEntry[] {
  if (callLogCache) return callLogCache;
  callLogCache = loadSourceFixtureJson<DailyCallLogEntry[]>(
    loadActiveUniverse(),
    "android-call-log",
    "calls.json",
  );
  return callLogCache;
}

function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function mapCallLog(
  e: DailyCallLogEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const lines: string[] = [`# Calls — ${e.date}`, ""];
  let totalDuration = 0;
  const people: PersonMention[] = [personMention("self", "participant")];
  const seenPeers = new Set<string>();
  const calls: Record<string, unknown>[] = [];

  for (const call of e.calls) {
    const time = call.time.slice(11, 16);
    const outgoing = call.direction === "outgoing";
    const medium = call.medium === "video" ? "Video" : "Phone";
    const label = call.counterparty ? getPerson(call.counterparty).name : "Unknown";
    const arrow = outgoing ? "→" : "←";
    const direction = outgoing ? "Outgoing" : "Incoming";
    let qualifier: string;
    if (call.connected) {
      qualifier = `, ${formatCallDuration(call.durationSeconds)}`;
      totalDuration += call.durationSeconds;
    } else {
      qualifier = `, ${call.callType}`;
    }
    lines.push(`- ${time} ${direction} ${medium} ${arrow} ${label}${qualifier}`);

    if (call.counterparty && !seenPeers.has(call.counterparty)) {
      seenPeers.add(call.counterparty);
      people.push(personMention(call.counterparty, "participant"));
    }

    calls.push({
      time: call.time,
      direction: call.direction,
      callType: call.callType,
      medium: call.medium,
      durationSeconds: call.durationSeconds,
      connected: call.connected,
      peer: call.counterparty ? (resolvePerson(call.counterparty).phones[0] ?? null) : null,
    });
  }

  lines.splice(
    2,
    0,
    `**Total:** ${e.calls.length} call${e.calls.length === 1 ? "" : "s"}, ${formatCallDuration(totalDuration)}`,
    "",
  );
  const content = lines.join("\n");

  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: `Calls — ${e.date}`,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}`),
    metadata: {
      documentType: "call-log",
      rollingAggregate: true,
      people,
      extra: {
        date: e.date,
        callCount: e.calls.length,
        totalDurationSeconds: totalDuration,
        calls,
      },
    },
    sourceCreatedAt: `${e.date}T00:00:00.000Z`,
    sourceUpdatedAt: `${e.date}T23:59:59.999Z`,
  };
}
