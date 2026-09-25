// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/** File-level progress alongside Vitest's normal result reporter. */
export default class CheckReporter {
  onTestRunStart(specifications) {
    this.startedAt = Date.now();
    this.completed = new Set();
    this.failed = new Set();
    this.status = {
      pid: process.pid,
      cwd: process.cwd(),
      phase: process.env.OMNESIS_CHECK_PHASE ?? null,
      state: "running",
      total: specifications.length,
      completed: 0,
      failed: 0,
      file: null,
      startedAt: this.startedAt,
    };
    this.publish();
  }

  onTestModuleEnd(module) {
    this.record(module);
    this.status.file = module.relativeModuleId;
    this.publish();
    // JSON quoting keeps filenames with control characters on one terminal line.
    process.stderr.write(
      `[tests] ${this.status.completed}/${this.status.total} files, ${this.status.failed} failed; ${JSON.stringify(module.relativeModuleId)} (${Math.round(this.status.elapsedMs / 1000)}s)\n`,
    );
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    // Reconcile the final module list in case collection failed before an end event.
    for (const module of modules) {
      if (["passed", "failed", "skipped"].includes(module.state())) this.record(module);
    }
    this.status.state =
      reason === "interrupted"
        ? "cancelled"
        : reason === "failed" || this.failed.size > 0 || unhandledErrors.length > 0
          ? "failed"
          : "passed";
    this.publish();
    process.stderr.write(
      `[tests] ${this.status.state}: ${this.status.completed}/${this.status.total} files, ${this.status.failed} failed (${Math.round(this.status.elapsedMs / 1000)}s)\n`,
    );
  }

  record(module) {
    this.completed.add(module);
    if (module.state() === "failed") this.failed.add(module);
    this.status.completed = this.completed.size;
    this.status.failed = this.failed.size;
  }

  publish() {
    this.status.updatedAt = Date.now();
    this.status.elapsedMs = this.status.updatedAt - this.startedAt;
    const destination = process.env.OMNESIS_CHECK_PROGRESS_FILE;
    if (!destination) return;
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.status)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, destination);
    } catch (error) {
      throw new Error(`Cannot write test progress to ${destination}: ${error.message}`, {
        cause: error,
      });
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT")
          process.stderr.write(`Cannot remove test progress temporary file: ${error.message}\n`);
      }
    }
  }
}
