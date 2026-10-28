// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  imessageAttachmentMimeType,
  resolveIMessageAttachment,
} from "./imessage-attachment-type.js";
import type { IMessageAttachmentRow } from "./imessage-attachment-type.js";

function row(overrides: Partial<IMessageAttachmentRow>): IMessageAttachmentRow {
  return {
    attachmentRowId: 1,
    guid: "att-1",
    messageRowId: 1,
    filename: "~/Library/Messages/Attachments/ab/01/att-1/file",
    mimeType: null,
    uti: null,
    transferName: null,
    totalBytes: 10,
    ...overrides,
  };
}

describe("imessageAttachmentMimeType", () => {
  test("trusts a stored MIME type over the UTI", () => {
    expect(imessageAttachmentMimeType(row({ mimeType: "audio/mp4", uti: "public.mp3" }))).toBe(
      "audio/mp4",
    );
  });

  test("names an audio message by its UTI when Messages stored no MIME type", () => {
    expect(
      imessageAttachmentMimeType(
        row({ uti: "com.apple.coreaudio-format", transferName: "clip.caf" }),
      ),
    ).toBe("audio/x-caf");
    expect(imessageAttachmentMimeType(row({ mimeType: "  ", uti: "public.jpeg" }))).toBe(
      "image/jpeg",
    );
  });

  test("falls back to the filename extension without a MIME type or a known UTI", () => {
    expect(imessageAttachmentMimeType(row({ uti: "dyn.unknown", transferName: "memo.m4a" }))).toBe(
      "audio/x-m4a",
    );
  });

  test("is empty when nothing names a type the pipeline knows", () => {
    expect(
      imessageAttachmentMimeType(row({ transferName: "payload.pluginPayloadAttachment" })),
    ).toBe("");
    expect(imessageAttachmentMimeType(row({ uti: "constructor" }))).toBe("");
  });
});

describe("resolveIMessageAttachment", () => {
  test("keeps the row's fields and carries the resolved type", () => {
    const resolved = resolveIMessageAttachment(
      row({ guid: "g", uti: "com.apple.coreaudio-format", transferName: "clip.caf" }),
    );
    expect(resolved).toEqual({
      attachmentRowId: 1,
      guid: "g",
      messageRowId: 1,
      filename: "~/Library/Messages/Attachments/ab/01/att-1/file",
      mimeType: "audio/x-caf",
      transferName: "clip.caf",
      totalBytes: 10,
    });
  });
});
