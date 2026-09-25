// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPENCLAW_PLUGIN_DEFINITION } from "@omnesis/agent-integration/openclaw";
// OpenClaw supplies this optional peer module when it loads the plugin.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry(OPENCLAW_PLUGIN_DEFINITION);
