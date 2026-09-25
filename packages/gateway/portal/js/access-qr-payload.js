// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The payload the mobile apps scan to open one authorization request. The
// public consent page and the Portal's review page both draw it, so a request
// reaches the same review whichever page showed the code. The consent page
// loads this module outside the Portal bundle, so it imports nothing.

export function authorizationQrPayload(userCode) {
  return `omnesis://access-authorization?v=1&code=${encodeURIComponent(userCode.trim())}`;
}
