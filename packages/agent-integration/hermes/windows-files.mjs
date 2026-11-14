// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// This bridge is deployed with canonical generated modules. It has no npm
// dependencies, accepts literal paths, and never places credential bytes in argv.
import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
const { privateWindowsFiles } = await import(
  new URL("./runtime/windows-files.js", import.meta.url).href
);
const { removeStaleRefreshLock, withCredentialRefreshLock } = await import(
  new URL("./runtime/refresh-lease.js", import.meta.url).href
);

const [operation, path, ...extra] = process.argv.slice(2);
try {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Windows Hermes requires Node.js 24 or newer");
  if (operation === "alive") {
    if (extra.length || !/^[1-9][0-9]{0,9}$/.test(path ?? "") || Number(path) > 2147483647)
      throw new Error("Invalid process identity");
    let alive = true;
    try {
      process.kill(Number(path), 0);
    } catch (error) {
      alive = error.code !== "ESRCH";
    }
    process.stdout.write(JSON.stringify(alive));
  } else {
    if (extra.length || !path || !isAbsolute(path) || path.includes("\0") || path.length > 32767)
      throw new Error("Invalid Windows persistence path");
    if (operation === "inspect") {
      const status = privateWindowsFiles().inspectWindowsPrivatePathSync(path, "file");
      if (!status.private) throw new Error("Unsafe state file access");
      process.stdout.write('{"private":true}');
    } else if (operation === "state") {
      const files = privateWindowsFiles();
      files.secureWindowsPrivatePathSync(dirname(path), "directory");
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        // Metadata only: the directory is protected before this existence
        // check, and the native repair itself rejects untrusted owners/links.
        try {
          lstatSync(path + suffix);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        files.secureWindowsPrivatePathSync(path + suffix, "file");
      }
    } else if (operation === "reap") {
      await removeStaleRefreshLock(path);
    } else if (operation === "read") {
      process.stdout.write(privateWindowsFiles().readWindowsPrivateFileContentsSync(path));
    } else if (operation === "write") {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      privateWindowsFiles().writeWindowsPrivateFileAtomicSync(path, Buffer.concat(chunks));
    } else if (operation === "lease") {
      const controller = new AbortController();
      const released = new Promise((resolve) => {
        process.stdin.once("end", () => {
          controller.abort();
          resolve();
        });
        process.stdin.once("error", () => {
          controller.abort();
          resolve();
        });
        process.stdin.resume();
      });
      await withCredentialRefreshLock(
        path,
        undefined,
        () => undefined,
        async () => {
          process.stdout.write('{"ready":true}\n');
          await released;
        },
        { signal: controller.signal },
      );
    } else throw new Error("Unknown Windows persistence operation");
  }
} catch (error) {
  // Do not echo a parser message, stdin, native command, or credential value.
  const code =
    error &&
    typeof error.code === "string" &&
    ["ENOENT", "EACCES", "EPRIVATE", "EEXIST"].includes(error.code)
      ? error.code
      : "EPRIVATE";
  process.stderr.write(
    JSON.stringify({
      code,
      message: "Windows integration persistence failed; check Node.js 24 and private file access",
    }) + "\n",
  );
  process.exitCode = 1;
}
