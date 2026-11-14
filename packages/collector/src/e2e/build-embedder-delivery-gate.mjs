// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire, syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const threads = require("node:worker_threads");
if (threads.isMainThread && process.env.OMNESIS_E2E_BUILD_DELIVERY_GATE) {
  const config = JSON.parse(process.env.OMNESIS_E2E_BUILD_DELIVERY_GATE);
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(config.nonce)
  )
    throw new Error("Invalid embedding fixture controller");
  const OriginalWorker = threads.Worker;
  threads.Worker = class DeliveryGatedWorker extends OriginalWorker {
    constructor(filename, options) {
      super(filename, options);
      const name = basename(filename instanceof URL ? fileURLToPath(filename) : String(filename));
      this.deliveryGateTarget = /^build-embedder-worker\.(?:ts|js)$/.test(name);
      this.deliveryGateReleased = false;
      this.deliveryGatePending = [];
      this.once("exit", () => {
        this.deliveryGatePending = [];
        this.deliveryGateSocket?.destroy();
      });
    }
    emit(event, ...args) {
      if (
        this.deliveryGateTarget &&
        !this.deliveryGateReleased &&
        event === "message" &&
        args[0]?.type === "embedResult"
      ) {
        // Retain original messages and transfer results in this process only.
        this.deliveryGatePending.push(args);
        if (!this.deliveryGateSocket) {
          const socket = (this.deliveryGateSocket = connect({
            host: "127.0.0.1",
            port: config.port,
          }));
          let input = "";
          socket.once("connect", () => socket.write(`held:${config.nonce}\n`));
          socket.on("data", (bytes) => {
            if (bytes.length > 256 - input.length) {
              socket.destroy();
              return;
            }
            input += bytes.toString("ascii");
            if (!input.endsWith("\n")) return;
            if (input === `release:${config.nonce}\n`) this.releaseDeliveryGate();
            else socket.destroy();
          });
          // Disconnect releases fixture-only holds so teardown cannot strand
          // native worker requests. The runner rejects an unexpected disconnect
          // before explicit release, so this cannot create a passing assertion.
          socket.on("error", () => this.releaseDeliveryGate());
          socket.on("close", () => this.releaseDeliveryGate());
        }
        return true;
      }
      return super.emit(event, ...args);
    }
    releaseDeliveryGate() {
      if (this.deliveryGateReleased) return;
      this.deliveryGateReleased = true;
      const pending = this.deliveryGatePending;
      this.deliveryGatePending = [];
      for (const args of pending) super.emit("message", ...args);
    }
  };
  syncBuiltinESMExports();
}
