// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIPv4, isIPv6 } from "node:net";

/**
 * The bucket every per-client limit counts an address in: IPv4 as is (including
 * the IPv4-mapped IPv6 form), IPv6 by its /64, which one subscriber usually holds
 * whole. Anything else is returned unchanged.
 */
export function clientBucket(address: string): string {
  if (address.toLowerCase().startsWith("::ffff:") && isIPv4(address.slice(7)))
    return address.slice(7);
  if (!isIPv6(address)) return address;
  const [head = "", tail] = address.toLowerCase().split("%")[0]!.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")
    .concat("::/64");
}
