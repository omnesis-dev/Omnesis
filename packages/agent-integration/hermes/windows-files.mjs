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

// Credentials and serialized forwarded-tool catalogs are caller-materialized.
// A high finite ceiling preserves that contract without trusting a header to
// allocate memory. Publication additionally requires exact commit bytes and EOF.
const WRITE_MAX_BYTES = 1024 * 1024 * 1024;
const WRITE_MAGIC = Buffer.from("OMNESIS_HERMES_WRITE_V1\0", "ascii");
const WRITE_COMMIT = Buffer.from("\0OMNESIS_HERMES_WRITE_COMMIT_V1\0", "ascii");
async function readWriteFrame() {
  const header = Buffer.alloc(WRITE_MAGIC.length + 4);
  const trailer = Buffer.alloc(WRITE_COMMIT.length);
  const chunks = [];
  let headerBytes = 0,
    payloadBytes = 0,
    trailerBytes = 0,
    length;
  for await (const chunk of process.stdin) {
    let offset = 0;
    while (offset < chunk.length) {
      if (headerBytes < header.length) {
        const count = Math.min(header.length - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes === header.length) {
          if (!header.subarray(0, WRITE_MAGIC.length).equals(WRITE_MAGIC))
            throw new Error("Invalid Windows write frame");
          length = header.readUInt32LE(WRITE_MAGIC.length);
          if (length > WRITE_MAX_BYTES)
            throw new Error("Windows write frame exceeds its input limit");
        }
      } else if (payloadBytes < length) {
        const count = Math.min(length - payloadBytes, chunk.length - offset);
        chunks.push(chunk.subarray(offset, offset + count));
        payloadBytes += count;
        offset += count;
      } else if (trailerBytes < trailer.length) {
        const count = Math.min(trailer.length - trailerBytes, chunk.length - offset);
        chunk.copy(trailer, trailerBytes, offset, offset + count);
        trailerBytes += count;
        offset += count;
      } else throw new Error("Unexpected bytes after Windows write commit");
    }
  }
  if (
    headerBytes !== header.length ||
    payloadBytes !== length ||
    trailerBytes !== trailer.length ||
    !trailer.equals(WRITE_COMMIT)
  )
    throw new Error("Incomplete Windows write frame");
  return Buffer.concat(chunks, length);
}

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
    if (
      (operation === "write"
        ? extra.length !== 1 || extra[0] !== "framed-v1"
        : extra.length !== 0) ||
      !path ||
      !isAbsolute(path) ||
      path.includes("\0") ||
      path.length > 32767
    )
      throw new Error("Invalid Windows persistence path or protocol");
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
      privateWindowsFiles().writeWindowsPrivateFileAtomicSync(path, await readWriteFrame());
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
