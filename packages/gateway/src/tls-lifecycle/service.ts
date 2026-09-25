// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The served certificate over its lifetime: what state it is in, whether
 * something newer is waiting on disk, and renewing it before it expires.
 *
 * Renewal and activation are two different things. Renewal writes new
 * material to the paths the gateway reads; activation swaps it into the
 * listening server (`https.Server.setSecureContext`), so the process never
 * has to restart for a certificate. Every tick re-reads the material from
 * disk, which is how a certificate renewed by a host tool — `tailscale cert`
 * on a Docker host, a certbot hook — reaches the process too.
 *
 * Only material Omnesis minted is ever renewed here: the gateway's own
 * self-signed pair, and the Tailscale and mkcert tiers the installer or
 * `omnesis tls provision` wrote. A replacement is verified — it parses, the
 * key belongs to it, it is inside its validity window, and it covers the
 * names the outgoing certificate was serving — before it touches the paths
 * the gateway loads at boot, so a failed renewal leaves a usable certificate
 * in place. An expired certificate that could not be replaced stays
 * reported as expired.
 */

import { X509Certificate } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import {
  assertNever,
  certificateCoversHost,
  certificateNames,
  createLogger,
  inspectTlsMaterial,
  resolveTlsMaterial,
  type TlsLifecycleSnapshot,
  type TlsMaterialInspection,
  type TlsOwnership,
  type TlsRenewalMode,
} from "@omnesis/core";
import { fingerprintFromCertPem } from "../tls.js";

const log = createLogger("gateway").child("tls");

export interface TlsPem {
  cert: string;
  key: string;
}

/** Mints a replacement for material Omnesis owns. Throws when it cannot. */
export interface TlsMinter {
  mint(
    ownership: Exclude<TlsOwnership, "external">,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<TlsPem>;
}

export interface TlsLifecycleSettings {
  autoRenew: boolean;
  renewBeforeDays: number;
}

export interface TlsLifecycleServiceOptions {
  configDir: string;
  /** What the server was started with. */
  initial: TlsPem;
  /** Swap material into the listening server. */
  activate: (material: TlsPem) => void;
  /** `OMNESIS_TLS_CERT` / `OMNESIS_TLS_KEY` as the gateway reads them now. */
  materialPaths: () => { certPath?: string | null; keyPath?: string | null };
  /** Hostnames and IP literals clients address this gateway by. */
  requiredHosts: () => string[];
  /** Names a trusted reverse proxy serves with its own certificate; reported, never required. */
  proxiedHosts?: () => string[];
  minter: TlsMinter;
  settings: () => TlsLifecycleSettings;
  /** A container cannot reach the host's `tailscale` or `mkcert`; those tiers renew on the host. */
  inContainer?: boolean;
  now?: () => number;
  /** Told after every activation whose fingerprint differs from the previous one. */
  onRotation?: (fingerprintSha256: string) => void;
}

/** Renewal state that survives a restart, beside the material it describes. */
interface LifecycleRecord {
  lastAttemptAt: string | null;
  lastError: string | null;
  lastRenewedAt: string | null;
  rotation: { previousFingerprintSha256: string; rotatedAt: string } | null;
}

export type RenewOutcome =
  | { ok: true; fingerprintSha256: string; snapshot: TlsLifecycleSnapshot }
  | { ok: false; reason: string; snapshot: TlsLifecycleSnapshot };

const RECORD_FILE = "lifecycle.json";
const LOCK_FILE = ".renew.lock";
/** A lock older than this belongs to a renewal that died; it is taken over. */
const LOCK_STALE_MS = 10 * 60 * 1000;

const EMPTY_RECORD: LifecycleRecord = {
  lastAttemptAt: null,
  lastError: null,
  lastRenewedAt: null,
  rotation: null,
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TlsLifecycleService {
  private served: TlsPem & { fingerprintSha256: string };
  private record: LifecycleRecord;
  private pendingReplacement: TlsLifecycleSnapshot["pendingReplacement"] = null;
  private renewing: Promise<RenewOutcome> | null = null;
  private readonly now: () => number;
  private readonly tlsDir: string;

  constructor(private readonly options: TlsLifecycleServiceOptions) {
    this.now = options.now ?? Date.now;
    this.tlsDir = join(options.configDir, "tls");
    this.served = {
      ...options.initial,
      fingerprintSha256: fingerprintFromCertPem(options.initial.cert),
    };
    this.record = this.readRecord();
  }

  /** The fingerprint of the certificate the server presents right now. */
  fingerprintSha256(): string {
    return this.served.fingerprintSha256;
  }

  /**
   * The DNS names of the served certificate that a phone verifies through its
   * platform trust store. Only a Tailscale certificate qualifies: it chains to
   * a public CA. An mkcert certificate chains to a CA only this host trusts,
   * an external one's chain is unknown, and a self-signed one has none. An
   * expired certificate is trusted by nobody, so it names nothing.
   */
  publiclyTrustedNames(): string[] {
    if (this.material().ownership !== "tailscale") return [];
    const cert = new X509Certificate(this.served.cert);
    if (cert.checkIssued(cert) || Date.parse(cert.validTo) <= this.now()) return [];
    return certificateNames(cert).filter((name) => isIP(name) === 0 && !name.startsWith("*."));
  }

  /**
   * When the gateway will next replace the certificate it serves, for a
   * certificate it renews itself (a Tailscale or mkcert one). A client that
   * pinned this certificate's fingerprint stops connecting then. Null for the
   * self-signed certificate, which lasts ten years, and for material Omnesis
   * does not renew. Also null while configured material has not replaced a
   * served self-signed certificate: the served one is what a phone pins.
   */
  nextRenewalAt(): Date | null {
    const material = this.material();
    if (material.ownership === "self-signed" || material.ownership === "external") return null;
    const settings = this.options.settings();
    if (this.renewalMode(material.ownership, settings) === "disabled") return null;
    const cert = new X509Certificate(this.served.cert);
    if (cert.checkIssued(cert)) return null;
    const notAfter = Date.parse(cert.validTo);
    if (Number.isNaN(notAfter)) return null;
    return new Date(
      Math.max(this.now(), notAfter - settings.renewBeforeDays * 24 * 60 * 60 * 1000),
    );
  }

  snapshot(): TlsLifecycleSnapshot {
    const material = this.material();
    const settings = this.options.settings();
    return {
      checkedAt: new Date(this.now()).toISOString(),
      ownership: material.ownership,
      certPath: material.certPath,
      keyPath: material.keyPath,
      served: this.inspect(this.served, settings.renewBeforeDays),
      pendingReplacement: this.pendingReplacement,
      renewal: {
        mode: this.renewalMode(material.ownership, settings),
        renewBeforeDays: settings.renewBeforeDays,
        lastAttemptAt: this.record.lastAttemptAt,
        lastError: this.record.lastError,
        lastRenewedAt: this.record.lastRenewedAt,
      },
      rotation: this.record.rotation,
      proxiedHosts: this.options.proxiedHosts?.() ?? [],
    };
  }

  /**
   * One tick: activate a valid replacement found on disk, then renew what
   * Omnesis owns when it is inside the renewal band. Never rejects.
   */
  async refresh(signal: AbortSignal): Promise<TlsLifecycleSnapshot> {
    try {
      this.activateFromDisk();
      const snapshot = this.snapshot();
      const due = snapshot.served.state === "expiring" || snapshot.served.state === "expired";
      if (due && snapshot.renewal.mode === "automatic" && !signal.aborted) {
        const outcome = await this.renew(signal);
        return outcome.snapshot;
      }
      return snapshot;
    } catch (err) {
      log.warn(`TLS lifecycle tick failed: ${errorText(err)}`);
      return this.snapshot();
    }
  }

  /**
   * Re-read the material paths and activate what is there when it differs
   * from what is served and passes verification. Something that does not
   * pass is reported, and the served material stays.
   */
  activateFromDisk(): TlsLifecycleSnapshot["pendingReplacement"] {
    const material = this.material();
    let disk: TlsPem;
    try {
      disk = {
        cert: readFileSync(material.certPath, "utf8"),
        key: readFileSync(material.keyPath, "utf8"),
      };
    } catch (err) {
      this.pendingReplacement = {
        fingerprintSha256: null,
        error: `The material at ${material.certPath} could not be read: ${errorText(err)}`,
      };
      return this.pendingReplacement;
    }
    if (disk.cert === this.served.cert && disk.key === this.served.key) {
      this.pendingReplacement = null;
      return null;
    }
    // Coverage of the addressed names is reported on the served material,
    // not enforced here: what an operator or a host tool wrote is theirs to
    // serve, as long as it is a usable pair.
    const inspection = this.inspect(disk, 0, []);
    const verdict = replacementVerdict(inspection);
    if (verdict) {
      this.pendingReplacement = { fingerprintSha256: inspection.fingerprintSha256, error: verdict };
      log.warn(`A replacement certificate at ${material.certPath} was not activated: ${verdict}`);
      return this.pendingReplacement;
    }
    try {
      this.activate(disk, inspection.fingerprintSha256!, "disk");
    } catch (err) {
      this.pendingReplacement = {
        fingerprintSha256: inspection.fingerprintSha256,
        error: `it could not be activated: ${errorText(err)}`,
      };
      return this.pendingReplacement;
    }
    this.pendingReplacement = null;
    return null;
  }

  /**
   * Mint, verify, write and activate a replacement for material Omnesis
   * owns. `force` renews material that is not yet due and material whose
   * automatic renewal is switched off; it never touches an operator's own.
   * Concurrent calls share one attempt; another process's attempt (the
   * lock file beside the material) is reported, not raced.
   */
  renew(signal: AbortSignal, opts: { force?: boolean } = {}): Promise<RenewOutcome> {
    if (this.renewing) return this.renewing;
    this.renewing = this.renewOnce(signal, opts).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewOnce(signal: AbortSignal, opts: { force?: boolean }): Promise<RenewOutcome> {
    const material = this.material();
    const settings = this.options.settings();
    const mode = this.renewalMode(material.ownership, settings);
    const refuse = (reason: string): RenewOutcome => ({
      ok: false,
      reason,
      snapshot: this.snapshot(),
    });
    if (mode === "external") {
      return refuse(
        `The certificate at ${material.certPath} is operator-managed; renew it with the tool that issued it, then \`omnesis tls reload\`.`,
      );
    }
    if (mode === "host") {
      return refuse(
        `The ${material.ownership} certificate is renewed on the host, not inside this container; re-run its issuer there, then \`omnesis tls reload\`.`,
      );
    }
    if (mode === "disabled" && !opts.force) {
      return refuse("Automatic renewal is switched off (gateway.tls.autoRenew).");
    }
    const served = this.inspect(this.served, settings.renewBeforeDays);
    if (!opts.force && served.state !== "expiring" && served.state !== "expired") {
      return refuse(
        `The certificate is not due for renewal (${served.daysRemaining} days remain; renewal starts ${settings.renewBeforeDays} days before expiry).`,
      );
    }
    const ownership = material.ownership as Exclude<TlsOwnership, "external">;

    let lock: ReturnType<TlsLifecycleService["takeLock"]>;
    try {
      lock = this.takeLock();
    } catch (err) {
      return refuse(`The renewal lock could not be taken: ${errorText(err)}`);
    }
    if (!lock.taken) return refuse(lock.reason);

    const startedAt = this.now();
    this.record = { ...this.record, lastAttemptAt: new Date(startedAt).toISOString() };
    const fail = (reason: string): RenewOutcome => {
      this.record = { ...this.record, lastError: reason };
      this.writeRecord();
      log.warn(`TLS renewal (${ownership}) failed: ${reason}`);
      return { ok: false, reason, snapshot: this.snapshot() };
    };
    try {
      // The names the replacement must keep covering: what the tiers were
      // minted for, or — for the self-signed pair, whose names are re-derived
      // from the host — whichever addressed names the outgoing one covers.
      const outgoing = new X509Certificate(this.served.cert);
      const intended =
        ownership === "self-signed"
          ? this.options.requiredHosts().filter((host) => certificateCoversHost(outgoing, host))
          : served.names;

      let minted: TlsPem;
      try {
        minted = await this.options.minter.mint(ownership, served.names, signal);
      } catch (err) {
        return fail(errorText(err));
      }
      const inspection = this.inspect(minted, 0, intended);
      const verdict = replacementVerdict(inspection);
      if (verdict) {
        const stale =
          verdict.startsWith("it does not cover") && ownership === "self-signed"
            ? " (a name in OMNESIS_GATEWAY_URL or a pairing origin the host no longer answers to has to be changed there first)"
            : "";
        return fail(`the minted certificate was rejected: ${verdict}${stale}`);
      }

      // Disk and the served material move together: a write or activation
      // that fails leaves the pair the server presents in place, on disk too,
      // so the next boot loads what is being served now.
      try {
        this.writeMaterial(material.certPath, material.keyPath, minted);
        this.activate(minted, inspection.fingerprintSha256!, ownership);
      } catch (err) {
        try {
          this.writeMaterial(material.certPath, material.keyPath, this.served);
        } catch (restoreErr) {
          log.error(
            `The served TLS pair could not be restored to ${material.certPath} after a failed renewal: ${errorText(restoreErr)}`,
          );
        }
        return fail(`the renewed material could not be put into service: ${errorText(err)}`);
      }
      this.pendingReplacement = null;
      this.record = {
        ...this.record,
        lastError: null,
        lastRenewedAt: new Date(this.now()).toISOString(),
      };
      this.writeRecord();
      return {
        ok: true,
        fingerprintSha256: inspection.fingerprintSha256!,
        snapshot: this.snapshot(),
      };
    } finally {
      lock.release();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private material() {
    const paths = this.options.materialPaths();
    return resolveTlsMaterial({
      configDir: this.options.configDir,
      certPath: paths.certPath,
      keyPath: paths.keyPath,
    });
  }

  private renewalMode(ownership: TlsOwnership, settings: TlsLifecycleSettings): TlsRenewalMode {
    if (ownership === "external") return "external";
    if (ownership !== "self-signed" && this.options.inContainer) return "host";
    return settings.autoRenew ? "automatic" : "disabled";
  }

  private inspect(
    material: TlsPem,
    renewBeforeDays: number,
    requiredHosts: readonly string[] = this.options.requiredHosts(),
  ): TlsMaterialInspection {
    return inspectTlsMaterial({
      certPem: material.cert,
      keyPem: material.key,
      now: this.now(),
      renewBeforeDays,
      requiredHosts,
    });
  }

  private activate(material: TlsPem, fingerprintSha256: string, origin: string): void {
    this.options.activate(material);
    const previous = this.served.fingerprintSha256;
    this.served = { ...material, fingerprintSha256 };
    if (previous !== fingerprintSha256) {
      this.record = {
        ...this.record,
        rotation: {
          previousFingerprintSha256: previous,
          rotatedAt: new Date(this.now()).toISOString(),
        },
      };
      this.writeRecord();
      log.info(
        `Activated a new TLS certificate (${origin}); fingerprint ${previous} -> ${fingerprintSha256}`,
      );
      this.options.onRotation?.(fingerprintSha256);
    } else {
      log.info(`Activated re-read TLS material (${origin}); fingerprint unchanged`);
    }
  }

  /** Write the pair beside its targets, then rename each into place. */
  private writeMaterial(certPath: string, keyPath: string, material: TlsPem): void {
    mkdirSync(dirname(certPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    const suffix = `.renew-${process.pid}`;
    const certTmp = `${certPath}${suffix}`;
    const keyTmp = `${keyPath}${suffix}`;
    try {
      writeFileSync(certTmp, material.cert, { mode: 0o600 });
      writeFileSync(keyTmp, material.key, { mode: 0o600 });
      renameSync(keyTmp, keyPath);
      renameSync(certTmp, certPath);
    } finally {
      rmSync(certTmp, { force: true });
      rmSync(keyTmp, { force: true });
    }
  }

  private takeLock(): { taken: true; release: () => void } | { taken: false; reason: string } {
    const lockPath = join(this.tlsDir, LOCK_FILE);
    mkdirSync(this.tlsDir, { recursive: true, mode: 0o700 });
    const release = () => rmSync(lockPath, { force: true });
    const claim = (): boolean => {
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(this.now()).toISOString() }));
        closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    };
    if (claim()) return { taken: true, release };
    try {
      const age = this.now() - statSync(lockPath).mtimeMs;
      if (age > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        if (claim()) return { taken: true, release };
      }
    } catch {
      if (claim()) return { taken: true, release };
    }
    return {
      taken: false,
      reason: `Another renewal is in progress (${lockPath}); try again in a few minutes.`,
    };
  }

  private readRecord(): LifecycleRecord {
    const path = join(this.tlsDir, RECORD_FILE);
    if (!existsSync(path)) return { ...EMPTY_RECORD };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LifecycleRecord>;
      return {
        lastAttemptAt: typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt : null,
        lastError: typeof raw.lastError === "string" ? raw.lastError : null,
        lastRenewedAt: typeof raw.lastRenewedAt === "string" ? raw.lastRenewedAt : null,
        rotation:
          raw.rotation &&
          typeof raw.rotation.previousFingerprintSha256 === "string" &&
          typeof raw.rotation.rotatedAt === "string"
            ? {
                previousFingerprintSha256: raw.rotation.previousFingerprintSha256,
                rotatedAt: raw.rotation.rotatedAt,
              }
            : null,
      };
    } catch {
      return { ...EMPTY_RECORD };
    }
  }

  private writeRecord(): void {
    try {
      mkdirSync(this.tlsDir, { recursive: true, mode: 0o700 });
      const path = join(this.tlsDir, RECORD_FILE);
      const tmp = `${path}.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      log.warn(`TLS lifecycle record could not be written: ${errorText(err)}`);
    }
  }
}

/** Why a candidate must not be served, or null when it may. */
function replacementVerdict(inspection: TlsMaterialInspection): string | null {
  switch (inspection.state) {
    case "unreadable":
    case "key-mismatch":
      return inspection.error ?? inspection.state;
    case "expired":
      return `it expired on ${inspection.notAfter}`;
    case "not-yet-valid":
      return `it is not valid before ${inspection.notBefore}`;
    case "valid":
    case "expiring":
      break;
    default:
      return assertNever(inspection.state);
  }
  if (inspection.uncoveredHosts.length > 0) {
    return `it does not cover ${inspection.uncoveredHosts.join(", ")}`;
  }
  return null;
}
