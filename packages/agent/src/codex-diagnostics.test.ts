// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { CodexAppServerRuntime } from "./codex-app-server-backend.js";
import type { AgentEvent } from "@omnesis/core";

/** Actual pinned vendor process; the fixture refuses every attempted provider request. */
test("managed runtime refuses unisolated model metadata before emitting or persisting a prompt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-codex-persistence-fixture-")));
  const profileMarker = join(root, "forbidden-shell-profile");
  const gitMarker = join(root, "unexpected-git-child");
  const bin = join(root, "fixture-bin");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(gitMarker)}, 'invoked');process.exit(1);\n`,
    { mode: 0o700 },
  );
  // Positive control: the owned probe is executable before absence means anything.
  await expect(
    promisify(execFile)(join(bin, "git"), [], { timeout: 5000, env: { PATH: process.env.PATH } }),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readFile(gitMarker, "utf8")).toBe("invoked");
  await rm(gitMarker);
  const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const profile of [".bashrc", ".bash_profile", ".profile", ".zshenv", ".zprofile", ".zshrc"])
    await writeFile(join(root, profile), `printf forbidden > ${quoted(profileMarker)}\n`, {
      mode: 0o600,
    });
  const sentinel = {
    prompt: "OMNESIS_FICTIONAL_PROMPT_SENTINEL_7b9e",
    system: "OMNESIS_FICTIONAL_SYSTEM_SENTINEL_7b9e",
  };
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(503, { "Content-Type": "application/json", Connection: "close" });
    response.end(
      JSON.stringify({ error: { message: "The isolated fixture does not perform inference" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The scripted fixture did not bind loopback");
  const url = `http://127.0.0.1:${address.port}`;
  const require = createRequire(import.meta.url);
  const codex = join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
  // The actual binary also sends any unexpected outbound request only to this rejecting fixture.
  const wrapper = join(root, "fixture-entry.mjs");
  await writeFile(
    wrapper,
    `process.env.HTTP_PROXY=process.env.OMNESIS_FAKE_CODEX_PROXY;process.env.HTTPS_PROXY=process.env.OMNESIS_FAKE_CODEX_PROXY;process.env.ALL_PROXY=process.env.OMNESIS_FAKE_CODEX_PROXY;process.env.NO_PROXY='127.0.0.1';await import(${JSON.stringify(codex)});`,
    { mode: 0o600 },
  );
  const temporary = join(root, "temporary");
  await mkdir(temporary, { mode: 0o700 });
  const runtime = new CodexAppServerRuntime({
    codexHome: join(root, "owned-home"),
    workspaceDir: join(root, "workspace"),
    stateHome: join(root, "worker-state"),
    command: process.execPath,
    versionArgs: [wrapper, "--version"],
    requestTimeoutMs: 10_000,
    args: [
      wrapper,
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'model_provider="fictional"',
      "-c",
      'model_providers.fictional.name="Fictional scripted provider"',
      "-c",
      `model_providers.fictional.base_url=${JSON.stringify(url)}`,
      "-c",
      'model_providers.fictional.wire_api="responses"',
      "-c",
      "model_providers.fictional.requires_openai_auth=false",
      "-c",
      "model_providers.fictional.supports_websockets=false",
    ],
    env: {
      HOME: root,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      OMNESIS_DESKTOP_MANAGED: "1",
      OMNESIS_FAKE_CODEX_PROXY: url,
    },
  });
  const invoke = vi.fn(async (_arguments: unknown) => ({
    kind: "structured" as const,
    resultType: "fixture",
    data: { fictional: "An invented result" },
  }));
  try {
    try {
      await runtime.verifyManagedCredentialPolicy();
      const events: AgentEvent[] = [];
      for await (const event of runtime.runTurn({
        model: "gpt-5.4",
        toolTimeoutMs: 1000,
        maxToolIterations: 3,
        signal: AbortSignal.timeout(20_000),
        input: {
          sessionId: "fixture-session",
          messageId: "fixture-message",
          history: [],
          userMessage: sentinel.prompt,
          systemPrompt: `Use only the fictional probe tool. ${sentinel.system}`,
          tools: [
            {
              name: "fictional_probe",
              description: "An invented read-only fixture",
              schema: z.object({ value: z.string() }),
              invoke,
            },
          ],
        },
      }))
        events.push(event);
      expect(
        events.find((event) => event.type === "agent.message.end")?.payload.stopReason,
        JSON.stringify(events),
      ).toBe("error");
      expect(events.some((event) => event.type === "agent.error")).toBe(true);
      expect(events.some((event) => event.type === "agent.text.delta")).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      expect(requests).toBe(0);
      await expect(readFile(profileMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(gitMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(join(root, "owned-home", "shell_snapshots"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await runtime.dispose();
    }
    const stateFiles = await readdir(join(root, "worker-state", "sqlite"));
    const logFiles = await readdir(join(root, "worker-state", "log"));
    expect(
      logFiles.some((name) => /^logs_\d+\.sqlite$/.test(name)),
      JSON.stringify(logFiles),
    ).toBe(true);
    expect(
      stateFiles.some((name) => /^state_\d+\.sqlite$/.test(name)),
      JSON.stringify(stateFiles),
    ).toBe(true);
    let files = 0;
    async function inspect(directory: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else if (entry.isFile()) {
          files++;
          const bytes = await readFile(path);
          for (const token of Object.values(sentinel))
            expect(
              bytes.includes(Buffer.from(token)),
              `Unexpected persisted content in ${entry.name}`,
            ).toBe(false);
        }
      }
    }
    await inspect(root);
    expect(files).toBeGreaterThan(5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
