// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Discovery of addresses this host is reachable at, for pairing QR codes
 * and admin surfaces that need to hand a device-friendly URL to clients
 * on other machines.
 *
 * Callers get a ranked list of candidates (LAN IPs, mDNS hostname, and —
 * where available — Tailscale MagicDNS + tailnet IP). The first entry is
 * always the safest default (typically LAN IP on en0/en1).
 *
 * Tailscale shellout covers macOS and Linux; Windows remains outside discovery.
 */

import { BlockList, isIP } from "node:net";
import { hostname as osHostname, networkInterfaces, platform } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "./logger.js";
import {
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
  type TailscaleCliCandidate,
} from "./tailscale-cli.js";

const execFileAsync = promisify(execFile);
const log = createLogger("core:network-discovery");

/** The stable lowercase `.local` name used in locally issued certificates. */
export function localMdnsHostname(value: string): string {
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  const withoutLocal = normalized.replace(/\.local$/i, "");
  const short = withoutLocal.split(".")[0] ?? "";
  const valid =
    short !== "localhost" &&
    short.length >= 1 &&
    short.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(short);
  return valid ? `${short}.local` : "omnesis.local";
}

const BLOCKED_CERTIFICATE_IPS = new BlockList();
BLOCKED_CERTIFICATE_IPS.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED_CERTIFICATE_IPS.addAddress("0.0.0.0", "ipv4");
BLOCKED_CERTIFICATE_IPS.addSubnet("fe80::", 10, "ipv6");
BLOCKED_CERTIFICATE_IPS.addAddress("::", "ipv6");
BLOCKED_CERTIFICATE_IPS.addAddress("::1", "ipv6");
BLOCKED_CERTIFICATE_IPS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
BLOCKED_CERTIFICATE_IPS.addAddress("::ffff:0.0.0.0", "ipv6");

/** Whether an interface IP is useful and safe to hand to a certificate issuer. */
export function isCertificateIpAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 0) return false;
  return !BLOCKED_CERTIFICATE_IPS.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Preferred LAN interface names, ranked. Unlisted real interfaces (modern
// predictable names like `enP7s7`, `enp3s0`, `wlp2s0`) fall to rank 99 and
// sort after these by name — still included, just not preferred.
const LAN_PREF_ORDER = new Map<string, number>([
  ["en0", 0],
  ["en1", 1],
  ["en2", 2],
  ["en3", 3],
  ["eth0", 0],
  ["eth1", 1], // Linux
  ["Ethernet", 0],
  ["Wi-Fi", 1], // Windows
]);

// Interface name prefixes that are virtual / overlay — never a real LAN
// segment another machine can reach us on. Their IPv4 addresses often look
// like LAN IPs (Docker's default bridge is 172.17.0.1, inside RFC1918), so
// they can only be told apart by interface NAME, not by IP range. Covers
// Docker (`docker0`, `br-*`), Linux/macOS VM bridges (`virbr*`, `vmnet*`,
// `vboxnet*`, `bridge*`), VPN/overlay tunnels (`tun*`, `tap*`, `wg*`,
// `utun*`, `tailscale*`, `zt*`), and Apple-internal links (`awdl*`, `llw*`).
const VIRTUAL_IFACE_PATTERNS: RegExp[] = [
  /^docker/i,
  /^br-/i,
  /^veth/i,
  /^virbr/i,
  /^vmnet/i,
  /^vboxnet/i,
  /^bridge\d/i,
  /^tun\d/i,
  /^tap\d/i,
  /^wg\d/i,
  /^utun\d/i,
  /^tailscale/i,
  /^zt/i,
  /^awdl/i,
  /^llw/i,
];

/** True for a virtual/overlay interface that no off-host client can reach. */
export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_IFACE_PATTERNS.some((re) => re.test(name));
}

/**
 * `os.networkInterfaces()`, but resilient to hosts where the underlying
 * `uv_interface_addresses` syscall fails (observed as EAFNOSUPPORT /
 * "Unknown system error 97" on some machines). A failure is treated as "no
 * interfaces discoverable" — the caller continues with an empty map rather
 * than throwing, mirroring how mDNS advertising degrades. Without this a
 * single failing syscall turns `GET /admin/network-identities` into a 500 and
 * loses the mDNS / Tailscale identities that don't depend on interface
 * enumeration at all.
 *
 * `provider` is injectable for testing; defaults to `os.networkInterfaces`.
 */
export function safeNetworkInterfaces(
  provider: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): ReturnType<typeof networkInterfaces> {
  try {
    return provider();
  } catch (err) {
    log.warn(
      `networkInterfaces() failed (continuing without LAN discovery): ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

/**
 * True if `os.networkInterfaces()` can be called without throwing on this host.
 * Some hosts fail the underlying syscall (EAFNOSUPPORT / "Unknown system
 * error 97"). Callers that would otherwise hand control to code which calls
 * `networkInterfaces()` in an uncatchable async context — notably the
 * `multicast-dns` responder, which invokes it inside a dgram socket callback —
 * gate on this and skip that path entirely, rather than let an async throw
 * crash the process. (`safeNetworkInterfaces` can't help there: the crashing
 * call lives inside the third-party library, not at our call site.)
 *
 * `provider` is injectable for testing; defaults to `os.networkInterfaces`.
 */
export function networkInterfacesUsable(
  provider: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): boolean {
  try {
    provider();
    return true;
  } catch {
    return false;
  }
}

/**
 * Real LAN IPv4 address(es) of this host: non-internal IPv4 on a physical
 * interface, excluding loopback, link-local (169.254), Tailscale/CGNAT
 * (100.64/10), and known virtual/overlay interfaces (Docker, VMs, VPNs).
 * Ordered preferred-name first, then by interface name — so a multi-homed
 * host returns every real LAN IP and a caller that wants one picks `[0]`.
 *
 * `ifaces` is injectable for testing; defaults to `os.networkInterfaces()`.
 */
export function realLanIpv4s(
  ifaces: ReturnType<typeof networkInterfaces> = safeNetworkInterfaces(),
): string[] {
  const picks: Array<{ address: string; rank: number; name: string }> = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (isVirtualInterface(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      if (isTailscaleCgnat(a.address)) continue;
      picks.push({ address: a.address, rank: LAN_PREF_ORDER.get(name) ?? 99, name });
    }
  }
  picks.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return picks.map((p) => p.address);
}

export type NetworkIdentityKind =
  | "lan" // Non-internal IPv4 on a physical interface
  | "mdns" // <hostname>.local via Bonjour
  | "tailscale" // Tailscale 100.x IP
  | "tailscale-magicdns"; // MagicDNS name (preferred for cross-network)

export interface NetworkIdentity {
  /** Hostname or IP to use in a URL. */
  address: string;
  /** Short human label shown in CLI/portal pickers (e.g. "LAN (en0 Wi-Fi)"). */
  label: string;
  /** Category — used for default-picking and sort order. */
  kind: NetworkIdentityKind;
  /**
   * Does this identity reach us from outside the LAN (over WAN via
   * Tailscale etc.)? The portal flags off-LAN identities as the
   * recommended pick when the user is traveling.
   */
  offLan: boolean;
}

/**
 * Discover every address a client could use to reach this host.
 * Ordering: LAN (en* first) → mDNS → Tailscale MagicDNS → tailnet IP.
 * First entry is the recommended default for on-LAN setups.
 */
export async function discoverNetworkIdentities(): Promise<NetworkIdentity[]> {
  const out: NetworkIdentity[] = [];

  // LAN IPv4 addresses. Prefer en*/eth* over everything else; exclude
  // virtual/overlay interfaces (docker, VM bridges, VPN tunnels) and the
  // tailnet IP — they're not a LAN segment another machine reaches us on.
  const lanPicks: Array<{ address: string; name: string; rank: number }> = [];
  const utunTailscaleIps: string[] = [];
  for (const [name, addrs] of Object.entries(safeNetworkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // link-local
      // Tailscale uses 100.64.0.0/10 (CGNAT). If it's on a utun interface
      // surface it as a Tailscale identity below instead of a LAN one —
      // this way we still detect Tailscale even when the CLI isn't
      // installed (e.g. Mac App Store Tailscale with CLI disabled). Done
      // BEFORE the virtual-interface skip, which also matches `utun*`.
      if (/^utun\d+$/.test(name) && isTailscaleCgnat(a.address)) {
        utunTailscaleIps.push(a.address);
        continue;
      }
      if (isVirtualInterface(name)) continue; // docker/VM/VPN/overlay
      if (isTailscaleCgnat(a.address)) continue; // tailnet IP on some other iface
      lanPicks.push({ address: a.address, name, rank: LAN_PREF_ORDER.get(name) ?? 99 });
    }
  }
  lanPicks.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  for (const p of lanPicks) {
    out.push({
      address: p.address,
      label: `LAN (${p.name})`,
      kind: "lan",
      offLan: false,
    });
  }

  // mDNS hostname. `hostname()` on macOS can return the trimmed form
  // ("my-mac"); the .local suffix is what Bonjour resolves.
  const host = osHostname();
  if (host && !host.includes(".")) {
    out.push({
      address: `${host}.local`,
      label: "mDNS (.local)",
      kind: "mdns",
      offLan: false,
    });
  } else if (host?.endsWith(".local")) {
    out.push({ address: host, label: "mDNS (.local)", kind: "mdns", offLan: false });
  }

  // Tailscale. Prefer the CLI — it also gives us MagicDNS, the only identity
  // a `tailscale cert` certificate validates (the cert covers the MagicDNS
  // name, not a raw IP), so it's the address a paired device must use once the
  // gateway is fronted by a Tailscale cert. Probed on macOS and Linux; Windows
  // is still TODO. If no connected CLI is available, fall back to the utun*
  // CGNAT addresses discovered above on macOS.
  const os = platform();
  if (os === "darwin" || os === "linux") {
    const cliIdentities = await discoverTailscale();
    if (cliIdentities.length > 0) {
      out.push(...cliIdentities);
    } else if (os === "darwin") {
      for (const ip of utunTailscaleIps) {
        out.push({
          address: ip,
          label: "Tailscale (utun, off-LAN)",
          kind: "tailscale",
          offLan: true,
        });
      }
    }
  }

  return out;
}

function isTailscaleCgnat(ip: string): boolean {
  // Tailscale uses 100.64.0.0/10 — 100.64.x.x through 100.127.x.x.
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  if (parts[0] !== 100) return false;
  return parts[1] >= 64 && parts[1] <= 127;
}

/**
 * Query each available Tailscale CLI until one reports a connected tailnet.
 * Returns empty when no CLI is connected or status cannot be read.
 *
 * Logs expected absence at debug level and execution failures at warn level,
 * so an unexpected missing MagicDNS identity can be diagnosed.
 */
export async function discoverTailscale(
  candidates: TailscaleCliCandidate[] = tailscaleCliCandidates(),
): Promise<NetworkIdentity[]> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(candidate.file, ["status", "--json"], {
        timeout: 2000,
        env: tailscaleCliEnv(candidate),
      });
      if (!tailscaleIsRunningStatus(result.stdout)) continue;
      return tailscaleIdentitiesFromStatus(result.stdout);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") lastError = err;
    }
  }
  if (lastError) {
    const code = (lastError as NodeJS.ErrnoException)?.code;
    log.warn(
      `tailscale status --json failed (${code ?? "unknown"}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  } else {
    log.debug("no connected tailscale CLI; skipping MagicDNS discovery");
  }
  return [];
}

/**
 * Parse `tailscale status --json` stdout into network identities: the MagicDNS
 * name first (cross-tailnet reachable, and the only identity a `tailscale cert`
 * certificate validates — it covers the name, not a raw IP), then tailnet
 * IPv4s. Pure + exported so the parsing is unit-tested without shelling out;
 * returns [] on invalid JSON or a status with no `Self` (not logged in).
 */
export function tailscaleIdentitiesFromStatus(stdout: string): NetworkIdentity[] {
  let status: {
    Self?: {
      TailscaleIPs?: string[];
      DNSName?: string;
      HostName?: string;
    };
    MagicDNSSuffix?: string;
  };
  try {
    status = JSON.parse(stdout);
  } catch (err) {
    log.warn(
      `tailscale status --json output not valid JSON (likely a tailscale upgrade): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const self = status.Self;
  if (!self) {
    log.debug("tailscale status has no Self section (not logged in?)");
    return [];
  }

  const out: NetworkIdentity[] = [];

  // MagicDNS name — cross-tailnet reachable, best default for mobile.
  // DNSName is fully qualified (e.g. "mac-mini.tail1234.ts.net.").
  if (self.DNSName) {
    const fqdn = self.DNSName.replace(/\.$/, "");
    out.push({
      address: fqdn,
      label: "Tailscale (MagicDNS, off-LAN)",
      kind: "tailscale-magicdns",
      offLan: true,
    });
  }
  // Tailnet IPv4 (100.x). Works even when MagicDNS isn't configured.
  for (const ip of self.TailscaleIPs ?? []) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    out.push({
      address: ip,
      label: "Tailscale (100.x, off-LAN)",
      kind: "tailscale",
      offLan: true,
    });
  }
  return out;
}

/**
 * Rewrite the hostname portion of a gateway URL to use `newHost`.
 * Preserves scheme, port, and path. Strips trailing `/` for neatness.
 */
export function swapHost(gatewayUrl: string, newHost: string): string {
  const url = new URL(gatewayUrl);
  url.hostname = newHost;
  return url.toString().replace(/\/$/, "");
}
