// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { z } from "zod";
import { createTestPki, type TestPki } from "./fixture-pki.js";
import { PortableTailnetActor } from "./portable-tailnet-actor.js";
import { tailnetMachineEnv } from "./tailnet-machine-env.js";
import { stopTailnetCommands, tailnetCleanupError } from "./tailnet-command-processes.js";
import type { TailnetMachine, TailnetTools } from "./tailnet-harness.js";

const peerSchema = z
  .object({
    name: z.string().min(1),
    address: z.string().min(1),
    dir: z.string().min(1),
    socket: z.string().min(1),
    proxyUrl: z.string().url(),
    binDir: z.string().min(1),
  })
  .strict();
const approvalSchema = z.object({ ownerLogin: z.string().min(1) }).strict();

function fixtureErrors(errors: unknown[]): AggregateError {
  const receipt = errors.map(ownedProcessCleanupReceipt).find((value) => value !== undefined);
  const error = new AggregateError(errors, "Portable tailnet fixture failed");
  return receipt ? Object.assign(error, { cleanupFailure: receipt.failure }) : error;
}

/** A real local control plane and peers, contained in one owned Go test actor. */
export class PortableTestTailnet {
  readonly dir = mkdtempSync(join(tmpdir(), "omnesis-portable tailnet-"));
  readonly machines: TailnetMachine[] = [];
  controlUrl = "";
  ownerLogin = "";
  pki!: TestPki;
  private actor?: PortableTailnetActor;

  private constructor(readonly tools: TailnetTools) {}

  static async start(tools: TailnetTools): Promise<PortableTestTailnet> {
    if (!tools.portable) throw new Error("Portable tailnet tools are missing");
    const fixture = new PortableTestTailnet(tools);
    try {
      fixture.pki = await createTestPki(join(fixture.dir, "pki"), "tailnet");
      fixture.actor = new PortableTailnetActor(
        tools.portable.actor,
        fixture.dir,
        tools.portable.cliDirectory,
        join(import.meta.dirname, "../../../.."),
      );
      fixture.controlUrl = await fixture.actor.ready;
      return fixture;
    } catch (error) {
      try {
        await fixture.stop({ retainInputs: ownedProcessCleanupReceipt(error) !== undefined });
      } catch (cleanup) {
        throw fixtureErrors([error, cleanup]);
      }
      throw error;
    }
  }

  async approveSignIn(url: string, user: string): Promise<void> {
    if (!this.actor) throw new Error("Portable tailnet actor has not started");
    this.ownerLogin = approvalSchema.parse(
      await this.actor.request("approve", { url, user }),
    ).ownerLogin;
  }

  async machine(
    name: string,
    owner: { user: string } | { tags: string[] },
  ): Promise<TailnetMachine> {
    if (!this.actor) throw new Error("Portable tailnet actor has not started");
    const peer = peerSchema.parse(await this.actor.request("machine", { name, ...owner }));
    const expectedDirectory = join(this.dir, "machines", name);
    const endpoint = new URL(peer.proxyUrl);
    if (
      peer.name !== name ||
      !isIP(peer.address) ||
      peer.dir !== expectedDirectory ||
      peer.binDir !== join(expectedDirectory, "bin") ||
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Portable peer escaped its fixture boundary");
    const machine: TailnetMachine = {
      name,
      dir: peer.dir,
      socket: peer.socket,
      proxyUrl: peer.proxyUrl,
      binDir: peer.binDir,
      env: (caCertFile) => tailnetMachineEnv(peer.binDir, peer.proxyUrl, caCertFile),
    };
    this.machines.push(machine);
    return machine;
  }

  logs(): string {
    return this.actor?.logs() ?? "";
  }

  async stop(options: { retainInputs?: boolean } = {}): Promise<void> {
    const results = await Promise.allSettled([
      stopTailnetCommands(this.machines),
      this.actor?.stop(),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw tailnetCleanupError(failures.map((failure) => failure.reason as unknown));
    if (!options.retainInputs) rmSync(this.dir, { recursive: true, force: true });
  }
}
