#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {};

// Await transport bootstrap before evaluating any CLI module that captures URLs.
// Sibling static imports can evaluate while an asynchronous dependency is suspended.
// Match main's command selection before any headless configuration is read.
const command = process.argv.slice(2).find((argument) => argument !== "--");
if (command === "desktop") {
  // This module imports only Node builtins. The managed directory and key
  // namespace must be selected before configuration defaults or dotenv load.
  const { initializeDesktopEnvironment } = await import("./desktop/environment.js");
  initializeDesktopEnvironment();
}
await import("./load-env.js");
await import("./main.js");
