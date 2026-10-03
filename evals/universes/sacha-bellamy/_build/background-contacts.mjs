// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at } from "./shared.mjs";
import { id } from "./background-content.mjs";

export function addContacts(state) {
  const { ctx, first, put } = state;
  const contacts = ctx.cast.people.map((p, i) => {
    const [givenName, ...rest] = p.name.split(" ");
    const day = p.id === "p_maya" ? "2018-05-19" : addDays(first, Math.min(i * 23, 900));
    return {
      externalId: id("contact", i),
      personRef: p.id,
      givenName,
      familyName: rest.join(" "),
      company: i % 7 === 0 ? "Harbour Lantern Software" : null,
      title: i % 7 === 0 ? "Colleague" : null,
      createdAt: at(day),
      modifiedAt: at(addDays(ctx.asOf, -180)),
    };
  });
  put(
    "google-contacts",
    "contacts.json",
    contacts.map((c) => ({ ...c, externalId: `google-${c.externalId}` })),
  );
  put(
    "apple-contacts",
    "contacts.json",
    contacts.map((c) => ({ ...c, externalId: `apple-${c.externalId}` })),
  );
}
