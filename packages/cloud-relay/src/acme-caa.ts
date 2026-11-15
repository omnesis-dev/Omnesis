// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a gateway name's CAA records say about who may issue for it (RFC 8659, RFC 8657). Only
 * the records at the name itself count here: they are the ones the broker publishes, and an
 * `accounturi` in them binds issuance to one ACME account.
 */
import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";

/**
 * - `bound`: an issue record names this account, with DNS-01 allowed.
 * - `other-account`: issue records name an account, and none is this one.
 * - `unbound`: no issue record names any account (or there is no CAA record at the name).
 */
export type CaaBinding = "bound" | "other-account" | "unbound";

/** The `issue` property values at exactly this name; undefined when DNS couldn't answer. */
export type CaaLookup = (hostname: string, signal: AbortSignal) => Promise<string[] | undefined>;

export const lookupCaa: CaaLookup = async (hostname, signal) => {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return (await resolver.resolveCaa(hostname))
      .map((record) => record.issue)
      .filter((value): value is string => typeof value === "string");
  } catch (error) {
    signal.throwIfAborted();
    // No record at the name is an answer; a failed lookup is not.
    if (error && typeof error === "object" && "code" in error)
      if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [];
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

function parameters(value: string): Map<string, string> {
  const [, ...rest] = value.split(";");
  return new Map(
    rest
      .map((part) => part.trim())
      .filter((part) => part.includes("="))
      .map((part) => [
        part.slice(0, part.indexOf("=")).trim().toLowerCase(),
        part.slice(part.indexOf("=") + 1).trim(),
      ]),
  );
}

export function caaBinding(issue: string[], accountUri: string): CaaBinding {
  const bound = issue.map(parameters).filter((values) => values.has("accounturi"));
  if (bound.length === 0) return "unbound";
  return bound.some(
    (values) =>
      values.get("accounturi") === accountUri &&
      (!values.has("validationmethods") ||
        values
          .get("validationmethods")!
          .split(",")
          .map((method) => method.trim())
          .includes("dns-01")),
  )
    ? "bound"
    : "other-account";
}

/** A stable identifier of what the name's CAA records said, for the incident hold. */
export function caaObservationDigest(hostname: string, issue: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["omnesis-caa-drift-v1", hostname, [...issue].sort()]))
    .digest("hex");
}
