// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

import {
  CodexAppServerRuntime,
  type CodexAppServerRuntimeOptions,
  type CodexRuntimeTurnOptions,
  type CodexTurnRunner,
} from "./codex-app-server-backend.js";
import type { AgentEvent, Logger } from "@omnesis/core";

/**
 * Omnesis tracks one active turn per Codex app-server runtime. Each member
 * serializes its turns; the pool routes work to the least-busy member so up to
 * N turns run concurrently. Members have isolated CODEX_HOME state directories
 * and reconcile auth.json against one login-owning home.
 *
 * The gateway owns separate pools for interactive work, inference, and nested
 * execution depths. Background agent turns use their serialized owner runtime;
 * a nested call always receives capacity independent of its waiting caller.
 */

/** A pool member's runtime — the real {@link CodexAppServerRuntime} in
 *  production, a fake in tests. Only these two methods are used. */
export type PoolMemberRuntime = CodexTurnRunner & { dispose(): Promise<void> };

interface PoolMember {
  readonly index: number;
  readonly home: string;
  readonly runtime: PoolMemberRuntime;
  inFlight: number;
}

export interface CodexRuntimePoolOptions {
  /** Per-member runtime options, minus `codexHome` (assigned per member). */
  readonly runtimeOptions: Omit<
    CodexAppServerRuntimeOptions,
    "codexHome" | "workspaceDir" | "logger"
  >;
  /** The login-owning home whose `auth.json` every member shares. */
  readonly sharedHome: string;
  /** Base directory under which each member's isolated CODEX_HOME lives. */
  readonly poolHomeBase: string;
  /** Base directory under which each member's cwd workspace lives. */
  readonly poolWorkspaceBase: string;
  readonly size: number;
  readonly logger: Logger;
  /** Test seam: construct a member's runtime. Defaults to a real
   *  {@link CodexAppServerRuntime} over the member's isolated home. */
  readonly createRuntime?: (
    memberHome: string,
    memberWorkspace: string,
    index: number,
  ) => PoolMemberRuntime;
}

/** Point `<memberHome>/auth.json` at the shared login, propagating a member's
 *  freshly-refreshed token to the shared file (newest-wins) if codex's atomic
 *  rename replaced the symlink with a real file. Best-effort: a failure here
 *  just means the member may need a re-login, never a crash. */
export function reconcileMemberAuth(memberHome: string, sharedAuthPath: string, log: Logger): void {
  const memberAuth = join(memberHome, "auth.json");
  try {
    if (!existsSync(sharedAuthPath)) {
      // Not logged in (or the owner's auth was removed). Clear any stale member
      // copy so a logged-out state is not masked by a leftover token.
      if (lstatSafe(memberAuth)) rmSync(memberAuth, { force: true });
      return;
    }
    const link = lstatSafe(memberAuth);
    if (link?.isSymbolicLink()) {
      if (safeReadlink(memberAuth) === sharedAuthPath) return; // already sharing
      rmSync(memberAuth, { force: true });
      symlinkSync(sharedAuthPath, memberAuth);
      return;
    }
    if (link?.isFile()) {
      const memberMtime = statSync(memberAuth).mtimeMs;
      const sharedMtime = statSync(sharedAuthPath).mtimeMs;
      if (memberMtime > sharedMtime) {
        // codex refreshed on this member and its rename broke the symlink.
        // Promote the newer token to the shared owner, then re-share.
        const tmp = `${sharedAuthPath}.pool-${memberMtime}.tmp`;
        copyFileSync(memberAuth, tmp);
        renameSync(tmp, sharedAuthPath);
      }
      rmSync(memberAuth, { force: true });
    }
    symlinkSync(sharedAuthPath, memberAuth);
  } catch (err) {
    log.warn(`auth reconcile for member home ${memberHome} failed: ${errText(err)}`);
  }
}

export class CodexRuntimePool implements CodexTurnRunner {
  private readonly members: PoolMember[] = [];
  private readonly sharedAuthPath: string;
  private readonly log: Logger;
  private disposed = false;

  constructor(private readonly opts: CodexRuntimePoolOptions) {
    this.log = opts.logger;
    this.sharedAuthPath = join(opts.sharedHome, "auth.json");
    if (!Number.isSafeInteger(opts.size) || opts.size < 1) {
      throw new Error("Codex pool size must be a positive integer");
    }
    const size = opts.size;
    const createRuntime =
      opts.createRuntime ??
      ((home, workspace, index): PoolMemberRuntime =>
        new CodexAppServerRuntime({
          ...opts.runtimeOptions,
          codexHome: home,
          workspaceDir: workspace,
          logger: this.log.child(`member-${index}`),
        }));
    for (let index = 0; index < size; index += 1) {
      const home = join(opts.poolHomeBase, String(index));
      this.members.push({
        index,
        home,
        inFlight: 0,
        runtime: createRuntime(home, join(opts.poolWorkspaceBase, String(index)), index),
      });
    }
  }

  get size(): number {
    return this.members.length;
  }

  /** Re-point every idle member at the (possibly rotated) shared auth. Called
   *  after a login succeeds or a logout clears the owner's token so the change
   *  propagates immediately; steady-state reconciliation happens per-lease. */
  reassertAuth(): void {
    for (const member of this.members) {
      if (member.inFlight === 0) this.prepareMember(member);
    }
  }

  async *runTurn(opts: CodexRuntimeTurnOptions): AsyncIterable<AgentEvent> {
    opts.signal?.throwIfAborted();
    if (this.disposed) throw new Error("Codex runtime pool disposed");
    const member = this.leaseLeastBusy();
    const wasIdle = member.inFlight === 0;
    member.inFlight += 1;
    try {
      // Reconcile only on the idle→busy edge: it materializes the member home
      // and re-shares the (possibly rotated) shared token before the turn, so
      // divergence heals within one turn — and never touches a member that is
      // mid-turn. A prepare failure surfaces as this turn's error and is
      // retried on the next lease (no memoized failure).
      if (wasIdle) this.prepareMember(member);
      yield* member.runtime.runTurn(opts);
    } finally {
      member.inFlight -= 1;
    }
  }

  /** Ensure a member's isolated home exists and its `auth.json` tracks the
   *  shared login (newest-wins). Cheap: a handful of sync fs calls, run only on
   *  the idle→busy edge. */
  private prepareMember(member: PoolMember): void {
    mkdirSync(member.home, { recursive: true });
    reconcileMemberAuth(member.home, this.sharedAuthPath, this.log);
  }

  /** Synchronous least-busy selection: no `await` between reading `inFlight`
   *  and incrementing it (done by the caller), so concurrent leases are
   *  serialized by the event loop and can't both pick the same idle member. */
  private leaseLeastBusy(): PoolMember {
    let chosen = this.members[0];
    for (const member of this.members) {
      if (member.inFlight < chosen.inFlight) chosen = member;
      if (chosen.inFlight === 0) break;
    }
    return chosen;
  }

  describe(): { size: number; inFlight: number[] } {
    return { size: this.members.length, inFlight: this.members.map((m) => m.inFlight) };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(this.members.map((m) => m.runtime.dispose().catch(() => {})));
  }
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
