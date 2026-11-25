#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {};

// Await transport bootstrap before evaluating any CLI module that captures URLs.
// Sibling static imports can evaluate while an asynchronous dependency is suspended.
if (process.argv[2] === "desktop") {
  // This module imports only Node builtins. The managed directory and key
  // namespace must be selected before configuration defaults or dotenv load.
  const { initializeDesktopEnvironment } = await import("./desktop/environment.js");
  initializeDesktopEnvironment();
}
await import("./load-env.js");
await import("./main.js");
