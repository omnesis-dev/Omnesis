// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

use std::ffi::{c_char, c_int, c_void};
use std::panic::catch_unwind;

use charabia::Tokenize;

type TokenCallback = unsafe extern "C" fn(
    context: *mut c_void,
    flags: c_int,
    token: *const c_char,
    length: c_int,
    start: c_int,
    end: c_int,
) -> c_int;

/// Emits normalized tokens with original UTF-8 byte offsets for an FTS5 callback.
///
/// # Safety
///
/// For positive `length`, `text` must address at least that many readable bytes.
/// `callback` and `context` must remain valid throughout this synchronous call.
#[no_mangle]
pub unsafe extern "C" fn charabia_tokenize(
    text: *const c_char,
    length: c_int,
    context: *mut c_void,
    callback: Option<TokenCallback>,
) -> c_int {
    const SQLITE_OK: c_int = 0;
    const SQLITE_ERROR: c_int = 1;
    const SQLITE_MISUSE: c_int = 21;

    if length < 0 || (length > 0 && text.is_null()) || callback.is_none() {
        return SQLITE_MISUSE;
    }
    if length == 0 {
        return SQLITE_OK;
    }
    let callback = callback.expect("callback checked above");
    catch_unwind(|| {
        let bytes = unsafe { std::slice::from_raw_parts(text.cast::<u8>(), length as usize) };
        let Ok(input) = std::str::from_utf8(bytes) else {
            return SQLITE_ERROR;
        };
        for token in input.tokenize().filter(|token| token.is_word()) {
            let Ok(token_length) = c_int::try_from(token.lemma().len()) else {
                return SQLITE_ERROR;
            };
            let Ok(start) = c_int::try_from(token.byte_start) else {
                return SQLITE_ERROR;
            };
            let Ok(end) = c_int::try_from(token.byte_end) else {
                return SQLITE_ERROR;
            };
            let status = unsafe {
                callback(
                    context,
                    0,
                    token.lemma().as_ptr().cast(),
                    token_length,
                    start,
                    end,
                )
            };
            if status != SQLITE_OK {
                return status;
            }
        }
        SQLITE_OK
    })
    .unwrap_or(SQLITE_ERROR)
}
