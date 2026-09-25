// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The plugin definition already has the runtime shape consumed by OpenClaw.
// Export it directly so OpenClaw's compatibility loader does not re-enter the
// host's ESM plugin-entry helper while the host is still loading that helper.
import { OPENCLAW_PLUGIN_DEFINITION } from "./dist/openclaw.js";

export default OPENCLAW_PLUGIN_DEFINITION;
