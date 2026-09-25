// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  algo_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  docs_processed INTEGER NOT NULL DEFAULT 0,
  pairs_recorded INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS document_minhash (
  document_id TEXT NOT NULL,
  algo_version TEXT NOT NULL,
  signature BLOB NOT NULL,
  shingle_count INTEGER NOT NULL,
  content_hash TEXT,
  doc_type TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  source_created_at INTEGER,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, algo_version)
);

CREATE INDEX IF NOT EXISTS idx_doc_minhash_algo ON document_minhash(algo_version);
CREATE INDEX IF NOT EXISTS idx_doc_minhash_plugin ON document_minhash(plugin_id, algo_version);
CREATE INDEX IF NOT EXISTS idx_doc_minhash_type ON document_minhash(doc_type, algo_version);

CREATE TABLE IF NOT EXISTS lsh_buckets (
  algo_version TEXT NOT NULL,
  band_idx INTEGER NOT NULL,
  bucket_hash INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  PRIMARY KEY (algo_version, band_idx, bucket_hash, document_id)
);

CREATE INDEX IF NOT EXISTS idx_lsh_lookup ON lsh_buckets(algo_version, band_idx, bucket_hash);

CREATE TABLE IF NOT EXISTS pairs (
  doc_a TEXT NOT NULL,
  doc_b TEXT NOT NULL,
  algo_version TEXT NOT NULL,
  jaccard REAL NOT NULL,
  sig_similarity REAL NOT NULL,
  run_id TEXT NOT NULL,
  intersection_size INTEGER,
  pair_unique_df2 INTEGER,
  pair_unique_df5 INTEGER,
  is_exact_dupe INTEGER,
  is_same_thread INTEGER,
  gate_status TEXT,
  gate_family TEXT,
  annotated_at INTEGER,
  PRIMARY KEY (doc_a, doc_b, algo_version)
);

CREATE INDEX IF NOT EXISTS idx_pairs_a ON pairs(doc_a, algo_version);
CREATE INDEX IF NOT EXISTS idx_pairs_b ON pairs(doc_b, algo_version);
CREATE INDEX IF NOT EXISTS idx_pairs_jaccard ON pairs(algo_version, jaccard);
`;
