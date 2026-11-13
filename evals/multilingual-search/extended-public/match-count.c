// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// Research-only FTS5 auxiliary function: exact unique-phrase coverage for MSM.
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

static void matched_phrases(const Fts5ExtensionApi *api, Fts5Context *fts,
                            sqlite3_context *ctx, int argc, sqlite3_value **argv) {
    (void)argc;
    (void)argv;
    int matched = 0;
    for (int phrase = 0; phrase < api->xPhraseCount(fts); phrase++) {
        Fts5PhraseIter iter;
        int column = -1, offset = -1;
        int rc = api->xPhraseFirst(fts, phrase, &iter, &column, &offset);
        if (rc != SQLITE_OK) {
            sqlite3_result_error_code(ctx, rc);
            return;
        }
        if (column >= 0) matched++;
    }
    sqlite3_result_int(ctx, matched);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **error,
                           const sqlite3_api_routines *routines) {
    (void)error;
    SQLITE_EXTENSION_INIT2(routines);
    fts5_api *api = 0;
    sqlite3_stmt *stmt = 0;
    int rc = sqlite3_prepare_v2(db, "SELECT fts5(?1)", -1, &stmt, 0);
    if (rc != SQLITE_OK) return rc;
    rc = sqlite3_bind_pointer(stmt, 1, &api, "fts5_api_ptr", 0);
    if (rc == SQLITE_OK) {
        int step = sqlite3_step(stmt);
        if (step != SQLITE_ROW && step != SQLITE_DONE) rc = step;
    }
    int final = sqlite3_finalize(stmt);
    if (rc != SQLITE_OK) return rc;
    if (final != SQLITE_OK) return final;
    if (!api) return SQLITE_ERROR;
    return api->xCreateFunction(api, "matched_phrases", 0, matched_phrases, 0);
}
