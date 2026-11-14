// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as fs from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { encryptArtifactFileInPlace, decryptArtifactFileToFile } from "./encrypted-artifact.js";
import { writeWindowsPrivateFileAtomicStream } from "./windows-private-file.js";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
vi.mock("./secret-store.js", async (original) => ({
  ...(await original<typeof import("./secret-store.js")>()),
  readInstallRootKey: () =>
    Promise.resolve(`omn_root_v1_${Buffer.alloc(32, 7).toString("base64url")}`),
}));
vi.mock("./windows-private-file.js", () => ({ writeWindowsPrivateFileAtomicStream: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeWindowsPrivateFileAtomicStream).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each(
  (["encrypt", "decrypt"] as const).flatMap((operation) =>
    (["before-start", "after-start"] as const).map((timing) => ({ operation, timing })),
  ),
)(
  "$operation joins its input and preserves both files when publication fails $timing",
  async ({ operation, timing }) => {
    const root = fs.mkdtempSync(join(tmpdir(), "artifact-publication-"));
    roots.push(root);
    const input = join(root, "invented.dat");
    const plaintext = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    fs.writeFileSync(input, plaintext);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      let source = input;
      let destination = `${input}.enc`;
      const writer = vi.mocked(writeWindowsPrivateFileAtomicStream);
      if (operation === "decrypt") {
        // Build a real authenticated artifact through the product pipeline;
        // only native publication is substituted in this cross-platform test.
        writer.mockImplementationOnce(async (path, body) => {
          const chunks: Buffer[] = [];
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
          fs.writeFileSync(path, Buffer.concat(chunks));
        });
        source = (await encryptArtifactFileInPlace(input, { scope: "export:fixture" })).path;
        destination = join(root, "restored.dat");
      }
      const original = fs.readFileSync(source);
      const retained = Buffer.from("invented previous destination");
      fs.writeFileSync(destination, retained);
      const refusal = new Error("scripted helper initialization failure");
      let body: import("node:stream").Readable | undefined;
      writer.mockImplementationOnce(async (_path, stream) => {
        body = stream;
        if (timing === "after-start") await once(stream, "readable");
        throw refusal;
      });
      const opened: fs.ReadStream[] = [];
      const nativeRead = fs.createReadStream;
      vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
        const stream = nativeRead(...args);
        opened.push(stream);
        return stream;
      });
      const pending =
        operation === "encrypt"
          ? encryptArtifactFileInPlace(source, { scope: "export:fixture" })
          : decryptArtifactFileToFile(source, destination, { force: true });
      await expect(pending).rejects.toBe(refusal);
      expect(body?.destroyed).toBe(true);
      expect(opened).toHaveLength(timing === "before-start" ? 0 : 1);
      for (const stream of opened) expect(stream.closed).toBe(true);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.readFileSync(destination)).toEqual(retained);
      expect(fs.readdirSync(root).sort()).toEqual(
        [source, destination].map((path) => path.slice(root.length + 1)).sort(),
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  },
);
