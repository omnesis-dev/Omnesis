// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";
import { buildMediaDownloadMessage, withTimeout, isEagerEligible } from "./provider.js";
import whatsappDefinition from "./index.js";
import type { StoredMessage } from "./types.js";

const keys = { mediaKey: "AQID", url: "https://mmg.whatsapp.net/x", directPath: "/v/x" };

function base(over: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m1",
    chatJid: "1234@s.whatsapp.net",
    senderJid: "1234@s.whatsapp.net",
    senderName: "Alice",
    fromMe: false,
    timestamp: 1709900000,
    type: "text",
    text: "",
    ...over,
  };
}

describe("buildMediaDownloadMessage", () => {
  test("reconstructs an audioMessage (ptt) for a voice note — NOT a documentMessage", () => {
    const msg = base({
      type: "audio",
      media: {
        mimetype: "audio/ogg; codecs=opus",
        isVoiceNote: true,
        seconds: 7,
        fileLength: 4096,
        url: "https://mmg.whatsapp.net/aud/abc",
        directPath: "/v/t62/aud",
        mediaKey: "AQID", // base64 of [1,2,3]
        mediaKeyTimestamp: 1709900000,
      },
    });

    const inner = buildMediaDownloadMessage(msg);
    expect(inner.documentMessage).toBeUndefined();
    expect(inner.audioMessage).toBeDefined();
    const audio = inner.audioMessage!;
    expect(audio.ptt).toBe(true);
    expect(audio.seconds).toBe(7);
    expect(audio.mimetype).toBe("audio/ogg; codecs=opus");
    expect(audio.url).toBe("https://mmg.whatsapp.net/aud/abc");
    expect(audio.directPath).toBe("/v/t62/aud");
    expect(audio.mediaKeyTimestamp).toBe(1709900000);
    // mediaKey is decoded from base64 to the raw bytes Baileys needs to decrypt.
    expect(Buffer.isBuffer(audio.mediaKey)).toBe(true);
    expect(Array.from(audio.mediaKey as Buffer)).toEqual([1, 2, 3]);
  });

  test("reconstructs a documentMessage for a document — NOT an audioMessage", () => {
    const msg = base({
      type: "document",
      media: {
        mimetype: "application/pdf",
        filename: "report.pdf",
        fileLength: 2048,
        url: "https://mmg.whatsapp.net/doc/abc",
        directPath: "/v/t62/doc",
        mediaKey: "AQID",
        mediaKeyTimestamp: 1709900000,
      },
    });

    const inner = buildMediaDownloadMessage(msg);
    expect(inner.audioMessage).toBeUndefined();
    expect(inner.documentMessage).toBeDefined();
    expect(inner.documentMessage!.fileName).toBe("report.pdf");
    expect(inner.documentMessage!.mimetype).toBe("application/pdf");
    expect(Buffer.isBuffer(inner.documentMessage!.mediaKey)).toBe(true);
  });

  test("reconstructs an imageMessage for an image — NOT a documentMessage", () => {
    // Decryption keys are derived from the media type's HKDF info string, so an
    // image rebuilt as a documentMessage would fail to decrypt.
    const msg = base({
      type: "image",
      media: {
        mimetype: "image/jpeg",
        fileLength: 874191,
        width: 1536,
        height: 2048,
        url: "https://mmg.whatsapp.net/img/abc",
        directPath: "/v/t62/img",
        mediaKey: "AQID",
        mediaKeyTimestamp: 1709900000,
      },
    });

    const inner = buildMediaDownloadMessage(msg);
    expect(inner.documentMessage).toBeUndefined();
    expect(inner.audioMessage).toBeUndefined();
    expect(inner.imageMessage).toBeDefined();
    expect(inner.imageMessage!.mimetype).toBe("image/jpeg");
    expect(inner.imageMessage!.url).toBe("https://mmg.whatsapp.net/img/abc");
    expect(inner.imageMessage!.directPath).toBe("/v/t62/img");
    expect(inner.imageMessage!.width).toBe(1536);
    expect(inner.imageMessage!.height).toBe(2048);
    expect(inner.imageMessage!.mediaKeyTimestamp).toBe(1709900000);
    expect(Buffer.isBuffer(inner.imageMessage!.mediaKey)).toBe(true);
    expect(Array.from(inner.imageMessage!.mediaKey as Buffer)).toEqual([1, 2, 3]);
  });

  test("a non-voice audio message still reconstructs as audioMessage with ptt falsy", () => {
    const msg = base({
      type: "audio",
      media: { mimetype: "audio/mp4", isVoiceNote: false, mediaKey: "AQID", url: "https://x" },
    });
    const inner = buildMediaDownloadMessage(msg);
    expect(inner.audioMessage).toBeDefined();
    expect(inner.audioMessage!.ptt).toBeFalsy();
  });
});

describe("isEagerEligible", () => {
  test("accepts a small voice note with download descriptors", () => {
    expect(
      isEagerEligible(
        base({ type: "audio", media: { ...keys, isVoiceNote: true, fileLength: 50_000 } }),
      ),
    ).toBe(true);
  });

  test("accepts a voice note with unknown size (audio is always small)", () => {
    expect(isEagerEligible(base({ type: "audio", media: { ...keys, isVoiceNote: true } }))).toBe(
      true,
    );
  });

  test("accepts a small image", () => {
    expect(isEagerEligible(base({ type: "image", media: { ...keys, fileLength: 800_000 } }))).toBe(
      true,
    );
  });

  test("rejects media over the size cap", () => {
    expect(
      isEagerEligible(base({ type: "document", media: { ...keys, fileLength: 5 * 1024 * 1024 } })),
    ).toBe(false);
  });

  test("rejects an unknown-size non-audio item (could be huge)", () => {
    expect(isEagerEligible(base({ type: "document", media: { ...keys } }))).toBe(false);
  });

  test("rejects media without decryption descriptors", () => {
    expect(
      isEagerEligible(base({ type: "audio", media: { isVoiceNote: true, fileLength: 1000 } })),
    ).toBe(false);
  });

  test("rejects non-media message types", () => {
    expect(isEagerEligible(base({ type: "text" }))).toBe(false);
  });
});

describe("withTimeout", () => {
  test("resolves with the value when the promise settles before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "x")).resolves.toBe("ok");
  });

  test("rejects with a timeout error when the promise is slower than the deadline", async () => {
    vi.useFakeTimers();
    try {
      // A promise that never settles (models an offline-phone media re-upload).
      const pending = new Promise<string>(() => {});
      const raced = withTimeout(pending, 50, "media download m1");
      const assertion = expect(raced).rejects.toThrow(/Timed out after 50ms: media download m1/);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("a late rejection from the abandoned promise does not surface as unhandled", async () => {
    let rejectLate: (e: unknown) => void = () => {};
    const slow = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });
    await expect(withTimeout(slow, 0, "x")).rejects.toThrow(/Timed out/);
    // Reject the loser after the race is lost — withTimeout's internal .catch
    // must already have claimed it, so this doesn't throw or warn.
    rejectLate(new Error("late CDN 410"));
    await new Promise((r) => setTimeout(r, 1));
  });
});

describe("WhatsApp account discovery", () => {
  test("declares each linked account as the phone number it is", async () => {
    // The account is the linked phone's own number. Declaring it lets the
    // self-identity resolver match the operator's number instead of guessing
    // what the id means; a pairing still in progress is never discovered.
    const configDir = mkdtempSync(join(tmpdir(), "whatsapp-discover-"));
    try {
      for (const account of ["+15550100123", "_pairing-in-progress"]) {
        const authDir = join(configDir, "whatsapp", account, "auth");
        mkdirSync(authDir, { recursive: true });
        writeFileSync(join(authDir, "creds.json"), "{}");
      }

      const accounts = await whatsappDefinition.discover!({ configDir });

      expect(accounts).toEqual([
        { id: "+15550100123", subject: { kind: "phone", value: "+15550100123" } },
      ]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
