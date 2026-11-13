// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#include <sqlite3ext.h>
#include <stdint.h>
#include <string.h>
SQLITE_EXTENSION_INIT1

typedef int (*TokenCallback)(void *, int, const char *, int, int, int);
extern int omnesis_analyzer_new(const char *, int, int, int, int, void **);
extern void omnesis_analyzer_delete(void *);
extern int omnesis_analyzer_tokenize(const void *, void *, int, const char *, int,
                                    const char *, int, TokenCallback);
extern int omnesis_analyzer_json(const char *, int, const char *, int, int, int, int, int, char **);
extern void omnesis_analyzer_string_delete(void *);

struct Fts5Tokenizer { void *analyzer; };

static int parse_mode(const char *value, int length) {
  if (length == 5 && memcmp(value, "exact", 5) == 0) return 0;
  if (length == 4 && memcmp(value, "stem", 4) == 0) return 1;
  return -1;
}

static int create_tokenizer(void *context, const char **args, int count,
                            Fts5Tokenizer **output) {
  (void)context;
  *output = 0;
  const char *language = "und";
  int mode = 1;
  int segmenter = 0;
  int folding = 0;
  if (count % 2 != 0) return SQLITE_ERROR;
  for (int index = 0; index < count; index += 2) {
    if (strcmp(args[index], "language") == 0) language = args[index + 1];
    else if (strcmp(args[index], "mode") == 0) {
      mode = parse_mode(args[index + 1], (int)strlen(args[index + 1]));
      if (mode < 0) return SQLITE_ERROR;
    } else if (strcmp(args[index], "segmenter") == 0) {
      if (strcmp(args[index + 1], "dictionary") == 0) segmenter = 0;
      else if (strcmp(args[index + 1], "auto") == 0) segmenter = 1;
      else return SQLITE_ERROR;
    } else if (strcmp(args[index], "folding") == 0) {
      if (strcmp(args[index + 1], "none") == 0) folding = 0;
      else if (strcmp(args[index + 1], "broad") == 0) folding = 1;
      else return SQLITE_ERROR;
    } else return SQLITE_ERROR;
  }
  Fts5Tokenizer *tokenizer = sqlite3_malloc64(sizeof(*tokenizer));
  if (!tokenizer) return SQLITE_NOMEM;
  tokenizer->analyzer = 0;
  const int status = omnesis_analyzer_new(language, (int)strlen(language), mode,
                                         segmenter, folding, &tokenizer->analyzer);
  if (status != SQLITE_OK) { sqlite3_free(tokenizer); return status; }
  *output = tokenizer;
  return SQLITE_OK;
}

static void delete_tokenizer(Fts5Tokenizer *tokenizer) {
  omnesis_analyzer_delete(tokenizer->analyzer);
  sqlite3_free(tokenizer);
}

static int tokenize_v1(Fts5Tokenizer *tokenizer, void *context, int flags,
                        const char *text, int length, TokenCallback callback) {
  return omnesis_analyzer_tokenize(tokenizer->analyzer, context, flags, text,
                                  length, 0, 0, callback);
}

static int tokenize_v2(Fts5Tokenizer *tokenizer, void *context, int flags,
                        const char *text, int length, const char *locale,
                        int locale_length, TokenCallback callback) {
  return omnesis_analyzer_tokenize(tokenizer->analyzer, context, flags, text,
                                  length, locale, locale_length, callback);
}

static void analyze_json(sqlite3_context *context, int argc, sqlite3_value **values) {
  const int fingerprint_only = (int)(intptr_t)sqlite3_user_data(context);
  const int language_index = fingerprint_only ? 0 : 1;
  const int mode_index = fingerprint_only ? 1 : 2;
  for (int index = 0; index < argc; index++) {
    if (sqlite3_value_type(values[index]) != SQLITE_TEXT) {
      sqlite3_result_error(context, "Analysis arguments must be TEXT", -1);
      return;
    }
  }
  const char *mode_text = (const char *)sqlite3_value_text(values[mode_index]);
  if (!mode_text) { sqlite3_result_error_nomem(context); return; }
  const int mode = parse_mode(mode_text, sqlite3_value_bytes(values[mode_index]));
  if (mode < 0) { sqlite3_result_error(context, "Mode must be exact or stem", -1); return; }
  int segmenter = 0;
  if (argc > mode_index + 1) {
    const int segmenter_index = mode_index + 1;
    const char *value = (const char *)sqlite3_value_text(values[segmenter_index]);
    const int length = sqlite3_value_bytes(values[segmenter_index]);
    if (!value) { sqlite3_result_error_nomem(context); return; }
    if (length == 10 && memcmp(value, "dictionary", 10) == 0) segmenter = 0;
    else if (length == 4 && memcmp(value, "auto", 4) == 0) segmenter = 1;
    else { sqlite3_result_error(context, "Segmenter must be dictionary or auto", -1); return; }
  }
  int folding = 0;
  if (argc > mode_index + 2) {
    const int folding_index = mode_index + 2;
    const char *value = (const char *)sqlite3_value_text(values[folding_index]);
    const int length = sqlite3_value_bytes(values[folding_index]);
    if (!value) { sqlite3_result_error_nomem(context); return; }
    if (length == 4 && memcmp(value, "none", 4) == 0) folding = 0;
    else if (length == 5 && memcmp(value, "broad", 5) == 0) folding = 1;
    else { sqlite3_result_error(context, "Folding must be none or broad", -1); return; }
  }
  const char *text = fingerprint_only ? "" : (const char *)sqlite3_value_text(values[0]);
  const char *language = (const char *)sqlite3_value_text(values[language_index]);
  if (!text || !language) { sqlite3_result_error_nomem(context); return; }
  char *result = 0;
  const int status = omnesis_analyzer_json(text, fingerprint_only ? 0 : sqlite3_value_bytes(values[0]),
      language, sqlite3_value_bytes(values[language_index]), mode, segmenter, folding, fingerprint_only, &result);
  if (status == SQLITE_OK && result) {
    sqlite3_result_text(context, result, -1, omnesis_analyzer_string_delete);
  } else {
    sqlite3_result_error(context, result ? result : "Native analysis failed", -1);
    omnesis_analyzer_string_delete(result);
  }
}

static void capabilities(sqlite3_context *context, int argc, sqlite3_value **values) {
  (void)argc;
  (void)values;
  const int locale_api = (int)(intptr_t)sqlite3_user_data(context);
  sqlite3_result_text(context, locale_api ?
      "{\"tokenizer\":\"omnesis_multilingual_v1\",\"locale_api\":true,\"query_terms_locale\":\"und-x-omnesis-terms-v1\",\"minimum_locale_sqlite\":\"3.47.0\"}" :
      "{\"tokenizer\":\"omnesis_multilingual_v1\",\"locale_api\":false,\"query_terms_locale\":null,\"minimum_locale_sqlite\":\"3.47.0\"}",
      -1, SQLITE_STATIC);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **error, const sqlite3_api_routines *routines) {
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
    *error = sqlite3_mprintf("Multilingual analysis requires an available FTS5 API");
    return status == SQLITE_OK ? SQLITE_ERROR : status;
  }
  if (fts->iVersion >= 3) {
    fts5_tokenizer_v2 tokenizer = {2, create_tokenizer, delete_tokenizer, tokenize_v2};
    status = fts->xCreateTokenizer_v2(fts, "omnesis_multilingual_v1", 0, &tokenizer, 0);
  } else {
    fts5_tokenizer tokenizer = {create_tokenizer, delete_tokenizer, tokenize_v1};
    status = fts->xCreateTokenizer(fts, "omnesis_multilingual_v1", 0, &tokenizer, 0);
  }
  const int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS;
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_analyze", 3, flags, 0, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_analyze", 4, flags, 0, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_analyze", 5, flags, 0, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_fingerprint", 2, flags, (void *)(intptr_t)1, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_fingerprint", 3, flags, (void *)(intptr_t)1, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_fingerprint", 4, flags, (void *)(intptr_t)1, analyze_json, 0, 0, 0);
  if (status == SQLITE_OK) status = sqlite3_create_function_v2(db,
      "omnesis_multilingual_capabilities", 0, flags,
      (void *)(intptr_t)(fts->iVersion >= 3), capabilities, 0, 0, 0);
  return status;
}
