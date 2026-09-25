// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Build the minimum OpenClaw host shape needed by integration probes.
 *
 * These are shape-only inert stubs: they capture plugin registrations but do
 * not emulate OpenClaw scheduling, sessions, subagents, channels, or logging.
 * Tests using this fixture exercise the registered Omnesis service and tool;
 * they must not infer OpenClaw runtime behavior from the remaining methods.
 *
 * @param {{ runId: string }} options
 */
export function createFakeOpenClawHost(options) {
  const services = [];
  const tools = [];
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const api = {
    registrationMode: "full",
    pluginConfig: {},
    logger,
    registerHook() {},
    registerService(service) {
      services.push(service);
    },
    registerTool(factory, toolOptions) {
      tools.push({ factory, options: toolOptions });
    },
    runtime: {
      agent: { session: { listSessionEntries: () => [] } },
      subagent: {
        run: async () => ({ runId: options.runId }),
        waitForRun: async () => ({ status: "ok" }),
        getSessionMessages: async () => ({ messages: [] }),
      },
      channel: { outbound: { loadAdapter: async () => undefined } },
    },
  };
  return { api, services, tools, logger };
}
