// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Serialize complete badge snapshots so an older render cannot finish last. */
export class BadgeRefreshCoordinator {
  #work: Promise<void> = Promise.resolve();

  run(refresh: () => Promise<void>): Promise<void> {
    const result = this.#work.then(refresh, refresh);
    this.#work = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
