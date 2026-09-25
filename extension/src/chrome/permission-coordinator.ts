// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface PermissionCoordinatorDeps {
  hasPermission: () => Promise<boolean>;
  saveState: (granted: boolean) => Promise<void>;
  syncContentScript: (granted: boolean) => Promise<void>;
  clearUnauthorizedHandoffs: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

/** Orders Chrome permission events and mirrors their authoritative state. */
export class CapturePermissionCoordinator {
  #work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PermissionCoordinatorDeps) {}

  reconcile(refreshStatus = false): Promise<boolean> {
    return this.#applyObserved(this.deps.hasPermission(), refreshStatus);
  }

  handleAdded(permissions: chrome.permissions.Permissions): Promise<void> {
    if ((permissions.origins?.length ?? 0) === 0) return Promise.resolve();
    return this.#applyObserved(this.deps.hasPermission(), true).then(() => undefined);
  }

  handleRemoved(permissions: chrome.permissions.Permissions): Promise<void> {
    if ((permissions.origins?.length ?? 0) === 0) return Promise.resolve();
    return this.#applyObserved(this.deps.hasPermission(), true).then(() => undefined);
  }

  #applyObserved(observed: Promise<boolean>, refreshStatus: boolean): Promise<boolean> {
    return this.#serialize(async () => {
      const granted = await observed;
      if (granted) {
        await this.deps.syncContentScript(true);
        await this.deps.saveState(true);
      } else {
        const failures: unknown[] = [];
        try {
          await this.deps.saveState(false);
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.deps.syncContentScript(false);
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.deps.clearUnauthorizedHandoffs();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Could not fully deactivate browser capture");
        }
      }
      if (refreshStatus) await this.deps.refreshStatus();
      return granted;
    });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#work.then(work, work);
    this.#work = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
