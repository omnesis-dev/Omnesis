// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Only public ClientHello routing metadata is read. No TLS keys live at the relay. */
export const MAX_CLIENT_HELLO_BYTES = 65_536;

export function clientHelloHostname(input: Buffer): string | undefined {
  if (input.length > MAX_CLIENT_HELLO_BYTES) throw new Error("ClientHello too large");
  const fragments: Buffer[] = [];
  let offset = 0;
  let size = 0;
  let records = 0;
  while (offset + 5 <= input.length) {
    if (++records > 64) throw new Error("Too many ClientHello fragments");
    if (input[offset] !== 22 || input[offset + 1] !== 3)
      throw new Error("TLS ClientHello required");
    const length = input.readUInt16BE(offset + 3);
    if (length === 0 || length > 18_432) throw new Error("Invalid TLS record");
    if (offset + 5 + length > input.length) return undefined;
    fragments.push(input.subarray(offset + 5, offset + 5 + length));
    size += length;
    offset += length + 5;
    const hello = Buffer.concat(fragments, size);
    if (hello.length < 4) continue;
    if (hello[0] !== 1) throw new Error("TLS ClientHello required");
    const expected = hello.readUIntBE(1, 3) + 4;
    if (expected > MAX_CLIENT_HELLO_BYTES) throw new Error("ClientHello too large");
    if (hello.length >= expected) return readServerName(hello.subarray(4, expected));
  }
  return undefined;
}

function readServerName(hello: Buffer): string {
  let offset = 0;
  const take = (length: number): Buffer => {
    if (offset + length > hello.length) throw new Error("Truncated ClientHello");
    const value = hello.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  const byte = (): number => take(1)[0]!;
  const short = (): number => take(2).readUInt16BE(0);
  take(34); // legacy version and random
  take(byte()); // session ID
  const cipherLength = short();
  if (cipherLength === 0 || cipherLength % 2 !== 0) throw new Error("Invalid cipher suites");
  take(cipherLength);
  take(byte()); // legacy compression methods
  const extensionsLength = short();
  if (offset + extensionsLength !== hello.length) throw new Error("Invalid extensions length");
  let hostname: string | undefined;
  while (offset < hello.length) {
    const type = short();
    const extension = take(short());
    if (type !== 0) continue;
    if (hostname !== undefined) throw new Error("Duplicate server name extension");
    if (extension.length < 5 || extension.readUInt16BE(0) !== extension.length - 2)
      throw new Error("Invalid server name list");
    // Exactly one DNS hostname. Other name types and ambiguous lists are refused.
    if (extension[2] !== 0 || extension.readUInt16BE(3) !== extension.length - 5)
      throw new Error("Invalid server name");
    hostname = extension.subarray(5).toString("ascii").toLowerCase();
    if (
      !extension.subarray(5).every((value) => value < 128) ||
      hostname.length > 253 ||
      hostname.split(".").length < 2 ||
      !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      throw new Error("Invalid DNS hostname");
  }
  if (hostname === undefined) throw new Error("TLS server name required");
  return hostname;
}
