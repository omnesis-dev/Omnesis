// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { hostDuckDb } from "../duckdb-extensions.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const gateway = new URL("../../packages/gateway/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-account-assets-")));
  let server;
  try {
    const scripts = join(root, "scripts", "desktop");
    const packageDir = join(root, "packages", "gateway");
    await mkdir(scripts, { recursive: true });
    await mkdir(join(packageDir, "duckdb-extensions"), { recursive: true });
    await mkdir(join(packageDir, "node_modules", "@duckdb"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ type: "module" }));
    const gatewayRequire = createRequire(new URL("package.json", gateway));
    await symlink(
      dirname(gatewayRequire.resolve("@duckdb/node-api/package.json")),
      join(packageDir, "node_modules", "@duckdb", "node-api"),
    );
    for (const name of ["playwright", "vitest"]) {
      await symlink(
        dirname(require.resolve(`${name}/package.json`)),
        join(root, "node_modules", name),
      );
    }
    await copyFile(
      new URL("./test-account-container.mjs", import.meta.url),
      join(scripts, "test-account-container.mjs"),
    );
    await copyFile(
      new URL("../duckdb-extensions.mjs", import.meta.url),
      join(root, "scripts", "duckdb-extensions.mjs"),
    );
    await copyFile(
      new URL("./account-test.Dockerfile", import.meta.url),
      join(scripts, "account-test.Dockerfile"),
    );
    const reported = await hostDuckDb(packageDir);
    const bytes = Buffer.from("invented pinned account fixture extension bytes");
    const asset = join(
      packageDir,
      "duckdb-extensions",
      reported.version,
      reported.platform,
      "httpfs.duckdb_extension",
    );
    const calls = join(root, "docker-calls.jsonl");
    const docker = join(root, "bin", "docker");
    await writeFile(
      docker,
      `#!${process.execPath}
import * as fs from 'node:fs';import * as crypto from 'node:crypto';
const asset=${JSON.stringify(asset)};let content;try{content=fs.readFileSync(asset)}catch{}
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({command:process.argv[2],sha256:content?crypto.createHash('sha256').update(content).digest('hex'):null})+String.fromCharCode(10));
`,
      { mode: 0o700 },
    );
    await chmod(docker, 0o700);
    const requests = [];
    const serve = async (payload) => {
      server = createServer((request, response) => {
        requests.push(request.url);
        response.end(gzipSync(payload));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    };
    const configure = async (repository) => {
      await writeFile(
        join(packageDir, "duckdb-extensions", "manifest.json"),
        JSON.stringify({
          duckdbVersion: reported.version,
          repository,
          extensions: {
            httpfs: { [reported.platform]: { size: bytes.length, sha256: hash(bytes) } },
          },
        }),
      );
    };
    const launch = (repository) =>
      execute(process.execPath, [join(scripts, "test-account-container.mjs")], {
        cwd: root,
        env: {
          ...process.env,
          CI: "true",
          PATH: join(root, "bin") + delimiter + process.env.PATH,
          OMNESIS_DUCKDB_EXTENSION_REPOSITORY: repository,
        },
      });
    const recorded = async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    await body({ bytes, asset, reported, requests, serve, configure, launch, recorded });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "account launcher prepares actual pinned assets before any image build or container run",
  async () => {
    await fixture(
      async ({ bytes, asset, reported, requests, serve, configure, launch, recorded }) => {
        const repository = await serve(bytes);
        await configure(repository);
        await launch(repository);
        expect(requests).toEqual([
          `/${reported.version}/${reported.platform}/httpfs.duckdb_extension.gz`,
        ]);
        expect(await readFile(asset)).toEqual(bytes);
        expect(await recorded()).toEqual(
          ["build", "run", "rm"].map((command) => ({ command, sha256: hash(bytes) })),
        );
      },
    );
  },
);

test.skipIf(process.platform === "win32")(
  "account launcher uses a verified cached asset without contacting its unavailable repository",
  async () => {
    await fixture(async ({ bytes, asset, configure, launch, recorded }) => {
      const repository = "http://127.0.0.1:1";
      await configure(repository);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, bytes);
      await launch(repository);
      expect(await recorded()).toEqual(
        ["build", "run", "rm"].map((command) => ({ command, sha256: hash(bytes) })),
      );
    });
  },
);

test.skipIf(process.platform === "win32")(
  "account launcher refuses checksum-invalid preparation before building or running Docker",
  async () => {
    await fixture(async ({ requests, serve, configure, launch, recorded }) => {
      const repository = await serve(Buffer.from("different invented bytes"));
      await configure(repository);
      await expect(launch(repository)).rejects.toMatchObject({ code: 1 });
      expect(requests).toHaveLength(4);
      expect(await recorded()).toEqual([{ command: "rm", sha256: null }]);
    });
  },
);
