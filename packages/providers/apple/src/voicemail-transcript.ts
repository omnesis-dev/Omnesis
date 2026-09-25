// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface Varint {
  value: number;
  nextOffset: number;
}

function readVarint(buffer: Buffer, start: number, limit = buffer.length): Varint {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < limit && shift <= 49) {
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!Number.isSafeInteger(value)) throw new Error("protobuf varint exceeds safe integer range");
    if ((byte & 0x80) === 0) return { value, nextOffset: offset };
    shift += 7;
  }
  throw new Error("truncated or oversized protobuf varint");
}

function skipField(buffer: Buffer, offset: number, limit: number, wireType: number): number {
  if (wireType === 0) return readVarint(buffer, offset, limit).nextOffset;
  if (wireType === 1) {
    if (offset + 8 > limit) throw new Error("truncated protobuf fixed64");
    return offset + 8;
  }
  if (wireType === 2) {
    const length = readVarint(buffer, offset, limit);
    const end = length.nextOffset + length.value;
    if (end > limit) throw new Error("truncated protobuf field");
    return end;
  }
  if (wireType === 5) {
    if (offset + 4 > limit) throw new Error("truncated protobuf fixed32");
    return offset + 4;
  }
  throw new Error(`unsupported protobuf wire type ${wireType}`);
}

/** Decode ordered caption text from Phone.app's ZTRANSCRIPTDATA protobuf. */
export function decodeVoicemailTranscript(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;
  const captions: string[] = [];
  let offset = 0;
  while (offset < blob.length) {
    const key = readVarint(blob, offset);
    offset = key.nextOffset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value & 7;
    if (fieldNumber === 0) throw new Error("invalid protobuf field number 0");
    if (fieldNumber !== 1 || wireType !== 2) {
      offset = skipField(blob, offset, blob.length, wireType);
      continue;
    }

    const captionLength = readVarint(blob, offset);
    const captionEnd = captionLength.nextOffset + captionLength.value;
    if (captionEnd > blob.length) throw new Error("truncated voicemail caption");
    let captionOffset = captionLength.nextOffset;
    while (captionOffset < captionEnd) {
      const captionKey = readVarint(blob, captionOffset, captionEnd);
      captionOffset = captionKey.nextOffset;
      const captionField = Math.floor(captionKey.value / 8);
      const captionWireType = captionKey.value & 7;
      if (captionField === 0) throw new Error("invalid protobuf caption field number 0");
      if (captionField === 2 && captionWireType === 2) {
        const textLength = readVarint(blob, captionOffset, captionEnd);
        const textEnd = textLength.nextOffset + textLength.value;
        if (textEnd > captionEnd) throw new Error("truncated voicemail caption text");
        const text = blob.subarray(textLength.nextOffset, textEnd).toString("utf8").trim();
        if (text) captions.push(text);
        captionOffset = textEnd;
      } else {
        captionOffset = skipField(blob, captionOffset, captionEnd, captionWireType);
      }
    }
    offset = captionEnd;
  }
  return captions.length > 0 ? captions.join(" ") : undefined;
}
