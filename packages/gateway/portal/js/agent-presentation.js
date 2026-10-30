// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Browser presentation entrypoint. Hosts supply state and source metadata;
// importing this module does not start a session or fetch gateway data.
export { MessageBubble, TimelinePanel } from "./components/agent/parts.js";
export { TimelineColumn } from "./components/timeline.js";
export { setSourceMeta } from "./lib/format.js";
export { AgentReplayContext } from "./shared/agent-ui/replay.js";
export { initialState, reducer } from "./shared/agent-ui/reducer.js";
export { h, render } from "preact";
