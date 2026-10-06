// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, londonAt } from "./shared.mjs";
import { dayAt } from "./background-content.mjs";
import { addCorrespondence, addCalls } from "./background-messages.mjs";
import { addCalendars } from "./background-calendar.mjs";
import { addNotes } from "./background-notes.mjs";
import { addContacts } from "./background-contacts.mjs";
import { addActivity } from "./background-activity.mjs";
import { addDesktop } from "./background-desktop.mjs";
import { addCopies } from "./background-copies.mjs";
import { addGithub } from "./background-github.mjs";

/** Compose independently invented native histories in deterministic source order. */
export function buildBackground(ctx) {
  const output = {};
  const put = (descriptor, file, data) => {
    (output[descriptor] ??= {})[file] = data;
  };
  const first = "2016-09-01";
  const last = addDays(ctx.asOf, -1);
  const historical = (i, n) => dayAt(i, n, first, last);
  const state = { ctx, first, last, historical, put };
  const letters = addCorrespondence(state);
  const events = addCalendars(state);
  const files = addNotes(state);
  addContacts(state);
  addActivity(state);
  addCalls(state);
  addDesktop(state);
  addCopies({ ...state, letters, events, files });
  addGithub(state);
  put("granola-meetings", "clock.json", {
    snapshotDay: ctx.asOf,
    syncedAt: londonAt(ctx.asOf, "00:00"),
  });
  return output;
}
