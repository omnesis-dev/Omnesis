// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Widen dynamic OAuth clients to support confidential clients such as Claude. */
export function migrateV154ConfidentialOAuthClients(db: Db): void {
  const columns = new Set(
    db
      .prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?)")
      .all("oauth_clients")
      .map((row) => row.name),
  );
  if (columns.size === 0 || columns.has("client_secret_hash")) return;

  db.exec(`
    CREATE TABLE oauth_clients_next (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      grant_types TEXT NOT NULL,
      response_types TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL
        CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic')),
      client_secret_hash TEXT,
      client_uri TEXT,
      created_at INTEGER NOT NULL,
      CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
      CHECK (json_valid(grant_types) AND json_type(grant_types) = 'array'),
      CHECK (json_valid(response_types) AND json_type(response_types) = 'array'),
      CHECK (
        (token_endpoint_auth_method = 'none' AND client_secret_hash IS NULL) OR
        (token_endpoint_auth_method = 'client_secret_basic' AND client_secret_hash IS NOT NULL)
      )
    );
    INSERT INTO oauth_clients_next (
      client_id, client_name, redirect_uris, grant_types, response_types,
      token_endpoint_auth_method, client_secret_hash, client_uri, created_at
    )
    SELECT client_id, client_name, redirect_uris, grant_types, response_types,
           token_endpoint_auth_method, NULL, client_uri, created_at
    FROM oauth_clients;
    DROP TABLE oauth_clients;
    ALTER TABLE oauth_clients_next RENAME TO oauth_clients;
    CREATE INDEX idx_oauth_clients_created
      ON oauth_clients(created_at, client_id);
  `);
}
