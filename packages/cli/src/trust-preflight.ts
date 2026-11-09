// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const DEFAULT_GATEWAY_TRUST_EXEMPT_COMMANDS = new Set([
  "--version",
  "-V",
  "--help",
  "-h",
  "help",
  "service",
  "gateway",
  "update",
  // Removes this machine's install; it reads only the disk and must work
  // when the gateway is gone or the install no longer starts.
  "uninstall",
  "agent",
  // `connect` parses its target gateway and performs TOFU against that URL.
  "connect",
  // `pair` redeems against the gateway it was pointed at — a remote one, on a
  // machine that usually has nothing at the default URL — and trusts that
  // target itself, verifying a `--trust-fingerprint` pin when one was given.
  "pair",
  "doctor",
  "keyring",
  "restore",
  "secure",
  // Runs while the gateway deliberately restarts and must not dial it before
  // handing control to the ordinary update command.
  "_portal-fleet-update-run",
]);

/**
 * Subcommands of an otherwise gateway-bound command that must not be held up
 * by a preflight against the default gateway — because they answer from data
 * compiled into the CLI, browse the network, or name their own target. The
 * installer reaches for all three before this machine has a gateway.
 */
const SUBCOMMAND_TRUST_EXEMPT = new Set([
  // Discovery and pairing establish trust with their selected gateway. Owner approval commands use normal trust.
  "cloud login",
  "cloud register",
  "cloud pair",
  "cloud register-key",
  "cloud prepare-owner",
  "cloud issue-invite",
  "cloud link-google",
  "cloud unlink-google",
  // Offline recovery must work even when the gateway and relay are unavailable.
  "cloud recovery-create-authority",
  "cloud recovery-sign-receipt",
  "cloud recovery-sign-policy",
  "cloud recovery-policy-digest",
  "cloud recovery-rotate-session-key",
  "cloud recovery-request",
  "model catalog",
  // Browses the LAN over multicast; it dials no gateway at all, and the
  // installer's collector role runs it before this machine has one.
  "devices discover",
  // The long form of `pair`, with the same target-of-its-own story.
  "devices redeem",
  // Provisioning mints on this host and only reaches the gateway best-effort
  // afterwards, applying the saved copy itself without the preflight's probe;
  // `trust` replaces the very copy the preflight would apply.
  "tls provision",
  "tls refresh",
  "tls trust",
]);

export function isDefaultGatewayTrustExempt(rawArgs: readonly string[]): boolean {
  if (rawArgs.length === 0) return true;
  if (DEFAULT_GATEWAY_TRUST_EXEMPT_COMMANDS.has(rawArgs[0])) return true;
  // A bare `tls` (flags only) is `tls provision`.
  if (rawArgs[0] === "tls" && (rawArgs.length === 1 || rawArgs[1]!.startsWith("-"))) return true;
  return rawArgs.length >= 2 && SUBCOMMAND_TRUST_EXEMPT.has(`${rawArgs[0]} ${rawArgs[1]}`);
}

/** Local maintenance and new-target pairing must remain usable when an old cloud device file is broken. */
export async function bootstrapCliGatewayTransport(
  rawArgs: readonly string[],
  start: () => Promise<void>,
): Promise<void> {
  const terminator = rawArgs.indexOf("--");
  const options = rawArgs.slice(0, terminator < 0 ? undefined : terminator);
  if (
    options.some((value) => ["--help", "-h", "--version", "-V"].includes(value)) ||
    (rawArgs[0] !== "doctor" && isDefaultGatewayTrustExempt(rawArgs))
  )
    return;
  await start();
}
