// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLogger, execWindowsJob, inspectWindowsPrivatePaths } from "@omnesis/core";
import { ensureCodexRuntimeDirs } from "./codex-app-server-backend.js";
import { prepareCodexPrivateState } from "./codex-private-state.js";
import { reconcileMemberAuth } from "./codex-runtime-pool.js";

it.runIf(process.platform === "win32")(
  "repairs existing explicit broad ACLs before Codex use and preserves only its exact owner auth link",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-private-native-"));
    const home = join(root, "owner"),
      workspace = join(root, "workspace"),
      member = join(root, "member");
    const auth = join(home, "auth.json"),
      session = join(home, "sessions", "invented.jsonl");
    try {
      await mkdir(join(home, "sessions"), { recursive: true });
      await mkdir(member);
      await writeFile(auth, "invented retained login");
      await writeFile(session, "invented retained session");
      const command = join(process.env.SystemRoot!, "System32", "icacls.exe");
      for (const file of [auth, session])
        await execWindowsJob(command, [file, "/grant", "*S-1-1-0:(R)"], { timeout: 20_000 });
      expect(
        (
          await inspectWindowsPrivatePaths([
            { path: auth, kind: "file" },
            { path: session, kind: "file" },
          ])
        ).every((entry) => !entry.private),
      ).toBe(true);
      await ensureCodexRuntimeDirs(home, workspace);
      const paths = [
        { path: home, kind: "directory" },
        { path: workspace, kind: "directory" },
        { path: auth, kind: "file" },
        { path: session, kind: "file" },
        { path: join(home, "config.toml"), kind: "file" },
      ] as const;
      expect((await inspectWindowsPrivatePaths(paths)).every((entry) => entry.private)).toBe(true);
      expect(await readFile(auth, "utf8")).toBe("invented retained login");
      expect(await readFile(session, "utf8")).toBe("invented retained session");
      await prepareCodexPrivateState([member]);
      try {
        reconcileMemberAuth(member, auth, createLogger("test:codex-private-native"));
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Enable Windows Developer Mode");
        expect(await readFile(auth, "utf8")).toBe("invented retained login");
        return;
      }
      await prepareCodexPrivateState([member], { home: member, target: auth });
      expect(await readFile(join(member, "auth.json"), "utf8")).toBe("invented retained login");
      await expect(prepareCodexPrivateState([member])).rejects.toThrow("untrusted symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
