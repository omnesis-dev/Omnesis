#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Await transport bootstrap before evaluating any CLI module that captures URLs.
// Sibling static imports can evaluate while an asynchronous dependency is suspended.
import "./load-env.js";
await import("./main.js");
