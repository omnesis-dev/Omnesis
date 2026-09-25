// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { bodyLimit } from "hono/body-limit";

export const LINK_DECLARATION_BODY_LIMIT_BYTES = 256 * 1024;

/** Reject before JSON parsing, including streamed bodies without Content-Length. */
export const linkDeclarationBodyLimit = bodyLimit({
  maxSize: LINK_DECLARATION_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json(
      {
        error: `Request body too large (max ${LINK_DECLARATION_BODY_LIMIT_BYTES} bytes)`,
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    ),
});
