// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";

/** Global bounds include unauthenticated callers and slow request bodies. */
export class LoginAdmission {
  private active = 0;
  private window = -1;
  private attempts = 0;

  constructor(
    private readonly maxConcurrent = 8,
    private readonly maxPerMinute = 60,
  ) {
    for (const limit of [maxConcurrent, maxPerMinute]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error("Login limits must be positive integers");
    }
  }

  snapshot(): {
    activeLogins: number;
    loginAttempts: number;
    maxConcurrentLogins: number;
    maxLoginsPerMinute: number;
  } {
    return {
      activeLogins: this.active,
      loginAttempts: this.window === Math.floor(Date.now() / 60_000) ? this.attempts : 0,
      maxConcurrentLogins: this.maxConcurrent,
      maxLoginsPerMinute: this.maxPerMinute,
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const window = Math.floor(Date.now() / 60_000);
    if (window !== this.window) {
      this.window = window;
      this.attempts = 0;
    }
    if (this.active >= this.maxConcurrent || this.attempts >= this.maxPerMinute) {
      throw new RelayError(429, "Login capacity reached");
    }
    this.active++;
    this.attempts++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}
