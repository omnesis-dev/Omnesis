// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::ffi::{c_char, c_int, c_void, CString};
use std::panic::catch_unwind;

use crate::{analyze, config::QUERY_TERMS_LOCALE, Config, Folding, Mode, SegmenterMode};

const SQLITE_OK: c_int = 0;
const SQLITE_ERROR: c_int = 1;
const SQLITE_MISUSE: c_int = 21;
const FTS5_TOKENIZE_QUERY: c_int = 1;
const FTS5_TOKENIZE_PREFIX: c_int = 2;

type TokenCallback =
    unsafe extern "C" fn(*mut c_void, c_int, *const c_char, c_int, c_int, c_int) -> c_int;

unsafe fn read_utf8<'a>(pointer: *const c_char, length: c_int) -> Result<&'a str, String> {
    if length < 0 || (length > 0 && pointer.is_null()) {
        return Err("Invalid text pointer or length".into());
    }
    if length == 0 {
        return Ok("");
    }
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(pointer.cast(), length as usize) })
        .map_err(|_| "Text must be valid UTF-8".into())
}

fn config(language: &str, mode: c_int, segmenter: c_int) -> Result<Config, String> {
    let mode = match mode {
        0 => Mode::Exact,
        1 => Mode::Stem,
        _ => return Err("Invalid analysis mode".into()),
    };
    let segmenter = match segmenter {
        0 => SegmenterMode::Dictionary,
        1 => SegmenterMode::Auto,
        _ => return Err("Invalid segmenter".into()),
    };
    Config::new(language, mode, segmenter)
}

/// The C shim passes valid output storage and readable buffers for their lengths.
#[no_mangle]
pub unsafe extern "C" fn omnesis_analyzer_new(
    language: *const c_char,
    length: c_int,
    mode: c_int,
    segmenter: c_int,
    folding: c_int,
    output: *mut *mut Config,
) -> c_int {
    if output.is_null() {
        return SQLITE_MISUSE;
    }
    unsafe {
        *output = std::ptr::null_mut();
    }
    catch_unwind(|| {
        let language = unsafe { read_utf8(language, length) }?;
        let folding = match folding {
            0 => Folding::None,
            1 => Folding::Broad,
            _ => return Err("Invalid folding policy".into()),
        };
        let value = config(language, mode, segmenter)?.with_folding(folding);
        unsafe {
            *output = Box::into_raw(Box::new(value));
        }
        Ok::<_, String>(())
    })
    .map_or(SQLITE_ERROR, |answer| {
        if answer.is_ok() {
            SQLITE_OK
        } else {
            SQLITE_ERROR
        }
    })
}

/// `handle` is either null or a live pointer returned by `omnesis_analyzer_new`.
#[no_mangle]
pub unsafe extern "C" fn omnesis_analyzer_delete(handle: *mut Config) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

unsafe fn emit(
    context: *mut c_void,
    callback: TokenCallback,
    term: &str,
    start: usize,
    end: usize,
) -> Result<c_int, String> {
    let length = c_int::try_from(term.len()).map_err(|_| "Token exceeds SQLite length range")?;
    let start = c_int::try_from(start).map_err(|_| "Offset exceeds SQLite length range")?;
    let end = c_int::try_from(end).map_err(|_| "Offset exceeds SQLite length range")?;
    Ok(unsafe { callback(context, 0, term.as_ptr().cast(), length, start, end) })
}

fn passthrough_terms(input: &str, flags: c_int) -> Result<Vec<(&str, usize, usize)>, String> {
    if flags & FTS5_TOKENIZE_QUERY == 0
        || flags & !(FTS5_TOKENIZE_QUERY | FTS5_TOKENIZE_PREFIX) != 0
    {
        return Err("Already-analyzed locale is reserved for MATCH queries".into());
    }
    if input.contains('\0') {
        return Err("Query terms cannot contain NUL".into());
    }
    let mut result = Vec::new();
    let mut cursor = 0;
    for term in input.split_ascii_whitespace() {
        let relative = input[cursor..]
            .find(term)
            .ok_or("Invalid query term offset")?;
        let start = cursor + relative;
        let end = start + term.len();
        result.push((term, start, end));
        cursor = end;
    }
    Ok(result)
}

/// Buffers, the analyzer handle, callback and context remain live for this call.
#[no_mangle]
pub unsafe extern "C" fn omnesis_analyzer_tokenize(
    handle: *const Config,
    context: *mut c_void,
    flags: c_int,
    text: *const c_char,
    length: c_int,
    locale: *const c_char,
    locale_length: c_int,
    callback: Option<TokenCallback>,
) -> c_int {
    if handle.is_null() || callback.is_none() {
        return SQLITE_MISUSE;
    }
    catch_unwind(|| {
        let input = unsafe { read_utf8(text, length) }?;
        let locale = unsafe { read_utf8(locale, locale_length) }?;
        let callback = callback.ok_or("Missing token callback")?;
        if locale == QUERY_TERMS_LOCALE {
            for (term, start, end) in passthrough_terms(input, flags)? {
                let status = unsafe { emit(context, callback, term, start, end) }?;
                if status != SQLITE_OK {
                    return Ok(status);
                }
            }
        } else {
            let config = unsafe { &*handle }.with_locale(Some(locale))?;
            let analysis = analyze(input, &config, flags & FTS5_TOKENIZE_PREFIX != 0)?;
            for token in analysis.tokens {
                let status =
                    unsafe { emit(context, callback, &token.text, token.start, token.end) }?;
                if status != SQLITE_OK {
                    return Ok(status);
                }
            }
        }
        Ok::<_, String>(SQLITE_OK)
    })
    .map_or(SQLITE_ERROR, |answer| answer.unwrap_or(SQLITE_ERROR))
}

/// Returns an allocated UTF-8 JSON/error string through valid `output` storage.
#[no_mangle]
pub unsafe extern "C" fn omnesis_analyzer_json(
    text: *const c_char,
    length: c_int,
    language: *const c_char,
    language_length: c_int,
    mode: c_int,
    segmenter: c_int,
    folding: c_int,
    fingerprint_only: c_int,
    output: *mut *mut c_char,
) -> c_int {
    if output.is_null() {
        return SQLITE_MISUSE;
    }
    unsafe {
        *output = std::ptr::null_mut();
    }
    let answer = catch_unwind(|| {
        let input = unsafe { read_utf8(text, length) }?;
        let language = unsafe { read_utf8(language, language_length) }?;
        let folding = match folding {
            0 => Folding::None,
            1 => Folding::Broad,
            _ => return Err("Invalid folding policy".into()),
        };
        let config = config(language, mode, segmenter)?.with_folding(folding);
        if fingerprint_only != 0 {
            Ok(config.fingerprint())
        } else {
            serde_json::to_string(&analyze(input, &config, false)?)
                .map_err(|error| error.to_string())
        }
    })
    .unwrap_or_else(|_| Err("Native analysis failed".into()));
    let status = if answer.is_ok() {
        SQLITE_OK
    } else {
        SQLITE_ERROR
    };
    let value = answer.unwrap_or_else(|error| error);
    match CString::new(value) {
        Ok(value) => {
            unsafe {
                *output = value.into_raw();
            }
            status
        }
        Err(_) => SQLITE_ERROR,
    }
}

/// `pointer` is null or a live string allocated by `omnesis_analyzer_json`.
#[no_mangle]
pub unsafe extern "C" fn omnesis_analyzer_string_delete(pointer: *mut c_void) {
    if !pointer.is_null() {
        drop(unsafe { CString::from_raw(pointer.cast()) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_terms_are_query_only_and_never_restemmed() {
        let result = passthrough_terms("generationally alpha beta", 1).unwrap();
        assert_eq!(result[0], ("generationally", 0, 14));
        assert_eq!(result[1], ("alpha", 15, 20));
        assert!(passthrough_terms("term", 4).is_err());
        assert!(passthrough_terms("term", 8).is_err());
        assert!(Config::new(QUERY_TERMS_LOCALE, Mode::Stem, SegmenterMode::Dictionary).is_err());
    }

    #[test]
    fn empty_buffers_and_invalid_utf8_are_handled_without_dereference() {
        assert_eq!(unsafe { read_utf8(std::ptr::null(), 0) }.unwrap(), "");
        assert!(unsafe { read_utf8(std::ptr::null(), 1) }.is_err());
        let invalid = [0xffu8];
        assert!(unsafe { read_utf8(invalid.as_ptr().cast(), 1) }.is_err());
    }

    unsafe extern "C" fn stop_after_first(
        context: *mut c_void,
        _flags: c_int,
        _text: *const c_char,
        _length: c_int,
        _start: c_int,
        _end: c_int,
    ) -> c_int {
        unsafe {
            *context.cast::<usize>() += 1;
        }
        7
    }

    #[test]
    fn callback_errors_stop_emission_and_reserved_document_locales_fail() {
        let analyzer = config("en", 1, 0).unwrap();
        let mut calls = 0usize;
        let source = "recipes running";
        let status = unsafe {
            omnesis_analyzer_tokenize(
                &analyzer,
                (&mut calls as *mut usize).cast(),
                4,
                source.as_ptr().cast(),
                source.len() as c_int,
                std::ptr::null(),
                0,
                Some(stop_after_first),
            )
        };
        assert_eq!(status, 7);
        assert_eq!(calls, 1);
        let status = unsafe {
            omnesis_analyzer_tokenize(
                &analyzer,
                (&mut calls as *mut usize).cast(),
                4,
                source.as_ptr().cast(),
                source.len() as c_int,
                QUERY_TERMS_LOCALE.as_ptr().cast(),
                QUERY_TERMS_LOCALE.len() as c_int,
                Some(stop_after_first),
            )
        };
        assert_eq!(status, SQLITE_ERROR);
        assert_eq!(calls, 1);
    }
}
