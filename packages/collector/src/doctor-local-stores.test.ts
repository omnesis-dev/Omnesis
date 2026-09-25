// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DoctorLocalStores } from "./doctor-local-stores.js";
import type { DoctorReadAccessSource } from "./doctor-read-access.js";

function source(
  sourceId: string,
  instance: DoctorReadAccessSource["instance"],
): DoctorReadAccessSource {
  return { sourceId, instance };
}

describe("DoctorLocalStores", () => {
  test("tags each source's stores with its id and keeps only the fields the report carries", async () => {
    const stores = await new DoctorLocalStores().collect(
      [
        source("whatsapp:+15550100001", {
          probeLocalStores: async () => [
            { keyName: "whatsapp-store", label: "WhatsApp message archive", state: "encrypted" },
          ],
        }),
        source("gmail:maya@example.com", {}),
        source("apple-imessage", {
          probeLocalStores: async () => [
            {
              keyName: "imessage-transcripts",
              label: "iMessage transcript cache",
              state: "locked",
              detail: "No wrapped key exists for it.",
            },
          ],
        }),
      ],
      new AbortController().signal,
    );
    expect(stores).toEqual([
      {
        sourceId: "whatsapp:+15550100001",
        keyName: "whatsapp-store",
        label: "WhatsApp message archive",
        state: "encrypted",
      },
      {
        sourceId: "apple-imessage",
        keyName: "imessage-transcripts",
        label: "iMessage transcript cache",
        state: "locked",
        detail: "No wrapped key exists for it.",
      },
    ]);
  });

  test("a probe that throws or overruns its budget contributes nothing and blocks nobody", async () => {
    const stores = await new DoctorLocalStores(20).collect(
      [
        source("broken", {
          probeLocalStores: async () => {
            throw new Error("engine missing");
          },
        }),
        source("slow", {
          probeLocalStores: ({ signal }) =>
            new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve([]), { once: true });
            }),
        }),
        source("fine", {
          probeLocalStores: async () => [{ keyName: "k", label: "Store", state: "absent" }],
        }),
      ],
      new AbortController().signal,
    );
    expect(stores).toEqual([{ sourceId: "fine", keyName: "k", label: "Store", state: "absent" }]);
  });

  test("an already cancelled run asks nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let asked = false;
    const stores = await new DoctorLocalStores().collect(
      [
        source("whatsapp:+15550100001", {
          probeLocalStores: async () => {
            asked = true;
            return [];
          },
        }),
      ],
      controller.signal,
    );
    expect(stores).toEqual([]);
    expect(asked).toBe(false);
  });
});
