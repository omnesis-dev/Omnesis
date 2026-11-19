// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface StorageMeasurementStatus {
  state: "pending" | "refreshing" | "ready" | "failed";
  measuredAt: string | null;
  error: string | null;
}

export interface StorageAccountingStatus {
  refreshing: boolean;
  measuredAt: string | null;
  error: string | null;
  logical: StorageMeasurementStatus;
  index: StorageMeasurementStatus;
  allocations?: StorageMeasurementStatus & {
    progress?: {
      store: "documents" | "index";
      scannedPages: number;
      completedTables: number;
      scannedBytes?: number;
    };
  };
}
