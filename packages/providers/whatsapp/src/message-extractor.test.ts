// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { extractMessage } from "./message-extractor.js";
import type { proto } from "@whiskeysockets/baileys";

function makeWAMessage(overrides: Partial<proto.IWebMessageInfo> = {}): proto.IWebMessageInfo {
  return {
    key: {
      remoteJid: "1234@s.whatsapp.net",
      id: "ABCDEF123",
      fromMe: false,
    },
    messageTimestamp: 1709900000,
    pushName: "Alice",
    message: {
      conversation: "Hello world",
    },
    ...overrides,
  };
}

describe("extractMessage", () => {
  test("extracts plain text message", () => {
    const msg = extractMessage(makeWAMessage());
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("text");
    expect(msg!.text).toBe("Hello world");
    expect(msg!.senderName).toBe("Alice");
    expect(msg!.chatJid).toBe("1234@s.whatsapp.net");
    expect(msg!.fromMe).toBe(false);
    expect(msg!.timestamp).toBe(1709900000);
  });

  test("extracts extended text message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          extendedTextMessage: { text: "Check this link https://example.com" },
        },
      }),
    );
    expect(msg!.type).toBe("text");
    expect(msg!.text).toContain("Check this link");
  });

  test("extracts image message with caption", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          imageMessage: {
            caption: "Nice photo",
            mimetype: "image/jpeg",
            fileLength: 123456 as any,
            width: 1920,
            height: 1080,
          },
        },
      }),
    );
    expect(msg!.type).toBe("image");
    expect(msg!.text).toBe("Nice photo");
    expect(msg!.media?.mimetype).toBe("image/jpeg");
    expect(msg!.media?.width).toBe(1920);
  });

  test("extracts video message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          videoMessage: {
            caption: "Funny video",
            mimetype: "video/mp4",
            seconds: 30,
          },
        },
      }),
    );
    expect(msg!.type).toBe("video");
    expect(msg!.text).toBe("Funny video");
    expect(msg!.media?.seconds).toBe(30);
  });

  test("extracts audio/voice note", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            seconds: 15,
            ptt: true,
          },
        },
      }),
    );
    expect(msg!.type).toBe("audio");
    expect(msg!.media?.isVoiceNote).toBe(true);
    expect(msg!.media?.seconds).toBe(15);
  });

  test("extracts document message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          documentMessage: {
            fileName: "report.pdf",
            mimetype: "application/pdf",
            caption: "Q4 report",
          },
        },
      }),
    );
    expect(msg!.type).toBe("document");
    expect(msg!.text).toBe("Q4 report");
    expect(msg!.media?.filename).toBe("report.pdf");
  });

  test("extracts sticker message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          stickerMessage: { mimetype: "image/webp" },
        },
      }),
    );
    expect(msg!.type).toBe("sticker");
  });

  test("extracts location message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          locationMessage: {
            degreesLatitude: 40.7128,
            degreesLongitude: -74.006,
            name: "Central Park",
            address: "New York, NY",
          },
        },
      }),
    );
    expect(msg!.type).toBe("location");
    expect(msg!.text).toContain("Central Park");
    expect(msg!.text).toContain("New York");
  });

  test("extracts contact message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          contactMessage: { displayName: "Bob Smith" },
        },
      }),
    );
    expect(msg!.type).toBe("contact");
    expect(msg!.text).toBe("Bob Smith");
  });

  test("extracts reaction message", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          reactionMessage: {
            text: "👍",
            key: { id: "target-msg-id" },
          },
        },
      }),
    );
    expect(msg!.type).toBe("reaction");
    expect(msg!.reactionEmoji).toBe("👍");
    expect(msg!.reactionTargetId).toBe("target-msg-id");
  });

  test("extracts quoted message info", () => {
    const msg = extractMessage(
      makeWAMessage({
        message: {
          extendedTextMessage: {
            text: "I agree!",
            contextInfo: {
              quotedMessage: { conversation: "Let's meet tomorrow" },
              participant: "5678@s.whatsapp.net",
            },
          },
        },
      }),
    );
    expect(msg!.text).toBe("I agree!");
    expect(msg!.quotedText).toBe("Let's meet tomorrow");
    expect(msg!.quotedSender).toBe("5678@s.whatsapp.net");
  });

  test("handles group message with participant", () => {
    const msg = extractMessage(
      makeWAMessage({
        key: {
          remoteJid: "group-123@g.us",
          id: "msg-1",
          fromMe: false,
          participant: "5678@s.whatsapp.net",
        },
      }),
    );
    expect(msg!.chatJid).toBe("group-123@g.us");
    expect(msg!.senderJid).toBe("5678@s.whatsapp.net");
  });

  test("returns null for message without key", () => {
    const msg = extractMessage({ key: {} } as any);
    expect(msg).toBeNull();
  });

  test("handles fromMe messages", () => {
    const msg = extractMessage(
      makeWAMessage({
        key: {
          remoteJid: "1234@s.whatsapp.net",
          id: "msg-1",
          fromMe: true,
        },
      }),
    );
    expect(msg!.fromMe).toBe(true);
  });

  test("handles message with no content as system", () => {
    const msg = extractMessage(makeWAMessage({ message: undefined }));
    expect(msg!.type).toBe("system");
  });

  test("preserves download keys for document messages", () => {
    const mediaKey = new Uint8Array([1, 2, 3, 4]);
    const msg = extractMessage(
      makeWAMessage({
        message: {
          documentMessage: {
            fileName: "report.pdf",
            mimetype: "application/pdf",
            caption: "Q4 report",
            url: "https://mmg.whatsapp.net/doc/abc123",
            directPath: "/v/t62.abc/doc123",
            mediaKey,
            mediaKeyTimestamp: 1709900000 as any,
          },
        },
      }),
    );
    expect(msg!.type).toBe("document");
    expect(msg!.media?.url).toBe("https://mmg.whatsapp.net/doc/abc123");
    expect(msg!.media?.directPath).toBe("/v/t62.abc/doc123");
    expect(msg!.media?.mediaKey).toBe(Buffer.from(mediaKey).toString("base64"));
    expect(msg!.media?.mediaKeyTimestamp).toBe(1709900000);
  });

  test("preserves download keys for image messages (needed for OCR)", () => {
    const mediaKey = new Uint8Array([5, 6, 7, 8]);
    const imageMsg = extractMessage(
      makeWAMessage({
        message: {
          imageMessage: {
            caption: "Photo",
            mimetype: "image/jpeg",
            url: "https://mmg.whatsapp.net/img/abc",
            directPath: "/v/t62.abc/img123",
            mediaKey,
            mediaKeyTimestamp: 1709900000 as any,
          },
        },
      }),
    );
    expect(imageMsg!.type).toBe("image");
    expect(imageMsg!.media?.url).toBe("https://mmg.whatsapp.net/img/abc");
    expect(imageMsg!.media?.directPath).toBe("/v/t62.abc/img123");
    expect(imageMsg!.media?.mediaKey).toBe(Buffer.from(mediaKey).toString("base64"));
    expect(imageMsg!.media?.mediaKeyTimestamp).toBe(1709900000);
  });

  test("does NOT preserve download keys for video (no extractor)", () => {
    const videoMsg = extractMessage(
      makeWAMessage({
        message: {
          videoMessage: {
            caption: "Video",
            mimetype: "video/mp4",
            url: "https://mmg.whatsapp.net/vid/abc",
          },
        },
      }),
    );
    expect(videoMsg!.type).toBe("video");
    expect(videoMsg!.media?.url).toBeUndefined();
  });

  test("preserves download keys for voice notes (needed for transcription)", () => {
    const audioMsg = extractMessage(
      makeWAMessage({
        message: {
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
            seconds: 7,
            url: "https://mmg.whatsapp.net/aud/abc",
            directPath: "/v/t62.7117-24/aud",
            mediaKey: new Uint8Array([1, 2, 3, 4]),
            mediaKeyTimestamp: 1_700_000_000,
          },
        },
      }),
    );
    expect(audioMsg!.type).toBe("audio");
    expect(audioMsg!.media?.isVoiceNote).toBe(true);
    expect(audioMsg!.media?.url).toBe("https://mmg.whatsapp.net/aud/abc");
    expect(audioMsg!.media?.directPath).toBe("/v/t62.7117-24/aud");
    expect(audioMsg!.media?.mediaKey).toBeDefined();
    expect(audioMsg!.media?.mediaKeyTimestamp).toBe(1_700_000_000);
  });
});
