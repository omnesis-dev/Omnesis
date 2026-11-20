// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readStorageTrimPage } from "./trim-job-store.js";
import { storageAccountingMetadata, storageAccountingPage } from "./accounting.js";
import { storageIndexAccountingMetadata, storageIndexAccountingPage } from "./index-accounting.js";
import type { ReadPort } from "../scheduler/read-port.js";

/** Corpus aggregates and candidate reads run on the gateway's existing read workers. */
export const STORAGE_READS = {
  storageTrimPage: readStorageTrimPage,
  storageAccountingMetadata,
  storageAccountingPage,
};
export const STORAGE_INDEX_READS = { storageIndexAccountingMetadata, storageIndexAccountingPage };
export type StorageReads = ReadPort<typeof STORAGE_READS> & ReadPort<typeof STORAGE_INDEX_READS>;
