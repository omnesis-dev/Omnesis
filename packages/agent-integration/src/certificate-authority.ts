// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a pinned certificate can never vouch for another one.
 *
 * OpenSSL accepts more than a `CA:TRUE` certificate as an issuer: a version 1
 * self-signed certificate, and a version 3 one that has no basic constraints
 * but whose key usage allows certificate signing, both pass. Node only exposes
 * the `CA:TRUE` case (`X509Certificate.ca`), so this reads the one thing that
 * settles it from the DER: an explicit basic-constraints extension whose `cA`
 * flag is false. OpenSSL refuses such a certificate as an issuer whatever else
 * it carries. Anything else — version 1, no basic constraints, `CA:TRUE`, or a
 * certificate this reader cannot parse — is treated as able to issue.
 */

interface Tlv {
  tag: number;
  contentStart: number;
  end: number;
}

function readTlv(der: Uint8Array, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new Error("truncated DER");
  const tag = der[offset]!;
  let length = der[offset + 1]!;
  let contentStart = offset + 2;
  if (length & 0x80) {
    const octets = length & 0x7f;
    if (octets === 0 || octets > 4 || contentStart + octets > limit) {
      throw new Error("unsupported DER length");
    }
    length = 0;
    for (let i = 0; i < octets; i += 1) length = length * 256 + der[contentStart + i]!;
    contentStart += octets;
  }
  const end = contentStart + length;
  if (end > limit) throw new Error("truncated DER");
  return { tag, contentStart, end };
}

function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const items: Tlv[] = [];
  for (let offset = parent.contentStart; offset < parent.end; ) {
    const item = readTlv(der, offset, parent.end);
    items.push(item);
    offset = item.end;
  }
  return items;
}

const SEQUENCE = 0x30;
const OCTET_STRING = 0x04;
const BOOLEAN = 0x01;
const OBJECT_IDENTIFIER = 0x06;
const VERSION = 0xa0;
const EXTENSIONS = 0xa3;
/** id-ce-basicConstraints, 2.5.29.19. */
const BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];

function isBasicConstraints(der: Uint8Array, oid: Tlv): boolean {
  return (
    oid.tag === OBJECT_IDENTIFIER &&
    oid.end - oid.contentStart === BASIC_CONSTRAINTS.length &&
    BASIC_CONSTRAINTS.every((byte, i) => der[oid.contentStart + i] === byte)
  );
}

/** True only when the certificate explicitly says `CA:FALSE`. */
export function certificateCannotIssue(der: Uint8Array): boolean {
  try {
    const certificate = readTlv(der, 0, der.length);
    if (certificate.tag !== SEQUENCE) return false;
    const tbs = children(der, certificate)[0];
    if (!tbs || tbs.tag !== SEQUENCE) return false;
    const fields = children(der, tbs);
    // A version 1 certificate has no extensions to forbid anything with.
    if (fields[0]?.tag !== VERSION) return false;
    const extensions = fields.find((field) => field.tag === EXTENSIONS);
    if (!extensions) return false;
    const list = children(der, extensions)[0];
    if (!list || list.tag !== SEQUENCE) return false;
    for (const extension of children(der, list)) {
      const [oid, ...rest] = children(der, extension);
      if (!oid || !isBasicConstraints(der, oid)) continue;
      const value = rest.find((item) => item.tag === OCTET_STRING);
      if (!value) return false;
      const constraints = readTlv(der, value.contentStart, value.end);
      if (constraints.tag !== SEQUENCE) return false;
      const first = children(der, constraints)[0];
      // `cA` defaults to false, so an empty sequence forbids issuing too.
      if (!first || first.tag !== BOOLEAN) return true;
      return der[first.contentStart] === 0x00;
    }
    return false;
  } catch {
    return false;
  }
}
