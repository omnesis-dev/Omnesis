// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Fixed guidance: an older process can outlive its controller without retaining a lease. */
export class DesktopProcessAuthorityFailure extends Error {
  readonly code = "DESKTOP_PROCESS_AUTHORITY_REQUIRED";
  constructor() {
    super(
      "This installation predates verified process ownership. Its data and keys were kept. Migrate a verified encrypted backup into a new managed installation before removing or replacing this library.",
    );
  }
}
