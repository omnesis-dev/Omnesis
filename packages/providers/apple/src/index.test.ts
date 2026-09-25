// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  validateDocumentEventProfile,
  validateDocumentTemporalProjectionContracts,
} from "@omnesis/source-sdk";
import appleProvider from "./index.js";

describe("apple source descriptors", () => {
  // Each source reads the local databases of the one logged-in macOS user, so
  // there is never a second account to add. Declaring it at the provider level
  // is what stops clients offering "add another account" and then dead-ending
  // on "already configured". (That the flag reaches each source's descriptor
  // is covered by the collector's `extractDescriptors` suite.)
  test("the provider is single-instance and no source opts out", () => {
    expect(appleProvider.singleInstance).toBe(true);
    for (const source of appleProvider.sources) {
      expect(source.singleInstance, `${source.id} singleInstance`).not.toBe(false);
    }
  });

  // #550 regression: the source instance classes used to declare a partial
  // `icon` that the collector resolved via `instance.icon ?? def.icon`,
  // shadowing the descriptor icon and silently dropping its `bgColor`. The
  // descriptor is now the single source of truth, so every apple source's
  // descriptor icon must carry a bgColor for it to reach the gateway/portal.
  test("every apple source descriptor icon carries a bgColor", () => {
    expect(appleProvider.sources.length).toBeGreaterThan(0);
    for (const source of appleProvider.sources) {
      expect(source.icon, `${source.id} icon`).toBeDefined();
      expect(source.icon?.bgColor, `${source.id} icon.bgColor`).toBeTruthy();
    }
  });

  // Each source here emits documents, so each one owes a declaration of what
  // those documents can be asked about — otherwise a watch condition over, say,
  // a reminder's list can only ever compile against the generic fields shared
  // by all documents. The per-source tests pin each declaration to what its
  // normalizer emits; this one keeps a new source from shipping without any.
  test("every apple source declares a valid document-event profile", () => {
    for (const source of appleProvider.sources) {
      expect(source.documentEventProfile, `${source.id} documentEventProfile`).toBeDefined();
      expect(() =>
        validateDocumentEventProfile(source.documentEventProfile, source.id),
      ).not.toThrow();
      expect(
        source.documentEventProfile?.documentTypes?.length,
        `${source.id} documentTypes`,
      ).toBeGreaterThan(0);
      expect(
        source.documentEventProfile?.personRoles?.length,
        `${source.id} personRoles`,
      ).toBeGreaterThan(0);
    }
  });

  test("the reminder source projects due dates with lifecycle-aware status", () => {
    const reminders = appleProvider.sources.find((source) => source.id === "apple-reminders");

    expect(reminders?.documentTemporalProjections).toEqual([
      {
        slot: "due",
        start: "dueAt",
        kind: "deadline",
        modality: "asserted",
        status: {
          from: "status",
          map: { open: "active", completed: "completed" },
          default: "active",
        },
      },
    ]);
    expect(() =>
      validateDocumentTemporalProjectionContracts(
        reminders?.documentTemporalProjections,
        "apple-reminders",
      ),
    ).not.toThrow();
  });

  test("notes declares the app that feeds its store, and may reopen it", async () => {
    // Without this, a Mac whose Notes.app has quit reports apple-notes synced
    // and healthy while its store sits at whatever iCloud last delivered —
    // observed on a real install eight days stale. `pgrep -x` matches the
    // executable name exactly, so "Notes" is the whole contract with the host.
    const definition = appleProvider.sources.find((source) => source.id === "apple-notes");
    const instance = await definition?.create(
      {
        sourceId: "apple-notes:local",
        providerId: "apple:local",
        config: {},
      } as never,
      {
        provider: {
          hasNotes: true,
          notesDbFilePath: "/tmp/example-notes.sqlite",
        },
      } as never,
    );
    expect(instance?.freshness).toMatchObject({
      quietPeriodMs: 14 * 24 * 60 * 60 * 1000,
      requiresProcess: {
        processName: "Notes",
        launch: { macosBundleId: "com.apple.Notes" },
      },
    });
    expect(instance?.freshness?.hint).toMatch(/Notes/);
    expect(instance?.freshness?.requiresProcess?.launch?.failedHint).toMatch(/Notes/);
  });

  test("voicemail freshness requires the exact macOS Phone process", async () => {
    const definition = appleProvider.sources.find((source) => source.id === "apple-voicemail");
    const instance = await definition?.create(
      {
        sourceId: "apple-voicemail:local",
        providerId: "apple:local",
        config: {},
      } as never,
      {
        provider: {
          hasVoicemail: true,
          voicemailDbFilePath: "/tmp/example-voicemail.sqlitedb",
          getVoicemailDb: () => null,
        },
      } as never,
    );
    expect(instance?.freshness).toMatchObject({
      quietPeriodMs: 30 * 24 * 60 * 60 * 1000,
      requiresProcess: { processName: "Phone" },
    });
    expect(instance?.freshness?.hint).toContain("open at login");
  });

  test("voicemail owns native and portable icon representations", () => {
    const voicemail = appleProvider.sources.find((source) => source.id === "apple-voicemail");
    expect(voicemail?.icon?.sfSymbol).toBe("recordingtape");
    expect(voicemail?.icon?.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(voicemail?.icon?.bgColor).toBeTruthy();
  });

  test("voicemail rejects Macs that lack the local Phone database", async () => {
    const definition = appleProvider.sources.find((source) => source.id === "apple-voicemail");
    await expect(
      definition?.create(
        {
          sourceId: "apple-voicemail:local",
          providerId: "apple:local",
          config: {},
        } as never,
        { provider: { hasVoicemail: false } } as never,
      ),
    ).rejects.toThrow(/macOS 26.*Phone/);
  });

  test("replicates only Apple stores whose external ids are stable across Macs", () => {
    expect(appleProvider.multiDevice?.mode).toBe("replicated");
    expect(
      Object.fromEntries(
        appleProvider.sources.map((source) => [
          source.id,
          source.multiDevice?.mode ?? appleProvider.multiDevice?.mode,
        ]),
      ),
    ).toEqual({
      "apple-notes": "replicated",
      "apple-reminders": "replicated",
      "apple-imessage": "replicated",
      "apple-contacts": "exclusive",
      "apple-calendar": "exclusive",
      "apple-call-log": "replicated",
      "apple-voicemail": "replicated",
    });
  });
});
