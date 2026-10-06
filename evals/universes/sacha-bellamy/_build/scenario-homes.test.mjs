// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { buildScenarios } from "./scenarios.mjs";
import { context } from "./shared.mjs";

describe("home occupancy evidence", () => {
  it("grounds every recorded move-in in a contemporaneous acknowledgement independent of the lease", () => {
    const { sources, facts } = buildScenarios(context());
    const residenceFact = facts.find((f) => f.id === "F01");
    const messages = sources["whatsapp-messages"]["messages.json"];
    const acknowledgements = [
      "sb-home-2016-occupied",
      "sb-home-2018-occupied",
      "sb-home-2020-occupied",
      "sb-move-arrived",
    ];
    expect(residenceFact.expected.residences).toHaveLength(4);
    for (const [index, residence] of residenceFact.expected.residences.entries()) {
      const acknowledgement = messages.find(
        (message) => message.externalId === acknowledgements[index],
      );
      expect(residenceFact.evidence).toContain(acknowledgement.externalId);
      expect(
        acknowledgement.messages.every((message) => message.at.startsWith(residence.from)),
      ).toBe(true);
      const text = acknowledgement.messages.map((message) => message.text).join("\n");
      expect(text).toMatch(/moved (?:in|into [^.]+) today/i);
      if (index < 3) expect(text).toContain(residence.address);
      else expect(text).toContain(residence.address.split(",")[1].trim().replace(/^\d+ /, ""));
    }
  });

  it("keeps key collection and superseded plans separate from actual 2023 occupancy", () => {
    const { sources, facts } = buildScenarios(context());
    const expected = facts.find((f) => f.id === "F01").expected;
    expect(expected.leaseStart).toBe("2023-03-01");
    expect(expected.actualMove).toBe("2023-04-22");
    expect(expected.residences[2].to).toBe("2023-04-21");
    const initial = sources["whatsapp-messages"]["messages.json"].find(
      (message) => message.externalId === "sb-move-initial",
    );
    const oldStreet = expected.residences[2].address.split(",")[1].trim().replace(/^\d+ /, "");
    expect(initial.messages.map((message) => message.text).join("\n")).toContain(
      `still living in ${oldStreet}`,
    );
  });
});
