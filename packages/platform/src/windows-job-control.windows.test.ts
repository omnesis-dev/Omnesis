// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsJobInvocation } from "./windows-job.js";

function configuration(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

describe.runIf(process.platform === "win32")("native Windows job control provenance", () => {
  it.each(["cancel-before-create", "owner-birth-mismatch", "early-disconnect"] as const)(
    "refuses target execution for %s with a bounded, owned helper",
    async (scenario) => {
      const worker = windowsJobInvocation();
      const dir = mkdtempSync(join(tmpdir(), "omnesis-job-control-native-"));
      const marker = join(dir, "unexpected-target");
      const pipe = `omnesis-job-${process.pid}-${randomBytes(24).toString("hex")}`;
      const cookie = randomBytes(32).toString("hex");
      const sockets = new Set<Socket>();
      const socketJoins: Promise<void>[] = [];
      let authenticated = false;
      let joined = false;
      let protocolError: unknown;
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socketJoins.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
        socket.on("error", () => {});
        socket.on("end", () => socket.end());
        socket.once("close", () => sockets.delete(socket));
        let frame = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          if (authenticated) {
            if (chunk.length === 1 && chunk[0] === 2) joined = true;
            else protocolError = new Error("Unexpected native control completion");
            return;
          }
          frame = Buffer.concat([frame, chunk]);
          if (frame.length > 512) {
            protocolError = new Error("Oversized native control frame");
            socket.destroy();
            return;
          }
          if (frame.indexOf(10) < 0) return;
          try {
            const hello = JSON.parse(frame.toString("utf8"));
            if (
              !hello ||
              typeof hello !== "object" ||
              Array.isArray(hello) ||
              Object.keys(hello).sort().join(",") !== "cookie,pid" ||
              hello.cookie !== cookie ||
              hello.pid !== child.pid
            )
              throw new Error("Native control authentication failed");
            authenticated = true;
            if (scenario === "cancel-before-create") socket.write(Buffer.from([0, 1]));
            // Disconnect before ACK: an authenticated peer alone cannot permit a target.
            else if (scenario === "early-disconnect") socket.end();
            else socket.destroy();
          } catch (error) {
            protocolError = error;
            socket.destroy();
          }
        });
      });
      server.listen(`\\\\.\\pipe\\${pipe}`);
      await once(server, "listening");
      const child = spawn(worker.command, worker.args, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      child.stdin.on("error", () => {});
      let spawnError: unknown;
      child.on("error", (error) => {
        spawnError = error;
      });
      // Keep native diagnostics private to the assertion and never log the
      // authentication material, command line, or endpoint.
      let diagnostic = "";
      child.stderr.on("data", (bytes: Buffer) => {
        diagnostic += bytes.toString("utf8").slice(0, 4000 - diagnostic.length);
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.stdin.end(
        configuration({
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`],
          parentPid: process.pid,
          completion: "tree",
          control: {
            pipe,
            cookie,
            parentBirth:
              scenario === "owner-birth-mismatch"
                ? (BigInt(worker.parentBirth!) + 1n).toString()
                : worker.parentBirth,
            deadlineUnixMs: Date.now() + 30_000,
          },
        }),
      );
      try {
        const code = await closed;
        let joinTimer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            Promise.all(socketJoins),
            new Promise<never>((_, reject) => {
              joinTimer = setTimeout(
                () => reject(new Error("Native control socket did not close")),
                1_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(joinTimer);
        }
        expect(spawnError).toBeUndefined();
        expect(protocolError).toBeUndefined();
        expect(code, diagnostic).not.toBe(0);
        expect(existsSync(marker)).toBe(false);
        expect(authenticated).toBe(scenario !== "owner-birth-mismatch");
        expect(joined).toBe(scenario === "cancel-before-create");
      } finally {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        await closed;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
