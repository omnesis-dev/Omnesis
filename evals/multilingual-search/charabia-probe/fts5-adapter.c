// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

typedef int (*CharabiaTokenCallback)(void *, int, const char *, int, int, int);
extern int charabia_tokenize(const char *, int, void *, CharabiaTokenCallback);

struct Fts5Tokenizer {
  int reserved;
};

static int create_tokenizer(void *context, const char **arguments, int count,
                            Fts5Tokenizer **output) {
  (void)context;
  (void)arguments;
  *output = 0;
  if (count != 0) return SQLITE_ERROR;
  Fts5Tokenizer *tokenizer = sqlite3_malloc64(sizeof(*tokenizer));
  if (!tokenizer) return SQLITE_NOMEM;
  tokenizer->reserved = 0;
  *output = tokenizer;
  return SQLITE_OK;
}

static void delete_tokenizer(Fts5Tokenizer *tokenizer) {
  sqlite3_free(tokenizer);
}

static int tokenize(Fts5Tokenizer *tokenizer, void *context, int flags,
                    const char *text, int length, CharabiaTokenCallback callback) {
  (void)tokenizer;
  (void)flags;
  return charabia_tokenize(text, length, context, callback);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **error,
                          const sqlite3_api_routines *routines) {
  SQLITE_EXTENSION_INIT2(routines);
  fts5_api *fts = 0;
  sqlite3_stmt *statement = 0;
  int status = sqlite3_prepare_v2(db, "SELECT fts5(?1)", -1, &statement, 0);
  if (status == SQLITE_OK) {
    status = sqlite3_bind_pointer(statement, 1, &fts, "fts5_api_ptr", 0);
    if (status == SQLITE_OK) {
      const int step_status = sqlite3_step(statement);
      status = step_status == SQLITE_ROW ? SQLITE_OK : step_status;
    }
  }
  const int finalize_status = sqlite3_finalize(statement);
  if (status == SQLITE_OK) status = finalize_status;
  if (status != SQLITE_OK || !fts) {
    *error = sqlite3_mprintf("Charabia requires an available FTS5 API");
    return status == SQLITE_OK ? SQLITE_ERROR : status;
  }
  fts5_tokenizer tokenizer = {create_tokenizer, delete_tokenizer, tokenize};
  return fts->xCreateTokenizer(fts, "charabia", 0, &tokenizer, 0);
}
