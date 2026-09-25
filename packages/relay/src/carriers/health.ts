// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CarrierHealth, Clock } from "../types.js";

export class CarrierHealthTracker {
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;

  constructor(private readonly clock: Clock) {}

  success(): void {
    this.lastSuccessAt = this.clock.now();
  }

  failure(): void {
    this.lastFailureAt = this.clock.now();
  }

  snapshot(): CarrierHealth {
    const status =
      this.lastSuccessAt === null && this.lastFailureAt === null
        ? "unknown"
        : this.lastFailureAt !== null &&
            (this.lastSuccessAt === null || this.lastFailureAt > this.lastSuccessAt)
          ? "unreachable"
          : "reachable";
    return {
      configured: true,
      status,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }
}
