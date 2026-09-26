// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Smoke tests for developer-loop scripts. Each test exercises the real
// script end-to-end against a throwaway, isolated fixture — never the live
// gateway, the live DB, or ~/.config/omnesis. All sample data is invented per
// the repo's privacy rules (RFC-2606 domains, fabricated names).
//
// Tier-0 criteria:
//   - scripts/db-stats.ts runs clean (node:fs statSync, not Bun.file).
//   - scripts/test-env.sh emits https:// URLs + exports NODE_EXTRA_CA_CERTS so a
//     sourced CLI/curl call completes the TLS handshake against an isolated
//     gateway.
//   - scripts/chaos-gateway.mjs detects a gateway crash via a cross-platform
//     /health liveness signal (200→down), so it FAILs when a live gateway is
//     killed and stays PASS while it is alive — no macOS-only false-PASS.
//   - scripts/omnesis-where.sh prints the live topology READ-ONLY: the PID
//     listening on the gateway port → its serving checkout vs the current
//     worktree (loud MISMATCH banner when they differ), /admin/devices, and the
//     isolated-port conventions; fails loud (exit 3) when neither lsof nor ss is
//     present, and never false-greens an empty topology.
//   - scripts/dev-instance.sh stands up ONE isolated HTTPS instance on a high
//     port, prints the URL/TOKEN/CA triple in copy-paste form, and gates
//     "ready" on a real /health 200; it fails loud (DEV_INSTANCE_NOT_READY,
//     exit 5) when the instance never serves rather than reporting a dead PID
//     as ready.
//   - the typecheck:fast / typecheck:watch fast-inner-loop scripts exist in
//     package.json and typecheck:fast actually runs clean (exit 0), so the
//     "Fast inner loops" guidance in AGENTS.md points at scripts that work.

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { execFileSync, execFile, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  symlinkSync,
  realpathSync,
  lstatSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gatewayBootBudgetMs } from "./lib/boot-budget.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function schedulerManagedScripts(scripts) {
  const managed = new Set(
    Object.entries(scripts)
      .filter(([, command]) => command.includes("scripts/run-check.mjs"))
      .map(([name]) => name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, command] of Object.entries(scripts)) {
      if (managed.has(name)) continue;
      const dependencies = [...command.matchAll(/\bnpm run ([\w:-]+)/gu)].map((match) => match[1]);
      if (!dependencies.some((dependency) => managed.has(dependency))) continue;
      managed.add(name);
      changed = true;
    }
  }
  return managed;
}

function workflowCheckOwnershipErrors(workflow, scripts, filename = "workflow.yml") {
  const managed = schedulerManagedScripts(scripts);
  const errors = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      for (const line of (step.run ?? "").split("\n").map((value) => value.trim())) {
        const npm = line.match(/^(?:exec\s+)?npm run ([\w:-]+)(?:\s|$)/u);
        if (npm && managed.has(npm[1])) {
          errors.push(`${filename}:${jobName}:${step.name} hides a check owner behind npm`);
        }
        if (
          line.includes("node scripts/run-check.mjs") &&
          !/^exec node scripts\/run-check\.mjs /u.test(line)
        ) {
          errors.push(`${filename}:${jobName}:${step.name} does not forward cancellation`);
        }
      }
    }
  }
  return errors;
}

// One boot budget across everything that spawns a gateway. Both isolated-gateway
// helpers below wait exactly this long, and so do the E2E harness and the two
// dev scripts — see the `why` field in scripts/lib/gateway-boot-budget.json.
const BOOT_BUDGET_MS = gatewayBootBudgetMs();

// A test that boots a gateway has to allow at least as long as the boot itself,
// plus what the test then does with it. Derived, so raising the budget cannot
// leave a test timing out one line after the wait it was given.
const WITH_GATEWAY_TIMEOUT_MS = BOOT_BUDGET_MS + 60_000;
const PID_CAPTURE_TIMEOUT_MS = 5_000;
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const leanGatewayEnv = {
  OMNESIS_IO_CONCURRENCY: "2",
  OMNESIS_CPU_CONCURRENCY: "2",
  OMNESIS_SEARCH_WORKER_CONCURRENCY: "1",
  OMNESIS_USEARCH_BACKFILL_THREADS: "1",
};

describe("developer hooks", () => {
  it("limits pre-push to the two bounded checks", () => {
    const config = readFileSync(join(repoRoot, "lefthook.yml"), "utf8");
    const prePush = config.split(/^pre-push:\s*$/m)[1];
    expect(prePush).toBeTruthy();
    const commands = [...prePush.matchAll(/^\s{6}run:\s+(.+)$/gm)].map((match) => match[1]);
    expect(commands).toEqual(["npm run format:check", "npm run privacy:scan"]);
  });
});

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function tmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("scripts/db-stats.ts", () => {
  it("runs clean against an isolated DB and reports size + counts", async () => {
    const dir = tmpDir("omnesis-dbstats-");
    const dbPath = join(dir, "test.db");

    // Seed a throwaway DB with the columns db-stats reads, using invented data.
    const { default: Database } = await import("better-sqlite3");
    const seed = new Database(dbPath);
    seed.exec(
      "CREATE TABLE documents (provider_id TEXT, source_id TEXT, title TEXT, source_created_at TEXT, external_id TEXT, ingested_at TEXT, links_extracted_at TEXT);",
    );
    seed.exec("CREATE TABLE sync_state (source_id TEXT, cursor TEXT, last_synced_at TEXT);");
    const ins = seed.prepare("INSERT INTO documents VALUES (?,?,?,?,?,?,?)");
    ins.run(
      "gmail",
      "gmail:work",
      "Q4 budget review",
      "2026-01-01T00:00:00Z",
      "ext-1",
      "2026-01-02T00:00:00Z",
      null,
    );
    ins.run(
      "notion",
      "notion:notes",
      "Marathon entry form",
      "2026-02-01T00:00:00Z",
      "ext-2",
      "2026-02-02T00:00:00Z",
      null,
    );
    seed
      .prepare("INSERT INTO sync_state VALUES (?,?,?)")
      .run("gmail:work", JSON.stringify({ page: "abc" }), "2026-01-02T00:00:00Z");
    seed.close();

    // Run the real script. Before the fix this threw a ReferenceError on the
    // (Bun-only) Bun.file call, so a non-zero exit here is the regression net.
    const out = execFileSync(tsx, ["scripts/db-stats.ts", dbPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(out).toContain("Total documents: 2");
    expect(out).toMatch(/Db size: \d+\.\d+ MB/);
    expect(out).not.toMatch(/\bBun\b/);
  });

  it("fails loudly when the DB path does not exist", () => {
    const dir = tmpDir("omnesis-dbstats-missing-");
    expect(() =>
      execFileSync(tsx, ["scripts/db-stats.ts", join(dir, "nope.db")], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow();
  });
});

describe("scripts/test-env.sh", () => {
  // Source the script in a clean shell and dump the env it sets. We override
  // OMNESIS_CONFIG_DIR via a wrapper that re-exports after sourcing? No — the
  // script hardcodes the dir, so we just read whatever it sets and key the
  // probe off that, copying nothing into the live tree.
  function sourcedEnv() {
    const raw = execFileSync(
      "bash",
      [
        "-c",
        `source "${join(repoRoot, "scripts/test-env.sh")}" >/dev/null 2>&1; ` +
          `printf '%s\\n%s\\n%s\\n' "$OMNESIS_GATEWAY_URL" "$OMNESIS_COLLECTOR_URL" "$NODE_EXTRA_CA_CERTS"`,
      ],
      { encoding: "utf8" },
    );
    const [gatewayUrl, collectorUrl, caCert] = raw.trim().split("\n");
    return { gatewayUrl, collectorUrl, caCert };
  }

  it("exports https:// URLs and a NODE_EXTRA_CA_CERTS pointing at the config dir's cert", () => {
    const { gatewayUrl, collectorUrl, caCert } = sourcedEnv();
    expect(gatewayUrl).toMatch(/^https:\/\//);
    expect(collectorUrl).toMatch(/^https:\/\//);
    expect(caCert).toMatch(/\/tls\/cert\.pem$/);
  });

  it("its exported env lets a Node client complete the TLS handshake against an isolated self-signed gateway", async () => {
    const { gatewayUrl, caCert } = sourcedEnv();

    // Mint a self-signed cert at the exact path the script exports, mirroring
    // what the gateway writes to <configDir>/tls/cert.pem on first boot. Refuse
    // to clobber a pre-existing cert (a running isolated gateway may own this
    // path) — fail loud rather than silently overwrite live test state.
    const tlsDir = dirname(caCert);
    if (existsSync(caCert)) {
      throw new Error(
        `refusing to overwrite existing cert at ${caCert} — stop the isolated gateway sourcing test-env.sh first`,
      );
    }
    mkdirSync(tlsDir, { recursive: true });
    cleanups.push(() => rmSync(caCert, { force: true }));
    cleanups.push(() => rmSync(join(tlsDir, "key.pem"), { force: true }));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(tlsDir, "key.pem"),
        "-out",
        caCert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );

    const port = new URL(gatewayUrl).port;

    // Tiny HTTPS server using that cert, on the script's configured port.
    const server = spawn(
      process.execPath,
      [
        "-e",
        `const https=require("node:https"),fs=require("node:fs");` +
          `const d=${JSON.stringify(tlsDir)};` +
          `https.createServer({key:fs.readFileSync(d+"/key.pem"),cert:fs.readFileSync(d+"/cert.pem")},` +
          `(q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end('{"status":"ok"}');})` +
          `.listen(${Number(port)},"localhost",()=>console.log("LISTENING"));`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanups.push(() => server.kill());
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server start timeout")), 8000);
      server.stdout.on("data", (b) => {
        if (b.toString().includes("LISTENING")) {
          clearTimeout(t);
          resolve();
        }
      });
      server.on("error", reject);
    });

    // Probe with a clean Node process that inherits ONLY the sourced env's
    // NODE_EXTRA_CA_CERTS — no rejectUnauthorized:false escape hatch.
    const probe =
      `fetch(${JSON.stringify(gatewayUrl)}+"/health")` +
      `.then(r=>r.text().then(t=>{process.stdout.write("OK:"+r.status+":"+t);}))` +
      `.catch(e=>{process.stdout.write("ERR:"+(e.cause&&e.cause.code||e.code||e.message));process.exit(3);});`;
    const result = execFileSync(process.execPath, ["-e", probe], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
      encoding: "utf8",
    });
    expect(result).toContain("OK:200");

    // Negative control: drop the CA and the same probe must fail to verify the
    // self-signed cert — proving the export is load-bearing, not a no-op.
    let failed = "";
    try {
      execFileSync(process.execPath, ["-e", probe], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: "" },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      failed = (e.stdout || "").toString();
    }
    expect(failed).toMatch(/SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT/);
  });
});

describe("scripts/chaos-gateway.mjs cross-platform liveness", () => {
  // High port to avoid the live gateway (7600) and OAuth ports (3000-3003);
  // a per-test offset keeps reruns from colliding with a lingering listener.
  const PORT = 28700 + Math.floor(Math.random() * 200);

  // Boot a minimal isolated gateway (no embedder model → no indexer), wait
  // for /health 200 + a token, and return the handle + isolated paths. Never
  // touches the live gateway, the live DB, or ~/.config/omnesis.
  async function startIsolatedGateway() {
    const configDir = tmpDir("omnesis-chaos-gw-");
    const env = {
      ...process.env,
      ...leanGatewayEnv,
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_DB_PATH: join(configDir, "omnesis.db"),
      OMNESIS_INDEX_DB_PATH: join(configDir, "index.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(configDir, "analytics.db"),
      OMNESIS_GATEWAY_PORT: String(PORT),
      OMNESIS_LOG_LEVEL: "warn",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_BIND: "127.0.0.1",
    };
    // Spawn the already-resolved local tsx binary directly. Detached mode puts
    // the gateway in its own process group so cleanup cannot orphan it.
    const proc = spawn(tsx, ["packages/gateway/src/index.ts"], {
      env,
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let outputTail = "";
    let termination = "";
    const appendOutput = (chunk) => {
      outputTail = `${outputTail}${chunk.toString()}`.slice(-16 * 1024);
    };
    proc.stdout.on("data", appendOutput);
    proc.stderr.on("data", appendOutput);
    proc.once("error", (error) => {
      termination = `spawn failed: ${error.message}`;
    });
    proc.once("exit", (code, signal) => {
      termination = `exited code=${code ?? "null"} signal=${signal ?? "none"}`;
    });
    const caCert = join(configDir, "tls", "cert.pem");
    const tokenPath = join(configDir, "token");
    const url = `https://localhost:${PORT}`;

    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        if (typeof proc.pid === "number") process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    cleanups.push(kill);

    // Wait for the cross-platform readiness signal: /health 200 with the
    // CA the gateway just minted trusted via NODE_EXTRA_CA_CERTS.
    const deadline = Date.now() + BOOT_BUDGET_MS;
    while (Date.now() < deadline) {
      if (termination) {
        kill();
        throw new Error(`isolated gateway ${termination}\n${outputTail}`);
      }
      if (existsSync(caCert) && existsSync(tokenPath)) {
        const ok = await new Promise((resolve) => {
          execFile(
            process.execPath,
            [
              "-e",
              `fetch(${JSON.stringify(url)}+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));`,
            ],
            { env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert }, timeout: 5000 },
            (err) => resolve(!err),
          );
        });
        if (ok) return { configDir, caCert, tokenPath, url, kill, proc };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    kill();
    throw new Error(
      `isolated gateway did not become healthy on ${url} within ${BOOT_BUDGET_MS / 1000}s` +
        `${outputTail ? `\nGateway output tail:\n${outputTail}` : ""}`,
    );
  }

  // Run the real chaos harness against the isolated gateway, returning its
  // exit code + combined stdout/stderr. Light load (no checkpoint pressure;
  // we are testing crash DETECTION, not reproducing the -shm SIGBUS).
  function runChaos(gw, durationSec) {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(repoRoot, "scripts/chaos-gateway.mjs"), String(durationSec)],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            OMNESIS_GATEWAY_URL: gw.url,
            CHAOS_TOKEN_PATH: gw.tokenPath,
            CHAOS_DB_PATH: join(gw.configDir, "omnesis.db"),
            CHAOS_INGEST: "0",
            CHAOS_CONCURRENCY: "2",
            CHAOS_LIVENESS_MS: "300",
            NODE_EXTRA_CA_CERTS: gw.caCert,
          },
          timeout: (durationSec + 20) * 1000,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it(
    "stays PASS while the gateway is alive",
    async () => {
      const gw = await startIsolatedGateway();
      const { code, out } = await runChaos(gw, 2);
      expect(out).toContain("PASS");
      expect(out).not.toContain("LIVENESS LOST");
      expect(code).toBe(0);
    },
    WITH_GATEWAY_TIMEOUT_MS,
  );

  it(
    "flips to FAIL when the gateway is killed mid-run (negative control)",
    async () => {
      const gw = await startIsolatedGateway();
      // Kill the gateway shortly after the harness establishes its baseline,
      // then let the run finish so it reports its verdict.
      setTimeout(() => gw.kill(), 2500);
      const { code, out } = await runChaos(gw, 8);
      expect(out).toContain("LIVENESS LOST");
      expect(out).toContain("FAIL");
      expect(out).not.toContain("PASS");
      expect(code).toBe(1);
    },
    WITH_GATEWAY_TIMEOUT_MS,
  );

  it("fails loud (exit 2) when the gateway never comes up — no false-PASS", async () => {
    // Point the harness at a high port with nothing listening. There is no
    // baseline 200, so it must error out, never silently PASS.
    const configDir = tmpDir("omnesis-chaos-nogw-");
    const tokenPath = join(configDir, "token");
    writeFileSync(tokenPath, "irrelevant-token");
    const deadPort = PORT + 500;
    const { code, out } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [join(repoRoot, "scripts/chaos-gateway.mjs"), "5"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            OMNESIS_GATEWAY_URL: `http://localhost:${deadPort}`,
            CHAOS_TOKEN_PATH: tokenPath,
            CHAOS_INGEST: "0",
            CHAOS_LIVENESS_MS: "300",
            CHAOS_BASELINE_MS: "2000",
          },
          timeout: 30000,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
    expect(out).toContain("BASELINE NOT ESTABLISHED");
    expect(out).not.toContain("PASS");
    expect(code).toBe(2);
  }, 40000);
});

describe("scripts/omnesis-where.sh read-only topology", () => {
  const whereScript = join(repoRoot, "scripts/omnesis-where.sh");
  // High port well clear of the live gateway (7600) and OAuth ports (3000-3003);
  // a per-test offset keeps reruns from colliding with a lingering listener.
  const PORT = 29100 + Math.floor(Math.random() * 200);

  // Boot a minimal isolated gateway from a chosen working directory. The
  // gateway's process cwd is what omnesis-where.sh discovers as the "serving
  // checkout", so passing servingDir lets us drive both the MISMATCH and the
  // match branches deterministically. Never touches the live gateway/DB.
  async function startIsolatedGateway({ port, servingDir }) {
    const configDir = tmpDir("omnesis-where-gw-");
    const env = {
      ...process.env,
      ...leanGatewayEnv,
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_DB_PATH: join(configDir, "omnesis.db"),
      OMNESIS_INDEX_DB_PATH: join(configDir, "index.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(configDir, "analytics.db"),
      OMNESIS_GATEWAY_PORT: String(port),
      OMNESIS_LOG_LEVEL: "warn",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_BIND: "127.0.0.1",
    };
    const proc = spawn(tsx, [join(repoRoot, "packages/gateway/src/index.ts")], {
      env,
      // cwd is the discovered "serving checkout"; the gateway entry is an
      // absolute path so it loads regardless of where we launch it from.
      cwd: servingDir,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const caCert = join(configDir, "tls", "cert.pem");
    const tokenPath = join(configDir, "token");
    const url = `https://localhost:${port}`;

    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      try {
        if (typeof proc.pid === "number") process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };
    cleanups.push(kill);

    const deadline = Date.now() + BOOT_BUDGET_MS;
    while (Date.now() < deadline) {
      if (existsSync(caCert) && existsSync(tokenPath)) {
        const ok = await new Promise((resolve) => {
          execFile(
            process.execPath,
            [
              "-e",
              `fetch(${JSON.stringify(url)}+"/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));`,
            ],
            { env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert }, timeout: 5000 },
            (err) => resolve(!err),
          );
        });
        if (ok) return { configDir, caCert, tokenPath, url, port, kill };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    kill();
    throw new Error(
      `isolated gateway did not become healthy on ${url} within ${BOOT_BUDGET_MS / 1000}s`,
    );
  }

  // Pair a device via POST /admin/devices so the /admin/devices listing has a
  // row to print. Invented device name per the repo's privacy rules.
  async function pairDevice(gw) {
    const token = readFileSync(gw.tokenPath, "utf8").trim();
    const code = `
      const fs=require("node:fs");
      fetch(${JSON.stringify(gw.url)}+"/admin/devices",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+${JSON.stringify(token)}},
        body:JSON.stringify({name:"where-test-cli",kind:"cli",scopes:["admin"]}),
      }).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));`;
    await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ["-e", code],
        { env: { ...process.env, NODE_EXTRA_CA_CERTS: gw.caCert }, timeout: 8000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  // Run the real script against a gateway. We pass the token + cert via env so
  // the script resolves the same isolated instance — never the live one.
  function runWhere(gw, extraEnv = {}) {
    return new Promise((resolve) => {
      execFile(
        "bash",
        [whereScript],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            OMNESIS_GATEWAY_URL: gw.url,
            OMNESIS_TOKEN: readFileSync(gw.tokenPath, "utf8").trim(),
            NODE_EXTRA_CA_CERTS: gw.caCert,
            ...extraEnv,
          },
          timeout: 30000,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it(
    "reports the listening PID, the serving checkout, the MISMATCH banner, and devices",
    async () => {
      // Boot the gateway from a temp dir that is NOT this worktree, so its cwd
      // (the discovered serving checkout) differs from WORKTREE_ROOT → MISMATCH.
      const foreignDir = tmpDir("omnesis-where-foreign-");
      const gw = await startIsolatedGateway({ port: PORT, servingDir: foreignDir });
      await pairDevice(gw);

      const { code, out } = await runWhere(gw);
      expect(code).toBe(0);
      // Core question: which PID serves this port, from where.
      expect(out).toMatch(new RegExp(`Listening PID on :${PORT} → \\d+`));
      // The script reports the serving checkout as a real (symlink-resolved) path,
      // so compare against the resolved temp dir — on macOS mkdtemp lands under
      // /var/folders which resolves to /private/var/folders.
      expect(out).toContain(`serving from:  ${realpathSync(foreignDir)}`);
      // The "wrong instance" guard fired because the checkout differs.
      expect(out).toContain("MISMATCH");
      expect(out).toContain(realpathSync(repoRoot)); // names this worktree in the banner
      // /admin/devices listing reached the gateway and printed the paired device.
      expect(out).toContain("where-test-cli");
    },
    WITH_GATEWAY_TIMEOUT_MS,
  );

  it(
    "prints a match (no MISMATCH) when the gateway serves THIS worktree — negative control",
    async () => {
      // Same script, same machinery, but the gateway's cwd IS this worktree, so
      // the MISMATCH banner must be ABSENT. This is the negative control that
      // proves the banner tracks the checkout comparison rather than always
      // firing (or never firing).
      const gw = await startIsolatedGateway({ port: PORT + 1, servingDir: repoRoot });

      const { code, out } = await runWhere(gw);
      expect(code).toBe(0);
      expect(out).toContain(`serving from:  ${realpathSync(repoRoot)}`);
      expect(out).toContain("is serving THIS worktree");
      expect(out).not.toContain("MISMATCH");
    },
    WITH_GATEWAY_TIMEOUT_MS,
  );

  it("fails loud (exit 3) when neither lsof nor ss is on PATH — no false-green topology", async () => {
    // Build a minimal PATH dir holding every coreutil the script needs to run
    // up to its own tool check, but deliberately OMITTING lsof and ss. With
    // neither resolver available the script must say exactly what is missing
    // and exit 3 — never print a misleading "nothing is listening" topology.
    const binDir = tmpDir("omnesis-where-nobin-");
    const need = [
      "bash",
      "dirname",
      "sed",
      "readlink",
      "cat",
      "mktemp",
      "cut",
      "head",
      "grep",
      "printf",
    ];
    for (const tool of need) {
      const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
        encoding: "utf8",
      }).trim();
      // printf is a bash builtin (no external path) — that is fine, bash
      // resolves it internally; only symlink the ones that have a real path.
      if (real && real.startsWith("/")) symlinkSync(real, join(binDir, tool));
    }

    const { code, out } = await new Promise((resolve) => {
      execFile(
        join(binDir, "bash"),
        [whereScript],
        {
          cwd: repoRoot,
          env: { ...process.env, PATH: binDir, OMNESIS_GATEWAY_PORT: String(PORT + 2) },
          timeout: 15000,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
    expect(out).toContain("CANNOT INSPECT TOPOLOGY");
    expect(code).toBe(3);
  }, 30000);
});

describe("scripts/dev-instance.sh one-command isolated instance", () => {
  const devInstance = join(repoRoot, "scripts/dev-instance.sh");
  // High port well clear of the live gateway (7600) and OAuth ports (3000-3003);
  // a per-test offset keeps reruns from colliding with a lingering listener.
  const PORT = 19300 + Math.floor(Math.random() * 200);

  // Run dev-instance.sh with an isolated config dir + port, returning the exit
  // code and combined output. Never touches the live gateway / DB / config.
  function runDevInstance(args, { configDir, port, extraEnv = {}, timeout = 120000 }) {
    return new Promise((resolve) => {
      execFile(
        "bash",
        [devInstance, ...args],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            ...leanGatewayEnv,
            OMNESIS_CONFIG_DIR: configDir,
            OMNESIS_GATEWAY_PORT: String(port),
            ...extraEnv,
          },
          timeout,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  // Parse the three exported values out of the triple block so the test drives
  // the instance with EXACTLY what a human would copy-paste — not values it
  // reconstructs itself.
  function parseTriple(out) {
    const url = out.match(/^export OMNESIS_GATEWAY_URL=(\S+)$/m)?.[1];
    const token = out.match(/^export OMNESIS_TOKEN=(\S+)$/m)?.[1];
    const caCert = out.match(/^export NODE_EXTRA_CA_CERTS=(\S+)$/m)?.[1];
    return { url, token, caCert };
  }

  it("boots an isolated instance, prints a usable URL/TOKEN/CA triple, and only reports ready on /health 200", async () => {
    const configDir = tmpDir("omnesis-dev-instance-");
    // --bare: synthetic mode but no seeding, so the boot is fast and needs no
    // real provider data. The readiness gate still proves /health serves.
    const { code, out } = await runDevInstance(["start", "--bare"], {
      configDir,
      port: PORT,
      extraEnv: { OMNESIS_DEV_READY_TIMEOUT: "100", OMNESIS_LOG_LEVEL: "warn" },
    });
    // Ensure the instance is torn down even if an assertion below throws.
    cleanups.push(() => {
      try {
        execFileSync("bash", [devInstance, "stop"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            OMNESIS_CONFIG_DIR: configDir,
            OMNESIS_GATEWAY_PORT: String(PORT),
          },
          stdio: "ignore",
        });
      } catch {
        /* already stopped */
      }
    });

    expect(code).toBe(0);
    expect(out).toContain("SERVING (/health 200)");

    const { url, token, caCert } = parseTriple(out);
    // The triple is well-formed: https URL on the isolated high port, a token,
    // and an ABSOLUTE CA path (so it resolves from any working directory).
    expect(url).toBe(`https://localhost:${PORT}`);
    expect(token).toBeTruthy();
    expect(caCert).toMatch(/^\/.*\/tls\/cert\.pem$/);
    expect(caCert?.startsWith(configDir)).toBe(true);
    expect(existsSync(caCert)).toBe(true);

    // The triple is actually USABLE, not just printed: a probe using EXACTLY
    // those three values reaches /health 200. Run it in a clean Node process
    // whose only trust anchor is the printed CA — no rejectUnauthorized escape.
    const probe =
      `fetch(${JSON.stringify(url)}+"/health")` +
      `.then(r=>{process.stdout.write("HEALTH:"+r.status);process.exit(r.ok?0:1);})` +
      `.catch(e=>{process.stdout.write("ERR:"+(e.cause&&e.cause.code||e.code||e.message));process.exit(2);});`;
    const health = execFileSync(process.execPath, ["-e", probe], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
      encoding: "utf8",
    });
    expect(health).toBe("HEALTH:200");

    // The token is also usable: an authenticated read-only GET reaches the
    // isolated instance with the triple's token + CA.
    const authProbe =
      `fetch(${JSON.stringify(url)}+"/admin/devices",{headers:{Authorization:"Bearer "+${JSON.stringify(token)}}})` +
      `.then(r=>{process.stdout.write("DEVICES:"+r.status);process.exit(r.ok?0:1);})` +
      `.catch(e=>{process.stdout.write("ERR:"+(e.cause&&e.cause.code||e.code||e.message));process.exit(2);});`;
    const devices = execFileSync(process.execPath, ["-e", authProbe], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: caCert },
      encoding: "utf8",
    });
    expect(devices).toBe("DEVICES:200");

    // `info` against the same config dir reprints the identical triple, so a
    // later shell can recover the values without re-reading the boot output.
    const info = await runDevInstance(["info"], { configDir, port: PORT, timeout: 15000 });
    expect(info.code).toBe(0);
    expect(parseTriple(info.out)).toEqual({ url, token, caCert });
  }, 150000);

  it("propagates its timeout to synth boot and reaps a gateway that never becomes ready", async () => {
    const configDir = tmpDir("omnesis-dev-instance-synth-timeout-");
    const fakeBin = tmpDir("omnesis-synth-timeout-bin-");
    const port = PORT + 250;
    // Keep the owned gateway generation alive while deterministically exposing
    // a non-ready HTTPS status. A real warm gateway could legitimately serve
    // within one second, which would make this negative control meaningless.
    writeFileSync(
      join(fakeBin, "npx"),
      `#!/usr/bin/env bash\nmkdir -p "$OMNESIS_CONFIG_DIR/tls"\nprintf 'omn_test_token\\n' > "$OMNESIS_CONFIG_DIR/token"\nprintf 'test-ca\\n' > "$OMNESIS_CONFIG_DIR/tls/cert.pem"\nexec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(fakeBin, "curl"), "#!/usr/bin/env bash\nprintf '503'\n", { mode: 0o755 });
    cleanups.push(() => {
      try {
        execFileSync("bash", [devInstance, "stop"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            OMNESIS_CONFIG_DIR: configDir,
            OMNESIS_GATEWAY_PORT: String(port),
          },
          stdio: "ignore",
        });
      } catch {
        /* the failed start should already have reaped it */
      }
    });

    const attempt = runDevInstance(["start", "--bare"], {
      configDir,
      port,
      extraEnv: {
        PATH: `${fakeBin}:${process.env.PATH}`,
        OMNESIS_DEV_READY_TIMEOUT: "1",
        OMNESIS_LOG_LEVEL: "warn",
      },
      timeout: 15000,
    });

    // Capture the exact generation the script owns before its failure cleanup
    // removes the PID file. This proves the process, not merely the file, dies.
    let gatewayPid;
    const pidDeadline = Date.now() + PID_CAPTURE_TIMEOUT_MS;
    while (Date.now() < pidDeadline && gatewayPid === undefined) {
      const pidPath = join(configDir, "gateway.pid");
      if (existsSync(pidPath)) gatewayPid = Number(readFileSync(pidPath, "utf8").trim());
      if (gatewayPid === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const { code, out } = await attempt;
    expect(gatewayPid).toBeGreaterThan(0);
    expect(code).not.toBe(0);
    expect(out).toContain("SYNTH_GATEWAY_NOT_READY");
    expect(out).toContain("refusing to start the collector");
    expect(out).not.toContain("Gateway up");
    expect(existsSync(join(configDir, "collector.pid"))).toBe(false);
    expect(existsSync(join(configDir, "gateway.pid"))).toBe(false);
    expect(() => process.kill(gatewayPid, 0)).toThrow();
  }, 30000);

  it("fails loud (DEV_INSTANCE_NOT_READY, exit 5) when the instance never serves — no false-ready", async () => {
    // Negative control: a config dir with a token + CA cert present but NO
    // gateway listening on the port. The readiness gate must time out and
    // surface the named signal, never report a dead instance as ready.
    const configDir = tmpDir("omnesis-dev-instance-dead-");
    mkdirSync(join(configDir, "tls"), { recursive: true });
    writeFileSync(join(configDir, "token"), "omn_irrelevant_token");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(configDir, "tls", "key.pem"),
        "-out",
        join(configDir, "tls", "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );

    const { code, out } = await runDevInstance(["wait"], {
      configDir,
      port: PORT + 300, // nothing listening here
      extraEnv: { OMNESIS_DEV_READY_TIMEOUT: "2" },
      timeout: 15000,
    });
    expect(out).toContain("DEV_INSTANCE_NOT_READY");
    // The success path echoes a standalone "ready" line; it must be absent here.
    expect(out).not.toMatch(/^ready$/m);
    expect(code).toBe(5);
  }, 30000);

  it("refuses the live gateway's reserved port / config dir (isolation rail)", async () => {
    const configDir = tmpDir("omnesis-dev-instance-guard-");
    // Port 7600 is the live gateway — must refuse with exit 4, never boot.
    const onLivePort = await runDevInstance(["start"], {
      configDir,
      port: 7600,
      timeout: 15000,
    });
    expect(onLivePort.out).toContain("REFUSING TO START");
    expect(onLivePort.code).toBe(4);
  }, 20000);
});

describe("scripts/lib/safe_kill helper (C7)", () => {
  // safe_kill kills processes matching a pattern but (1) never the caller or its
  // parent ($$/$PPID), and (2) fail-louds (non-zero, named message) on a
  // zero-match or self-only match rather than silently no-op'ing on a wrong
  // pattern. The negative controls — the harness must SURVIVE a pattern that
  // matches it, and a wrong pattern must error — are the teeth of this test.
  const safeKill = join(repoRoot, "scripts/lib/safe_kill");

  // A tag unique per test run, carried in a detached node sleeper's argv so
  // `pgrep -f <tag>` matches it. The tag is opaque (no corpus data, no operator
  // value). The sleeper is detached + unref'd; we always reap it in a finally.
  function spawnTaggedSleeper(tag) {
    const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);", tag], {
      detached: true,
      stdio: "ignore",
    });
    proc.unref();
    return proc;
  }

  function reap(proc) {
    if (proc && typeof proc.pid === "number") {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }

  // Bounded poll for "no live process matches tag" — never a foreground sleep
  // (itself one of the documented gotchas); poll pgrep until quiet or deadline.
  async function waitGone(tag, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const n = countAlive(tag);
      if (n === 0) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  function countAlive(tag) {
    const out = execFileSync("bash", ["-c", `pgrep -f -- ${tag} || true`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      // Drop dead/transient PIDs (e.g. the pgrep-side subshell that carried the
      // tag in its argv). `kill -0` is the cross-platform liveness probe;
      // `/proc/<pid>` exists only on Linux, so it would report 0 alive on macOS.
      .filter((pid) => {
        try {
          process.kill(Number(pid), 0);
          return true;
        } catch {
          return false;
        }
      });
    return out.length;
  }

  function runSafeKill(pattern, signal) {
    const args = signal ? [pattern, signal] : [pattern];
    return new Promise((resolve) => {
      execFile(
        "bash",
        [safeKill, ...args],
        { cwd: repoRoot, encoding: "utf8", timeout: 10000 },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (err.code ?? 1) : 0,
            out: `${stdout}\n${stderr}`,
          });
        },
      );
    });
  }

  it("kills processes matching the pattern", async () => {
    const tag = `OMNESIS-SAFEKILL-HIT-${Math.random().toString(36).slice(2, 10)}`;
    const a = spawnTaggedSleeper(tag);
    const b = spawnTaggedSleeper(tag);
    try {
      // Let the sleepers register a cmdline pgrep can match.
      await new Promise((r) => setTimeout(r, 400));
      expect(countAlive(tag)).toBeGreaterThanOrEqual(2);

      const { code, out } = await runSafeKill(tag, "KILL");
      expect(code, `safe_kill should succeed when it kills real matches: ${out}`).toBe(0);
      expect(await waitGone(tag), `sleepers tagged ${tag} should be dead`).toBe(true);
    } finally {
      reap(a);
      reap(b);
    }
  }, 20000);

  it("fail-louds (exit 3, named message) when nothing real matches", async () => {
    const tag = `OMNESIS-SAFEKILL-NONE-${Math.random().toString(36).slice(2, 10)}`;
    // Nothing was spawned with this tag, so the only thing carrying it is the
    // `bash <safe_kill> <tag>` invocation itself — which safe_kill drops as
    // self. Either way there is nothing real to kill, so it must fail-loud
    // (exit 3) with a named message rather than report a no-op as success.
    const { code, out } = await runSafeKill(tag);
    expect(code, `zero/self-only match must be a hard error, not a silent no-op: ${out}`).toBe(3);
    expect(out).toMatch(/matched no processes|matched only this process and\/or its parent/);
  });

  it("fail-louds with the no-match message when sourced + given a truly absent pattern", async () => {
    // Source the helper and call the function with a pattern the calling shell's
    // own argv does NOT contain, so neither $$ nor $PPID self-matches it and the
    // raw match set is genuinely empty → the "matched no processes" branch.
    const tag = `OMNESIS-SAFEKILL-ABSENT-${Math.random().toString(36).slice(2, 10)}`;
    const script = `source ${JSON.stringify(safeKill)}; safe_kill "$ABSENT_TAG"`;
    const { code, out } = await new Promise((resolve) => {
      execFile(
        "bash",
        ["-c", script],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, ABSENT_TAG: tag },
          timeout: 10000,
        },
        (err, stdout, stderr) =>
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` }),
      );
    });
    expect(code, `truly-absent pattern must fail-loud: ${out}`).toBe(3);
    expect(out).toContain("matched no processes");
  });

  it("fail-louds (exit 2) when no pattern is given", async () => {
    const { code, out } = await runSafeKill("");
    expect(code).toBe(2);
    expect(out).toContain("no pattern given");
  });

  it("never kills the caller / its parent (self-only match → fail-loud, harness survives)", async () => {
    // Drive safe_kill with a pattern guaranteed to match the invoking shell
    // itself (and its parent) and NOTHING ELSE: the literal absolute path of
    // the helper appears in the `bash <safeKill> <pattern>` command line, so a
    // naive matcher would match — and kill — the very shell running it. After
    // dropping $$/$PPID there is nothing real left, so it must fail-loud
    // (exit 3) AND this test process must survive.
    const myPidBefore = process.pid;
    const { code, out } = await runSafeKill(safeKill, "KILL");
    // Self-only match: errors rather than reporting a no-op as success.
    expect(code, `self-only match must fail-loud, not succeed: ${out}`).toBe(3);
    expect(out).toMatch(/matched only this process and\/or its parent|matched no processes/);
    // The teeth: the harness (and this very test) is still alive.
    expect(process.pid).toBe(myPidBefore);
    // Prove liveness by doing real work after the call returned.
    expect(1 + 1).toBe(2);
  }, 20000);

  it("is referenced from AGENTS.md and docs/agent-gotchas.md exists with all 5 footguns", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents, "AGENTS.md must link the cheat-sheet").toContain("docs/agent-gotchas.md");
    expect(agents, "AGENTS.md must point at scripts/lib/safe_kill").toContain(
      "scripts/lib/safe_kill",
    );

    const gotchasPath = join(repoRoot, "docs/agent-gotchas.md");
    expect(existsSync(gotchasPath), "docs/agent-gotchas.md must exist").toBe(true);
    const gotchas = readFileSync(gotchasPath, "utf8");
    // All 5 named footguns must be present + accurate.
    for (const needle of [
      "foreground `sleep`",
      "`pkill -f` self-match",
      "noclobber",
      "networkidle",
      "symlink-farm",
    ]) {
      expect(gotchas, `agent-gotchas.md must cover ${needle}`).toContain(needle);
    }
  });
});

describe("scripts/ios-snapshot.sh macOS-host bridge guards (C10)", () => {
  // scripts/ios-snapshot.sh bridges the iOS snapshot loop to a configured
  // macOS build host over ssh. The actual Mac round-trip is exercised manually
  // (it needs Xcode). These are the Linux-runnable, CI-safe NEGATIVE CONTROLS
  // for the script's fail-loud guards: they must fire WITHOUT a real Mac.
  //
  //   - unset OMNESIS_EPIC_MACOS_HOST → a clear error + non-zero exit (the
  //     script never falls back to a guessed personal alias).
  //   - a scratch path that resolves into a CI runner `_work` clone → refused.
  //   - a scratch path marked as the primary checkout (.omnesis-primary
  //     sentinel) → refused.
  //
  // The host guards need the script to "ssh" somewhere; we stub `ssh` with a
  // local shim that drops the host arg and runs the remaining command in a
  // local bash, so `printf`/`test`/`mkdir` resolve against a sandbox dir on
  // THIS box. That lets the path-guard logic run end-to-end on Linux.
  const iosSnapshot = join(repoRoot, "scripts/ios-snapshot.sh");

  // Build a PATH dir whose `ssh` is a shim: `ssh <host> <cmd...>` → `bash -c
  // <cmd>` locally. Every other tool the script needs is symlinked through.
  function sshStubPath() {
    const binDir = tmpDir("omnesis-ios-snap-bin-");
    const sshShim = join(binDir, "ssh");
    // $1 is the host (ignored); the rest is the remote command. `bash -lc`
    // mirrors how the script invokes the remote shell.
    writeFileSync(sshShim, '#!/usr/bin/env bash\nshift\nexec bash -c "$@"\n', { mode: 0o755 });
    const need = [
      "bash",
      "rsync",
      "dirname",
      "printf",
      "test",
      "mkdir",
      "cat",
      "ls",
      "wc",
      "tr",
      "find",
      "cp",
      "rm",
    ];
    for (const tool of need) {
      const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
        encoding: "utf8",
      }).trim();
      if (real && real.startsWith("/")) symlinkSync(real, join(binDir, tool));
    }
    return binDir;
  }

  function runIosSnapshot(args, { extraEnv = {}, path = null, timeout = 20000 }) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...extraEnv };
      if (path) env.PATH = path;
      execFile(
        "bash",
        [iosSnapshot, ...args],
        { cwd: repoRoot, env, timeout },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("fails loud with EX_CONFIG (78) when OMNESIS_EPIC_MACOS_HOST is unset — never a guessed alias", async () => {
    // Strip the var explicitly (a dev may have it exported in their shell).
    const { code, out } = await runIosSnapshot([], {
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "" },
    });
    expect(code).toBe(78);
    expect(out).toContain("OMNESIS_EPIC_MACOS_HOST is not set");
    // The fix-it hint names the var but NEVER a concrete host alias — proof the
    // committed default is unset→error, not a personal value.
    expect(out).toMatch(/export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>/);
  }, 30000);

  it("refuses a scratch path that resolves into a CI runner _work clone", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-ios-snap-work-");
    const target = join(sandbox, "actions-runner", "_work", "Omnesis", "Omnesis");
    mkdirSync(target, { recursive: true });
    const { code, out } = await runIosSnapshot([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("CI runner clone");
    // It must refuse BEFORE rsyncing — no transfer line for the up-sync.
    expect(out).not.toMatch(/rsync ios\/ →/);
  }, 30000);

  it("refuses a scratch path marked as the primary checkout (.omnesis-primary sentinel)", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-ios-snap-primary-");
    const target = join(sandbox, "Projects", "Omnesis");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".omnesis-primary"), "");
    const { code, out } = await runIosSnapshot([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("primary checkout");
    expect(out).not.toMatch(/rsync ios\/ →/);
  }, 30000);

  it("commits no operator-private default (no host alias / operator-home absolute path)", () => {
    // The committed script must read the host + paths at runtime; it must not
    // bake in a personal ssh alias or an operator-home absolute path. Comments
    // and the env-var NAME are fine — only literal personal VALUES are banned.
    const src = readFileSync(iosSnapshot, "utf8");
    // No `/Users/<name>/` or `/home/<name>/` absolute path literals.
    expect(src).not.toMatch(/\/Users\/[a-z]/i);
    expect(src).not.toMatch(/\/home\/[a-z]/i);
    // The default scratch path is HOME-relative on the host, never absolute.
    expect(src).toMatch(/OMNESIS_EPIC_MACOS_WORKTREE:-\\\$HOME\/omnesis-ios-snapshot/);
  });

  it("boots the reserved simulator to readiness under the selected full Xcode", () => {
    const src = readFileSync(iosSnapshot, "utf8");
    expect(src).toContain('developer_dir=\\"\\${DEVELOPER_DIR:-\\$(xcode-select -p)}\\"');
    expect(src).toContain("simctl=\\$(xcrun --find simctl)");
    expect(src).toContain('\\"\\$simctl\\" bootstatus \\"$SIMULATOR_SELECTOR\\" -b');
    expect(src).toContain('\\"\\$simctl\\" uninstall \\"$SIMULATOR_SELECTOR\\" \\"$BUNDLE_ID\\"');
  });

  it("keeps build output in removable scratch and clears host PNGs after copying", () => {
    const src = readFileSync(iosSnapshot, "utf8");
    expect(src).toContain('-derivedDataPath \\"$RESOLVED_TARGET/DerivedData\\"');
    expect(src).toContain(
      '\\"$RESOLVED_TARGET/DerivedData/Build/Products/Debug-iphonesimulator\\"',
    );
    const remote = src.match(/ssh "\$HOST" "bash -lc '([\s\S]*?)\n'"/);
    expect(remote).not.toBeNull();
    expect(remote[1]).not.toContain("'");
    const copy = src.indexOf("cp -f /tmp/omnesis-snapshots/*.png");
    const cleanup = src.indexOf("rm -rf /tmp/omnesis-snapshots", copy);
    expect(copy).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(copy);
  });

  it("rejects an unsafe simulator selector before opening ssh", async () => {
    const { code, out } = await runIosSnapshot([], {
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "unused",
        OMNESIS_IOS_SNAPSHOT_DEST: "platform=iOS Simulator,name=device;false",
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("simulator destination contains an unsafe selector");
  });
});

describe("scripts/android-render.sh macOS-host bridge guards (C20)", () => {
  // scripts/android-render.sh bridges the Android Roborazzi screenshot loop to a
  // configured macOS build host over ssh — the Android SDK has no linux-aarch64
  // build, so the suite cannot run on this box. The actual Mac round-trip is
  // exercised manually (it needs the Android toolchain). These are the
  // Linux-runnable, CI-safe NEGATIVE CONTROLS for the script's fail-loud guards;
  // they mirror the C10 ios-snapshot.sh guards and must fire WITHOUT a real Mac.
  //
  //   - unset OMNESIS_EPIC_MACOS_HOST → a clear error + non-zero exit (the
  //     script never falls back to a guessed personal alias).
  //   - a scratch path that resolves into a CI runner `_work` clone → refused.
  //   - a scratch path marked as the primary checkout (.omnesis-primary
  //     sentinel) → refused.
  //
  // The host guards need the script to "ssh" somewhere; we stub `ssh` with a
  // local shim that drops the host arg and runs the remaining command in a
  // local bash, so `printf`/`test`/`mkdir` resolve against a sandbox dir on
  // THIS box. That lets the path-guard logic run end-to-end on Linux.
  const androidRender = join(repoRoot, "scripts/android-render.sh");

  function sshStubPath() {
    const binDir = tmpDir("omnesis-android-render-bin-");
    const sshShim = join(binDir, "ssh");
    // $1 is the host (ignored); the rest is the remote command.
    writeFileSync(sshShim, '#!/usr/bin/env bash\nshift\nexec bash -c "$@"\n', { mode: 0o755 });
    const need = [
      "bash",
      "rsync",
      "dirname",
      "printf",
      "test",
      "mkdir",
      "cat",
      "ls",
      "wc",
      "tr",
      "find",
      "cp",
      "rm",
    ];
    for (const tool of need) {
      const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
        encoding: "utf8",
      }).trim();
      if (real && real.startsWith("/")) symlinkSync(real, join(binDir, tool));
    }
    return binDir;
  }

  function runAndroidRender(args, { extraEnv = {}, path = null, timeout = 20000 }) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...extraEnv };
      if (path) env.PATH = path;
      execFile(
        "bash",
        [androidRender, ...args],
        { cwd: repoRoot, env, timeout },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("fails loud with EX_CONFIG (78) when OMNESIS_EPIC_MACOS_HOST is unset — never a guessed alias", async () => {
    const { code, out } = await runAndroidRender([], {
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "" },
    });
    expect(code).toBe(78);
    expect(out).toContain("OMNESIS_EPIC_MACOS_HOST is not set");
    // The fix-it hint names the var but NEVER a concrete host alias.
    expect(out).toMatch(/export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>/);
  }, 30000);

  it("refuses a scratch path that resolves into a CI runner _work clone", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-android-render-work-");
    const target = join(sandbox, "actions-runner", "_work", "Omnesis", "Omnesis");
    mkdirSync(target, { recursive: true });
    const { code, out } = await runAndroidRender([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_ANDROID_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("CI runner clone");
    // It must refuse BEFORE rsyncing — no transfer line for the up-sync.
    expect(out).not.toMatch(/rsync android\//);
  }, 30000);

  it("refuses a scratch path marked as the primary checkout (.omnesis-primary sentinel)", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-android-render-primary-");
    const target = join(sandbox, "Projects", "Omnesis");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".omnesis-primary"), "");
    const { code, out } = await runAndroidRender([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_ANDROID_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("primary checkout");
    expect(out).not.toMatch(/rsync android\//);
  }, 30000);

  it("rejects an unknown argument loudly (exit 64)", async () => {
    const { code, out } = await runAndroidRender(["--bogus"], {
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "stub" },
    });
    expect(code).toBe(64);
    expect(out).toContain("unknown argument");
  }, 20000);

  it("commits no operator-private default (no host alias / operator-home absolute path)", () => {
    // The committed script must read the host + paths at runtime; it must not
    // bake in a personal ssh alias or an operator-home absolute path. Comments
    // and the env-var NAME are fine — only literal personal VALUES are banned.
    const src = readFileSync(androidRender, "utf8");
    // No `/Users/<name>/` or `/home/<name>/` absolute path literals (the
    // Homebrew JDK default `/opt/homebrew/opt/openjdk@17` is a generic install
    // location, not operator-private).
    expect(src).not.toMatch(/\/Users\/[a-z]/i);
    expect(src).not.toMatch(/\/home\/[a-z]/i);
    // The default scratch + SDK paths are HOME-relative on the host, never absolute.
    expect(src).toMatch(/OMNESIS_EPIC_MACOS_ANDROID_WORKTREE:-\\\$HOME\/omnesis-android-render/);
    expect(src).toMatch(/OMNESIS_ANDROID_SDK_HOME:-\\\$HOME\/Library\/Android\/sdk/);
  });
});

describe("android.yml CI workflow structure (C20)", () => {
  // The full-validation controller calls this lane for every admitted target.
  // Assert the native job remains fixed to that target and fails loudly when
  // its required toolchain or screenshot baseline is unavailable.
  let wf;
  beforeAll(async () => {
    const { parse } = await import("yaml");
    wf = parse(readFileSync(join(repoRoot, ".github/workflows/android.yml"), "utf8"));
  });

  it("renders on the arm64 macOS platform that recorded the goldens, and builds on Linux", () => {
    expect(wf.jobs.render["runs-on"]).toBe("macos-latest");
    expect(wf.jobs["build-and-test"]["runs-on"]).toBe("ubuntu-latest");
    const renderLanes = wf.jobs.render.steps
      .map((s) => s.name)
      .filter((n) => n?.startsWith("lane ["));
    expect(renderLanes).toEqual(["lane [android-render]"]);
  });

  it("is admission-only and validates the caller's exact revision without a path sentinel", () => {
    expect(wf.on.push).toBeUndefined();
    expect(wf.on.schedule).toBeUndefined();
    expect(wf.on.workflow_call.inputs.target_sha).toMatchObject({ required: true, type: "string" });
    expect(wf.on.workflow_dispatch).toBeUndefined();
    expect(wf.jobs.changes).toBeUndefined();
    const checkout = wf.jobs["build-and-test"].steps.find((s) =>
      s.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with).toMatchObject({
      ref: "${{ inputs.target_sha }}",
      "persist-credentials": false,
    });
  });

  it("bounds every Gradle phase without leaving a persistent daemon for the next phase", () => {
    const steps = [...wf.jobs["build-and-test"].steps, ...wf.jobs.render.steps];
    for (const name of ["android-jvm", "android-policy", "android-build", "android-render"]) {
      const step = steps.find((s) => s.name === `lane [${name}]`);
      const commands = step.run
        .replace(/\\\n\s*/gu, " ")
        .trim()
        .split("\n");
      for (const command of commands) {
        const args = command.trim().split(/\s+/u);
        expect(args[0]).toBe("./gradlew");
        expect(args.filter((arg) => arg === "--no-daemon")).toHaveLength(1);
        expect(args.filter((arg) => arg.startsWith("--max-workers"))).toEqual(["--max-workers=2"]);
        expect(args).not.toContain("--daemon");
        expect(args).not.toContain("--stop");
      }
    }
  });

  it.each([undefined, ":app:bundlePlayRelease", ":app:bundleFullRelease"])(
    "builds both release variants in bounded fresh processes and propagates failure (%s)",
    (failedTask) => {
      const dir = tmpDir("omnesis-android-build-workflow-");
      const calls = join(dir, "calls.jsonl");
      writeFileSync(
        join(dir, "gradlew"),
        `#!${process.execPath}\n` +
          'const fs = require("node:fs");\n' +
          'fs.appendFileSync(process.env.GRADLE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
          "if (process.argv.includes(process.env.GRADLE_FAIL_TASK)) process.exit(23);\n",
        { mode: 0o755 },
      );
      const step = wf.jobs["build-and-test"].steps.find((s) => s.name === "lane [android-build]");
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run],
        {
          cwd: dir,
          env: { ...process.env, GRADLE_CALLS: calls, GRADLE_FAIL_TASK: failedTask ?? "" },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(failedTask ? 23 : 0);
      const expected = [
        [":app:bundlePlayRelease", "--no-daemon", "--max-workers=2"],
        [":app:bundleFullRelease", "--no-daemon", "--max-workers=2"],
      ];
      expect(
        readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(failedTask === ":app:bundlePlayRelease" ? expected.slice(0, 1) : expected);
    },
  );

  it("runs the Roborazzi VERIFY task (compare against tracked goldens), not record", () => {
    const steps = [...wf.jobs["build-and-test"].steps, ...wf.jobs.render.steps];
    const runs = steps.map((s) => s.run || "").join("\n");
    expect(runs).toContain("verifyRoborazziPlayDebug");
    // CI must NEVER record — recording would rewrite the baseline and catch no drift.
    expect(runs).not.toContain("recordRoborazziDebug");
    // Both modules with screenshot tests are verified.
    expect(runs).toContain(":app:verifyRoborazziPlayDebug");
    expect(runs).toContain(":feature-health:verifyRoborazziDebug");
    // The unit-test lane runs too.
    expect(runs).toContain(":app:testPlayDebugUnitTest");
    expect(runs).toContain(":app:testFullDebugUnitTest");
    expect(runs).toContain(":app:verifyPlayReleasePolicy");
  });

  it("fails loud (never skips) when the Android toolchain is unreachable", () => {
    for (const job of ["build-and-test", "render"]) {
      const verify = wf.jobs[job].steps.find((s) => /toolchain/i.test(s.name || ""));
      expect(verify, `android.yml ${job} has no toolchain-verify step`).toBeTruthy();
      // The step exits non-zero on a missing JDK/SDK — a required dependency, no skip.
      expect(verify.run).toMatch(/exit 1/);
      expect(verify.run).toMatch(/required dependency/i);
    }
  });

  it("the tracked golden dir is committed and not gitignored", () => {
    // verifyRoborazziDebug needs a committed baseline; the capture filePath must
    // point at a tracked (non-build) dir. Assert the helpers write there and the
    // dir is not swept up by android/.gitignore's build-output ignores.
    const ignore = readFileSync(join(repoRoot, "android/.gitignore"), "utf8");
    // The transient compare artifacts ARE ignored.
    expect(ignore).toMatch(/roborazzi-compare/);
    // git itself confirms whether a path is ignored (the prose comment in
    // .gitignore mentions the dir name, so a substring check would false-fail —
    // ask git directly). `git check-ignore -q` exits 0 when the path IS ignored.
    const isGitIgnored = (rel) => {
      try {
        execFileSync("git", ["check-ignore", "-q", rel], { cwd: repoRoot });
        return true;
      } catch {
        return false;
      }
    };
    // The tracked golden dir must NOT be ignored (else verifyRoborazziDebug has
    // no committed baseline); a build-dir golden, by contrast, MUST be ignored.
    const goldenPath = "android/app/src/test/roborazzi/example_golden.png";
    expect(
      isGitIgnored(goldenPath),
      `${goldenPath} is gitignored — verifyRoborazziDebug would have no committed baseline`,
    ).toBe(false);
    expect(isGitIgnored("android/app/build/outputs/roborazzi/x.png")).toBe(true);
    // At least one screenshot test writes to the tracked path.
    const screensTest = readFileSync(
      join(
        repoRoot,
        "android/app/src/test/kotlin/dev/omnesis/android/screenshots/ScreensScreenshotTest.kt",
      ),
      "utf8",
    );
    expect(screensTest).toMatch(/filePath = "src\/test\/roborazzi\//);
  });
});

describe("release.yml verification permissions", () => {
  it("can read the full-validation evidence that gates a release tag", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));

    expect(workflow.permissions).toMatchObject({ actions: "read", contents: "read" });
    const ancestry = workflow.jobs.verify.steps.find(
      (step) => step.name === "The tagged commit is on main",
    );
    expect(ancestry.env.REPOSITORY_TOKEN).toBe("${{ github.token }}");
    expect(ancestry.run).toContain("extraheader=$auth_header");
    const verdict = workflow.jobs.verify.steps.find(
      (step) => step.name === "Full validation passed at the tagged commit",
    );
    expect(verdict.env.TARGET_SHA).toBe("${{ steps.version.outputs.sha }}");
    expect(verdict.run).toContain("actions/workflows/full-validation.yml/runs?head_sha=");
    expect(verdict.run).toContain('node scripts/release/ci-verdict.mjs "$TARGET_SHA"');
  });

  it("pins every downstream build and release to the verified tag commit", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
    for (const jobName of ["packages", "images", "github-release"]) {
      const steps = workflow.jobs[jobName].steps;
      const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toMatchObject({
        ref: "${{ needs.verify.outputs.sha }}",
        "persist-credentials": false,
      });
      expect(steps.find((step) => step.name === "Verify fixed release revision")?.run).toContain(
        'test "$(git rev-parse HEAD)" = "$TARGET_SHA"',
      );
    }
    const publish = workflow.jobs["github-release"].steps.find(
      (step) => step.name === "Create the GitHub Release",
    );
    expect(publish.run).toContain('--target "${{ needs.verify.outputs.sha }}"');
    expect(publish.run).toContain("--verify-tag");
  });

  it("binds tag pushes to the immutable event SHA and re-attests the remote tag before publishing", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
    const version = workflow.jobs.verify.steps.find((step) => step.id === "version");
    expect(version.run).toContain('target_sha=$(git rev-parse "$GITHUB_SHA^{commit}")');
    expect(version.run).toContain('[ "$tag_sha" = "$target_sha" ]');

    for (const [jobName, publishName, armedIf] of [
      [
        "packages",
        "Publish to configured registry",
        "needs.verify.outputs.armed == 'true' && vars.OMNESIS_RELEASE_REGISTRY != ''",
      ],
      [
        "packages",
        "Publish to npmjs with provenance",
        "needs.verify.outputs.armed == 'true' && vars.OMNESIS_RELEASE_REGISTRY == ''",
      ],
      [
        "images",
        "Build ${{ needs.verify.outputs.armed == 'true' && 'and push' || '(no push — not armed)' }}",
        "needs.verify.outputs.armed == 'true'",
      ],
    ]) {
      const steps = workflow.jobs[jobName].steps;
      const publishIndex = steps.findIndex((step) => step.name === publishName);
      expect(publishIndex).toBeGreaterThan(0);
      const reattest = steps[publishIndex - 1];
      expect(reattest.name).toMatch(/^Re-attest remote tag before /u);
      expect(reattest.env.REPOSITORY_TOKEN).toBe("${{ github.token }}");
      expect(reattest.run).toContain("extraheader=$auth_header");
      expect(reattest.run).toContain('ls-remote --tags origin "refs/tags/$RELEASE_TAG^{}"');
      expect(reattest.run).toContain('[ "$remote_sha" = "$TARGET_SHA" ]');
      expect(reattest.if).toBe(armedIf);
    }

    const githubRelease = workflow.jobs["github-release"].steps.find(
      (step) => step.name === "Create the GitHub Release",
    );
    expect(githubRelease.env.REPOSITORY_TOKEN).toBe("${{ github.token }}");
    expect(githubRelease.run).toContain("extraheader=$auth_header");
    expect(githubRelease.run.indexOf("ls-remote --tags origin")).toBeLessThan(
      githubRelease.run.indexOf("gh release create"),
    );
    expect(githubRelease.run).toContain('[ "$remote_sha" = "${{ needs.verify.outputs.sha }}" ]');
  });

  it("keeps publication arming independent from the package destination", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));
    const packageSteps = workflow.jobs.packages.steps;
    const setupNodeSteps = packageSteps.filter((step) =>
      step.uses?.startsWith("actions/setup-node"),
    );
    const dependencySetup = setupNodeSteps.find((step) => step.name === undefined);
    const publicationSetup = setupNodeSteps.find(
      (step) => step.name === "Configure the publication registry",
    );
    const registryValidation = packageSteps.find(
      (step) => step.name === "Validate the publication registry",
    );
    const configured = packageSteps.find((step) => step.name === "Publish to configured registry");
    const npmjs = packageSteps.find((step) => step.name === "Publish to npmjs with provenance");
    const dryRun = packageSteps.find((step) => step.name === "Publication dry run (not armed)");

    expect(workflow.env.ARMED).toBe("${{ vars.OMNESIS_RELEASE_PUBLISH == '1' }}");
    expect(workflow.jobs.verify.outputs.armed).toBe("${{ vars.OMNESIS_RELEASE_PUBLISH == '1' }}");
    expect(workflow.env.PACKAGE_REGISTRY).toBe(
      "${{ vars.OMNESIS_RELEASE_REGISTRY || 'https://registry.npmjs.org' }}",
    );
    expect(dependencySetup.with["registry-url"]).toBeUndefined();
    expect(registryValidation.if).toBe("needs.verify.outputs.armed == 'true'");
    expect(registryValidation.run).toContain('url.hostname === "localhost"');
    expect(registryValidation.run).toContain('url.hostname === "127.0.0.1"');
    expect(registryValidation.run).toContain('url.hostname === "[::1]"');
    expect(registryValidation.run).toContain('url.protocol !== "https:"');
    expect(registryValidation.run).toContain('url.protocol === "http:" && loopback');
    expect(registryValidation.run).toContain("url.username || url.password");
    expect(registryValidation.run).toContain("control characters");
    expect(publicationSetup.if).toBe("needs.verify.outputs.armed == 'true'");
    expect(publicationSetup.with["registry-url"]).toBe("${{ env.PACKAGE_REGISTRY }}");
    expect(configured.if).toBe(
      "needs.verify.outputs.armed == 'true' && vars.OMNESIS_RELEASE_REGISTRY != ''",
    );
    expect(configured.env).toEqual({
      NODE_AUTH_TOKEN: "${{ secrets.OMNESIS_RELEASE_REGISTRY_TOKEN }}",
    });
    expect(configured.run).toContain('[ -n "$NODE_AUTH_TOKEN" ]');
    expect(configured.run).toContain('--registry "$PACKAGE_REGISTRY"');
    expect(npmjs.if).toBe(
      "needs.verify.outputs.armed == 'true' && vars.OMNESIS_RELEASE_REGISTRY == ''",
    );
    expect(npmjs.env).toEqual({
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
      OMNESIS_ALLOW_PUBLIC_NPM_PUBLISH: "1",
      NPM_CONFIG_PROVENANCE: "true",
    });
    expect(dryRun.if).toBe("needs.verify.outputs.armed != 'true'");
  });
});

describe("full-validation workflow topology", () => {
  const validationNames = [
    "ci",
    "knip",
    "ios",
    "android",
    "swiftlint",
    "docker-smoke",
    "install-smoke",
    "topology-e2e",
    "harness-conformance",
    "docker-e2e",
    "security-static",
    "docker",
  ];
  let workflows;

  beforeAll(async () => {
    const { parse } = await import("yaml");
    const names = [...validationNames, "full-validation"];
    workflows = Object.fromEntries(
      names.map((name) => [
        name,
        parse(readFileSync(join(repoRoot, `.github/workflows/${name}.yml`), "utf8")),
      ]),
    );
  });

  it.each(validationNames)("%s is reusable at one required target SHA", (name) => {
    const workflow = workflows[name];
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.schedule).toBeUndefined();
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.workflow_call.inputs.target_sha).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.concurrency).toBeUndefined();
  });

  it("pins every target checkout and verifies its resolved revision", () => {
    for (const name of validationNames) {
      const workflow = workflows[name];
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!job.steps) continue;
        const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
        for (const checkout of checkouts) {
          expect(checkout.uses, `${name}:${jobName} has an unpinned checkout`).toMatch(
            /^actions\/checkout@[0-9a-f]{40}$/u,
          );
          expect(
            checkout.with,
            `${name}:${jobName} does not pin the requested source`,
          ).toMatchObject({
            ref: "${{ inputs.target_sha }}",
            "persist-credentials": false,
          });
        }
        if (checkouts.length) {
          const verify = job.steps.find((step) => step.name === "Verify fixed source revision");
          expect(verify?.run, `${name}:${jobName} does not verify checkout HEAD`).toContain(
            'test "$(git rev-parse HEAD)" = "$TARGET_SHA"',
          );
        }
      }
    }
  });

  it("builds each image platform natively on a runner of its own architecture", () => {
    const job = workflows.docker.jobs["build-and-smoke"];
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    expect(job.strategy.matrix.include).toEqual([
      { platform: "linux/amd64", runner: "ubuntu-latest" },
      { platform: "linux/arm64", runner: "ubuntu-24.04-arm" },
    ]);
    expect(job.steps.some((step) => step.uses?.startsWith("docker/setup-qemu-action@"))).toBe(
      false,
    );
  });

  it("gives an emulated gateway the full bounded health window", () => {
    const wait = workflows.docker.jobs["build-and-smoke"].steps.find(
      (step) => step.name === "Wait for gateway health",
    );
    expect(wait.run).toContain("for i in $(seq 1 60)");
    expect(wait.run).toContain('if [ "$state" = "healthy" ]; then exit 0; fi');
    expect(wait.run).not.toContain('if [ "$state" = "unhealthy" ]; then');
    expect(wait.run).toContain("Gateway did not become healthy in 120s. Logs:");
    expect(wait.run).toContain("docker logs omnesis-ci-gateway");
  });

  it("checks the current search engine during Docker boot", () => {
    const probe = workflows.docker.jobs["build-and-smoke"].steps.find(
      (step) => step.name === "Confirm search index + workers up",
    );
    const writerSource = readFileSync(
      join(repoRoot, "packages/gateway/src/workers/writer-worker.ts"),
      "utf8",
    );
    const gatewaySource = readFileSync(join(repoRoot, "packages/gateway/src/index.ts"), "utf8");
    const searchReadyMarker = "HNSW read handle opened";
    const writerReadyMarker = "ready — owning writable handle";
    expect(gatewaySource).toContain(searchReadyMarker);
    expect(probe.run).toContain(`grep -q "${searchReadyMarker}"`);
    expect(writerSource).toContain(writerReadyMarker);
    expect(probe.run).toContain(`grep -q "${writerReadyMarker}"`);
    expect(probe.run).not.toContain("sqlite-vec");
  });

  it("reads the paginated device contract in the Docker auth probe", () => {
    const probe = workflows.docker.jobs["build-and-smoke"].steps.find(
      (step) => step.name === "Issue + revoke a token via HTTP (smoke test for /admin/tokens)",
    );
    expect(probe.run).toContain("json.load(sys.stdin)['items']");
    expect(probe.run).not.toContain("json.load(sys.stdin)['devices']");
  });

  describe("lane scope on pull requests", () => {
    // Each gated lane job and the scope switch that runs it (scripts/nx/ci-scope.mjs).
    const switches = {
      knip: "knip",
      swift: "apple",
      ios: "apple",
      android: "android",
      "docker-smoke": "docker_smoke",
      "install-smoke": "install_smoke",
      topology: "topology",
      harness: "harness",
      "docker-security": "docker_security",
      "docker-image": "docker_image",
      "security-static": "security_static",
    };

    it("gates every lane job on its scope switch and passes the Node selection to ci.yml", async () => {
      const { LANES } = await import("./nx/ci-scope.mjs");
      const jobs = workflows["full-validation"].jobs;
      for (const [job, key] of Object.entries(switches)) {
        expect(jobs[job].needs, job).toBe("scope");
        expect(jobs[job].if, job).toBe(`\${{ needs.scope.outputs.${key} == 'true' }}`);
      }
      const gatedHere = new Set(Object.values(switches));
      const node = jobs.node.with;
      expect(node).toMatchObject({
        scope: "${{ needs.scope.outputs.scope }}",
        projects: "${{ needs.scope.outputs.projects }}",
        changed_files: "${{ needs.scope.outputs.changed_files }}",
        e2e_matrix: "${{ needs.scope.outputs.e2e_matrix }}",
        run_unit: "${{ needs.scope.outputs.unit == 'true' }}",
        run_portal: "${{ needs.scope.outputs.portal == 'true' }}",
        run_embedder: "${{ needs.scope.outputs.embedder == 'true' }}",
        run_macos: "${{ needs.scope.outputs.node_macos == 'true' }}",
      });
      expect(jobs.android.with.run_render).toBe(
        "${{ needs.scope.outputs.android_render == 'true' }}",
      );
      // Every switch the planner emits is consumed by a job, and every one is a job output.
      const consumed = new Set([
        ...gatedHere,
        "unit",
        "portal",
        "embedder",
        "node_macos",
        "android_render",
      ]);
      expect([...consumed].sort()).toEqual([...LANES].sort());
      for (const key of [...LANES, "scope", "projects", "changed_files", "e2e_matrix"])
        expect(jobs.scope.outputs[key], key).toBe(`\${{ steps.scope.outputs.${key} }}`);
      expect(jobs.scope.steps.find((step) => step.id === "scope").run).toBe(
        "node scripts/nx/ci-scope.mjs",
      );
      const checkout = jobs.scope.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout.with).toMatchObject({ ref: "${{ github.sha }}", "fetch-depth": 2 });
    });

    it("gates the ci.yml jobs and steps on the scope inputs", () => {
      const ci = workflows.ci;
      expect(ci.on.workflow_call.inputs.scope.default).toBe("full");
      expect(ci.jobs.unit.if).toBe("${{ inputs.run_unit }}");
      expect(ci.jobs["portal-e2e"].if).toBe("${{ inputs.run_portal }}");
      expect(ci.jobs["e2e-embedder"].if).toBe("${{ inputs.run_embedder }}");
      expect(ci.jobs["node-macos"].if).toBe("${{ inputs.run_macos }}");
      expect(ci.jobs.e2e.if).toBe("${{ inputs.e2e_matrix != '[]' }}");
      expect(ci.jobs.e2e.strategy.matrix.include).toBe("${{ fromJSON(inputs.e2e_matrix) }}");
      expect(workflows.android.jobs.render.if).toBe("${{ inputs.run_render }}");
      const step = (job, name) => ci.jobs[job].steps.find((s) => s.name === name);
      for (const name of ["lane [production-audit]", "lane [linux-lint]", "lane [format]"])
        expect(step("node", name).if, name).toBe("${{ inputs.scope == 'full' }}");
      for (const name of ["lane [linux-typecheck]", "lane [suite-typecheck]"])
        expect(step("node", name).if, name).toBe(
          "${{ inputs.scope == 'full' || inputs.projects == 'all' }}",
        );
      expect(step("unit", "lane [linux-unit]").if).toBe(
        "${{ inputs.scope == 'full' || inputs.projects == 'all' }}",
      );
      expect(step("node", "lane [changed-format-lint]").run).toBe(
        "exec node scripts/nx/ci-scope.mjs static",
      );
      expect(step("unit", "lane [affected-unit]").run).toContain(
        'npx nx run-many --targets=nx-unit --projects="$PROJECTS"',
      );
      // The privacy scan and the cheap validators stay unconditional.
      expect(ci.jobs.privacy.if).toBeUndefined();
      for (const name of ["lane [universe-validation]", "lane [parity-validation]"])
        expect(step("node", name).if, name).toBeUndefined();
    });

    it("lets the verdict accept a skip only for a lane the pull request scoped out", () => {
      const run = workflows["full-validation"].jobs.verdict.steps[0].run;
      expect(run).toContain('result === "skipped" && scopedOut(id)');
      expect(run).toContain('const pr = process.env.EVENT === "pull_request";');
      for (const [job, key] of Object.entries(switches))
        expect(run).toContain(`${/^[a-z]+$/u.test(job) ? job : `"${job}"`}: "${key}"`);
      expect(run).toContain('results.scope.outputs[switches[id]] === "false"');
    });
  });

  it("keeps live gateway tests out of the standalone iOS unit lane", () => {
    const unit = workflows.ios.jobs["build-and-test"].steps.find(
      (step) => step.name === "lane [ios-test]",
    );
    const live = workflows.ios.jobs["live-gateway-e2e"].steps.find(
      (step) => step.name === "lane [ios-live-e2e]",
    );
    expect(unit.run).toContain("-skip-testing:OmnesisTests/GatewayLiveE2ETests");
    expect(live.run).toContain("scripts/run-ios-e2e.sh");
  });

  it("retains iOS preview artifacts only for failed runs", () => {
    const upload = workflows.ios.jobs["build-and-test"].steps.find(
      (step) => step.name === "Upload preview snapshots",
    );
    expect(upload.if).toBe("failure()");
    expect(upload["continue-on-error"]).toBe(true);
    expect(upload.with).toMatchObject({
      name: "preview-snapshots",
      "if-no-files-found": "ignore",
      "retention-days": 7,
    });
  });

  it("pins the private-repository static security scanner and rules", () => {
    const steps = workflows["security-static"].jobs.analyze.steps;
    const rules = steps.find((step) => step.name === "Fetch pinned static-analysis rules");
    const scan = steps.find((step) => step.name === "lane [security-static]");
    expect(rules.env.RULES_COMMIT).toMatch(/^[0-9a-f]{40}$/u);
    expect(rules.run).toContain('test "$(git -C "$checkout" rev-parse HEAD)" = "$RULES_COMMIT"');
    expect(rules.run).toContain("scripts/security/semgrep-typescript-rules.txt");
    const listed = readFileSync(
      join(repoRoot, "scripts/security/semgrep-typescript-rules.txt"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    expect(listed.length).toBeGreaterThan(0);
    for (const file of listed) expect(file).toMatch(/^[\w./-]+\.ya?ml$/u);
    expect(scan.run).toContain(
      "semgrep/semgrep@sha256:65dcd4408adda7c183a6b4550cb1e9b19f7f627a6fbb7e0559bd466bedc44d7b",
    );
    expect(scan.run).toContain("--error");
    expect(scan.run).toContain("SEMGREP_SEND_METRICS=off");
  });

  it("runs the full suite on every push to main and every pull request into it", () => {
    const workflow = workflows["full-validation"];
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.pull_request).toEqual({ branches: ["main"] });
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency.group).toContain("github.ref");
    expect(workflow.concurrency.group).not.toContain("run_id");
    expect(workflow.permissions).toEqual({ contents: "read" });
    const called = Object.values(workflow.jobs)
      .map((job) => job.uses)
      .filter(Boolean);
    for (const name of validationNames) {
      expect(called).toContain(`./.github/workflows/${name}.yml`);
    }
    for (const job of Object.values(workflow.jobs)) {
      if (job.uses) expect(job.with.target_sha).toBe("${{ github.sha }}");
    }
    expect(workflow.jobs.verdict.if).toContain("!cancelled()");
    expect([...workflow.jobs.verdict.needs].sort()).toEqual(
      Object.keys(workflow.jobs)
        .filter((name) => name !== "verdict")
        .sort(),
    );
  });

  it("gives pull-request code no secret", async () => {
    const { parse } = await import("yaml");
    const workflowDir = join(repoRoot, ".github/workflows");
    for (const name of ["full-validation", ...validationNames]) {
      const source = readFileSync(join(workflowDir, `${name}.yml`), "utf8");
      expect(source, `${name}.yml reads a secret`).not.toMatch(/\bsecrets\.[A-Za-z_]/u);
    }
    for (const filename of readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
      const workflow = parse(readFileSync(join(workflowDir, filename), "utf8"));
      if (!workflow.on?.pull_request_target) continue;
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const checkouts = (job.steps ?? []).filter((step) =>
          step.uses?.startsWith("actions/checkout@"),
        );
        expect(checkouts, `${filename}:${jobName} checks out pull_request_target code`).toEqual([]);
      }
    }
  });

  it("badges only finished runs of main", async () => {
    const { parse } = await import("yaml");
    const status = parse(readFileSync(join(repoRoot, ".github/workflows/ci-status.yml"), "utf8"));
    expect(status.on).toEqual({
      workflow_run: { workflows: ["full-validation"], types: ["completed"] },
    });
    expect(status.permissions).toEqual({ actions: "read" });
    const steps = status.jobs["main-verdict"].steps;
    expect(steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    const run = steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("branch=main&event=push&status=completed");
    expect(run).toContain('.conclusion != "cancelled"');
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("actions/workflows/ci-status.yml/badge.svg?branch=main");
  });

  it("auto-merges only a validated Dependabot patch update, pinned to its head", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(
      readFileSync(join(repoRoot, ".github/workflows/dependabot-auto-merge.yml"), "utf8"),
    );
    expect(workflow.on).toEqual({
      workflow_run: { workflows: ["full-validation"], types: ["completed"] },
    });
    const job = workflow.jobs["auto-merge"];
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request'");
    const run = job.steps.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("version-update:semver-patch");
    expect(run).toContain('--match-head-commit "$HEAD_SHA"');
    expect(job.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
  });

  it("executes every workflow check owner directly", async () => {
    const { parse } = await import("yaml");
    const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
    const workflowDir = join(repoRoot, ".github/workflows");
    for (const filename of readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
      const workflow = parse(readFileSync(join(workflowDir, filename), "utf8"));
      expect(workflowCheckOwnershipErrors(workflow, scripts, filename)).toEqual([]);
    }
  });

  it("rejects direct, exec-prefixed, indirect, and non-exec scheduler owners", () => {
    const scripts = {
      typecheck: "node scripts/run-check.mjs typecheck",
      test: "npm run typecheck",
      unrelated: "node harmless.mjs",
    };
    const workflow = (run) => ({ jobs: { check: { steps: [{ name: "Check", run }] } } });
    for (const command of [
      "npm run typecheck",
      "exec npm run typecheck",
      "npm run test",
      "node scripts/run-check.mjs typecheck",
    ]) {
      expect(workflowCheckOwnershipErrors(workflow(command), scripts)).toHaveLength(1);
    }
    expect(
      workflowCheckOwnershipErrors(
        workflow("exec node scripts/run-check.mjs typecheck\nnpm run unrelated"),
        scripts,
      ),
    ).toEqual([]);
  });

  it("keeps source-install state isolated without discarding the runner npm cache", () => {
    const steps = workflows["install-smoke"].jobs.source.steps;
    const fixture = steps.find((step) => step.name === "Create exact-revision source remote");
    const install = steps.find((step) => step.name === "lane [install-source]");
    const cleanup = steps.find((step) => step.name === "Cleanup");
    expect(fixture.run).toContain('git init --bare "$SOURCE_REMOTE"');
    expect(fixture.run).toContain(
      'git --git-dir="$SOURCE_REMOTE" fetch --update-shallow --no-tags',
    );
    expect(fixture.run).toContain('"$GITHUB_WORKSPACE"');
    expect(fixture.run).toContain('"$TARGET_SHA:refs/heads/main"');
    expect(fixture.run).not.toContain("git push");
    expect(fixture.run).not.toContain("--no-verify");
    expect(steps.indexOf(fixture)).toBeLessThan(steps.indexOf(install));
    expect(install.run).toContain('OMNESIS_REPO_URL="file://$SOURCE_REMOTE"');
    expect(install.run).not.toContain('OMNESIS_REPO_URL="file://$GITHUB_WORKSPACE"');
    expect(cleanup.run).toContain('"$SOURCE_REMOTE"');
    const cacheCapture = install.run.indexOf('RUNNER_NPM_CACHE="$(npm config get cache)"');
    const isolatedInstall = install.run.indexOf(
      'HOME="$TEST_HOME" NPM_CONFIG_CACHE="$RUNNER_NPM_CACHE"',
    );
    expect(cacheCapture).toBeGreaterThanOrEqual(0);
    expect(isolatedInstall).toBeGreaterThan(cacheCapture);
  });

  it("keeps the gateway-booting lanes off the macOS runner", () => {
    const steps = workflows.ci.jobs["node-macos"].steps;
    const ran = steps.map((step) => step.run ?? "").join("\n");
    expect(ran).not.toMatch(/npm run test:unit(\s|$)/u);
    expect(ran).toContain("exec node scripts/run-check.mjs unit");
    expect(ran).toContain("python3 -B packages/agent-integration/hermes/test_adapter.py");
    const onLinux = workflows.ci.jobs.unit.steps.map((step) => step.run ?? "").join("\n");
    expect(onLinux).toContain("exec node scripts/run-check.mjs unit-all");
  });

  it("shards the spawned-gateway suite and gives the embedder suites their server", () => {
    const e2e = workflows.ci.jobs.e2e;
    const shards = JSON.parse(workflows.ci.on.workflow_call.inputs.e2e_matrix.default);
    const lane = e2e.steps.find((step) => step.name === "lane [linux-e2e]").run;
    expect(lane).toContain('--shard="$SHARD/$TOTAL"');
    expect(lane).toContain("export OMNESIS_E2E_WORKERS=1");
    expect(lane).toContain('exec node scripts/run-check.mjs e2e "${files[@]}"');
    expect(shards).toEqual(
      shards.map((_, index) => ({ shard: index + 1, total: shards.length, files: "" })),
    );
    expect(shards).toHaveLength(8);

    const embedderSuites = [
      "packages/collector/src/e2e/search-quality.e2e.test.ts",
      "packages/collector/src/e2e/embedder-swap.e2e.test.ts",
    ];
    const embedder = workflows.ci.jobs["e2e-embedder"].steps;
    const start = embedder.findIndex((step) => step.run === "scripts/test-embedder.sh start");
    const run = embedder.findIndex((step) => step.name === "lane [embedder-e2e]");
    expect(start).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(start);
    for (const suite of embedderSuites) {
      expect(lane).toContain(`--exclude=${suite}`);
      expect(embedder[run].run).toContain(suite);
    }
  });

  it("runs every job of every workflow on a GitHub-hosted runner", async () => {
    const { parse } = await import("yaml");
    const workflowDir = join(repoRoot, ".github/workflows");
    const hosted = /^(ubuntu|macos|windows)-[\w.-]+$/u;
    for (const filename of readdirSync(workflowDir).filter((name) => name.endsWith(".yml"))) {
      const workflow = parse(readFileSync(join(workflowDir, filename), "utf8"));
      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        if (job.uses) continue;
        const runsOn = job["runs-on"];
        // A matrix-chosen runner is checked through every value the matrix offers.
        const key = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/u.exec(runsOn ?? "")?.[1];
        const labels = key
          ? [
              ...(job.strategy?.matrix?.[key] ?? []),
              ...(job.strategy?.matrix?.include ?? []).map((entry) => entry[key]),
            ]
          : [runsOn];
        expect(labels.length, `${filename}:${jobName}`).toBeGreaterThan(0);
        for (const label of labels) expect(label, `${filename}:${jobName}`).toMatch(hosted);
      }
    }
  });
});

describe("container topology device-version convergence", () => {
  const helper = readFileSync(join(repoRoot, "scripts/docker-topology/lib.sh"), "utf8");
  const directUpdate = readFileSync(
    join(repoRoot, "scripts/docker-topology/scenarios/03-update-across-tags.sh"),
    "utf8",
  );
  const fleetUpdate = readFileSync(
    join(repoRoot, "scripts/docker-topology/scenarios/05-fleet-update.sh"),
    "utf8",
  );

  it("waits for the gateway inventory cache after both collector restart paths", () => {
    expect(helper).toContain("wait_device_version() {");
    expect(helper).toContain("SECONDS + ${3:-60}");
    expect(helper).toContain("sleep 2");
    expect(directUpdate).toContain("wait_device_version collector 9.9.1");
    expect(fleetUpdate).toContain("wait_device_version collector 9.9.2");
  });
});

describe("external-harness conformance workflow", () => {
  let workflow;
  let source;
  let packageLock;
  let integrationPackage;

  beforeAll(async () => {
    const { parse } = await import("yaml");
    source = readFileSync(join(repoRoot, ".github/workflows/harness-conformance.yml"), "utf8");
    workflow = parse(source);
    packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
    integrationPackage = JSON.parse(
      readFileSync(join(repoRoot, "packages/agent-integration/package.json"), "utf8"),
    );
  });

  it("is admission-only and keeps two separately visible real-harness lanes", () => {
    expect(workflow.on.schedule).toBeUndefined();
    expect(workflow.on.workflow_call.inputs.target_sha).toMatchObject({
      required: true,
      type: "string",
    });
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toBeUndefined();

    const job = workflow.jobs.conformance;
    expect(job.if).toBeUndefined();
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.strategy["fail-fast"]).toBe(false);
    expect(job.strategy.matrix.harness).toEqual(["openclaw", "hermes"]);
    expect(job.name).toBe("${{ matrix.harness }}");
    expect(job["timeout-minutes"]).toBe(90);
  });

  it("pins both upstream harnesses and installs Hermes from its locked exact commit", () => {
    expect(integrationPackage.devDependencies.openclaw).toBe("2026.9.2");
    expect(packageLock.packages["node_modules/openclaw"].version).toBe("2026.9.2");
    expect(workflow.env.HERMES_REPOSITORY).toBe("https://github.com/NousResearch/hermes-agent.git");
    expect(workflow.env.HERMES_COMMIT).toMatch(/^[0-9a-f]{40}$/u);

    const steps = workflow.jobs.conformance.steps;
    const checkout = steps.find((step) => step.name === "Check out pinned Hermes");
    const install = steps.find((step) => step.name === "Install pinned Hermes environment");
    const setupUv = steps.find((step) => step.name === "Set up uv");
    expect(checkout.if).toBe("matrix.harness == 'hermes'");
    expect(checkout.run).toContain("for attempt in 1 2 3; do");
    expect(checkout.run).toContain('fetch --quiet --depth 1 origin "$HERMES_COMMIT"');
    expect(checkout.run).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(checkout.run).toContain('sleep "$((attempt * 15))"');
    expect(checkout.run).toContain('rev-parse HEAD)" = "$HERMES_COMMIT"');
    expect(setupUv.uses).toMatch(/^astral-sh\/setup-uv@[0-9a-f]{40}$/u);
    expect(setupUv.with).toMatchObject({ version: "0.9.28", "enable-cache": false });
    expect(install.run).toContain("uv sync");
    expect(install.run).toContain("--locked --no-dev --python 3.12");
  });

  it("runs only the focused real-connect loader test with no model secret", () => {
    const job = workflow.jobs.conformance;
    const run = job.steps.find((step) => step.name === "lane [harness-${{ matrix.harness }}]");
    expect(run.run.trim()).toBe(
      [
        'test -n "$HARNESS_ROOT"',
        'export OMNESIS_HARNESS_TMPDIR="$HARNESS_ROOT/tmp"',
        "exec node scripts/run-check.mjs e2e packages/collector/src/e2e/harness-plugin-conformance.e2e.test.ts",
      ].join("\n"),
    );
    expect(run.env.OMNESIS_HARNESS_CONFORMANCE).toBe("${{ matrix.harness }}");
    expect(run.env.OMNESIS_HARNESS_TMPDIR).toBeUndefined();
    expect(run.env.TMPDIR).toBeUndefined();
    expect(job["timeout-minutes"] * 60_000).toBeGreaterThan(
      Number(run.env.OMNESIS_E2E_LOCK_TIMEOUT_MS) + 10 * 60_000,
    );
    expect(source).not.toMatch(/secrets\.|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY/u);
    expect(source).not.toMatch(/cache:\s*npm/u);
    expect(source).toContain("enable-cache: false");
  });

  it("pins every JavaScript action and guards temporary cleanup", () => {
    for (const step of workflow.jobs.conformance.steps) {
      if (!step.uses) continue;
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    }
    const repositoryCheckout = workflow.jobs.conformance.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(repositoryCheckout.with["persist-credentials"]).toBe(false);
    const cleanup = workflow.jobs.conformance.steps.find(
      (step) => step.name === "Clean up pinned harness",
    );
    const prepare = workflow.jobs.conformance.steps.find(
      (step) => step.name === "Prepare isolated harness scratch",
    );
    expect(workflow.jobs.conformance.env?.HARNESS_ROOT).toBeUndefined();
    expect(workflow.jobs.conformance.env?.HARNESS_ROOT_ID).toBeUndefined();
    expect(prepare.env.HARNESS_NAME).toBe("${{ matrix.harness }}");
    expect(prepare.run).toContain('harness_key="${HARNESS_NAME:0:1}"');
    expect(prepare.run).toContain("umask 077");
    expect(prepare.run).toContain(
      'harness_root="$(mktemp -d "/tmp/oh-${GITHUB_RUN_ID}-${harness_key}.XXXXXX")"',
    );
    expect(prepare.run).toContain('harness_root_id="$(stat -c \'%d:%i\' -- "$harness_root")"');
    expect(prepare.run).toContain('echo "HARNESS_ROOT=$harness_root" >> "$GITHUB_ENV"');
    expect(prepare.run).toContain('echo "HARNESS_ROOT_ID=$harness_root_id" >> "$GITHUB_ENV"');
    expect(prepare.run).toContain('mkdir "$harness_root/tmp"');
    const longestTsxSocket =
      `/tmp/oh-${"9".repeat(20)}-o.xxxxxx/tmp/omnesis-openclaw-conformance-xxxxxx` +
      `/tmp/tsx-1000/${"9".repeat(7)}.pipe`;
    expect(Buffer.byteLength(longestTsxSocket)).toBeLessThan(108);
    expect(cleanup.if).toBe("always()");
    expect(cleanup.env.HARNESS_NAME).toBe("${{ matrix.harness }}");
    expect(cleanup.run).toContain('harness_key="${HARNESS_NAME:0:1}"');
    expect(cleanup.run).toContain('[[ -z "${HARNESS_ROOT:-}" || -z "${HARNESS_ROOT_ID:-}" ]]');
    expect(cleanup.run).toContain("/tmp/oh-${GITHUB_RUN_ID}-${harness_key}.??????");
    expect(cleanup.run).toContain(
      'quarantine_parent="$(mktemp -d "/tmp/oh-clean-${GITHUB_RUN_ID}-${harness_key}.XXXXXX")"',
    );
    expect(cleanup.run).toContain('mv -T -- "$HARNESS_ROOT" "$quarantine"');
    expect(cleanup.run).toContain('cd -- "$quarantine"');
    expect(cleanup.run).toContain("current_root_id=\"$(stat -c '%d:%i' -- .)\"");
    expect(cleanup.run).toContain('[[ "$current_root_id" != "$HARNESS_ROOT_ID" ]]');
    expect(cleanup.run).toContain("find . -mindepth 1 -depth -delete");
    expect(cleanup.run).not.toContain("rm -rf");
    expect(cleanup.run).not.toContain("HARNESS_ROOT:-/tmp/");
    expect(cleanup.run).toContain("Refusing unsafe cleanup path");
    expect(cleanup.run).toContain("Refusing replaced cleanup path");
    expect(cleanup.run).toContain("Refusing post-verification replacement");
  });

  // Runs the cleanup step itself, which exists only on the workflow's
  // ubuntu-latest runner and relies on GNU `mv -T` and `stat -c`, as does the
  // test's own stand-in for `stat`; macOS has neither.
  it.skipIf(process.platform !== "linux")(
    "leaves unowned, symlinked, and replaced harness scratch paths untouched",
    () => {
      const cleanup = workflow.jobs.conformance.steps.find(
        (step) => step.name === "Clean up pinned harness",
      );
      const runId = (BigInt(Date.now()) * 1_000_000n + BigInt(process.pid)).toString();
      const baseEnv = {
        ...process.env,
        GITHUB_RUN_ID: runId,
        HARNESS_NAME: "openclaw",
      };

      const formerFallback = `/tmp/oh-${runId}-o`;
      mkdirSync(formerFallback);
      writeFileSync(join(formerFallback, "must-remain"), "unowned\n");
      cleanups.push(() => rmSync(formerFallback, { recursive: true, force: true }));
      const missingOwnership = spawnSync("bash", ["-euo", "pipefail", "-c", cleanup.run], {
        env: baseEnv,
        encoding: "utf8",
      });
      expect(missingOwnership.status, missingOwnership.stderr).toBe(0);
      expect(existsSync(join(formerFallback, "must-remain"))).toBe(true);

      const danglingTarget = `/tmp/omnesis-absent-${runId}`;
      const symlinkPath = `/tmp/oh-${runId}-o.abcdef`;
      symlinkSync(danglingTarget, symlinkPath);
      cleanups.push(() => rmSync(symlinkPath, { force: true }));
      const symlinked = spawnSync("bash", ["-euo", "pipefail", "-c", cleanup.run], {
        env: { ...baseEnv, HARNESS_ROOT: symlinkPath, HARNESS_ROOT_ID: "0:0" },
        encoding: "utf8",
      });
      expect(symlinked.status, symlinked.stderr).toBe(64);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

      const replacedPath = mkdtempSync(`/tmp/oh-${runId}-o.`);
      cleanups.push(() => rmSync(replacedPath, { recursive: true, force: true }));
      const replaced = spawnSync("bash", ["-euo", "pipefail", "-c", cleanup.run], {
        env: { ...baseEnv, HARNESS_ROOT: replacedPath, HARNESS_ROOT_ID: "0:0" },
        encoding: "utf8",
      });
      expect(replaced.status, replaced.stderr).toBe(64);
      expect(existsSync(replacedPath)).toBe(true);

      const ownedPath = mkdtempSync(`/tmp/oh-${runId}-o.`);
      writeFileSync(join(ownedPath, "owned"), "delete me\n");
      const ownedStat = statSync(ownedPath);
      const owned = spawnSync("bash", ["-euo", "pipefail", "-c", cleanup.run], {
        env: {
          ...baseEnv,
          HARNESS_ROOT: ownedPath,
          HARNESS_ROOT_ID: `${ownedStat.dev}:${ownedStat.ino}`,
        },
        encoding: "utf8",
      });
      expect(owned.status, owned.stderr).toBe(0);
      expect(existsSync(ownedPath)).toBe(false);

      const racingOwnedPath = mkdtempSync(`/tmp/oh-${runId}-o.`);
      writeFileSync(join(racingOwnedPath, "owned"), "owned data\n");
      const racingOwnedStat = statSync(racingOwnedPath);
      const racingBackup = `${racingOwnedPath}-original`;
      const replacement = tmpDir("omnesis-harness-cleanup-replacement-");
      writeFileSync(join(replacement, "must-remain"), "replacement\n");
      const swapMarker = join(tmpDir("omnesis-harness-cleanup-swap-"), "swapped");
      const fakeBin = tmpDir("omnesis-harness-cleanup-bin-");
      writeFileSync(
        join(fakeBin, "stat"),
        [
          "#!/bin/bash",
          'if [[ "${!#}" == "." && ! -e "$SWAP_MARKER" ]]; then',
          '  output="$(/usr/bin/stat "$@")"',
          '  quarantine_parent="$(dirname -- "$PWD")"',
          '  /usr/bin/mv -T -- "$quarantine_parent/root" "$SWAP_OWNED_BACKUP"',
          '  /usr/bin/mv -T -- "$SWAP_REPLACEMENT" "$quarantine_parent/root"',
          '  : > "$SWAP_MARKER"',
          '  printf "%s\\n" "$output"',
          "  exit 0",
          "fi",
          'exec /usr/bin/stat "$@"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      cleanups.push(() => rmSync(racingOwnedPath, { recursive: true, force: true }));
      cleanups.push(() => rmSync(racingBackup, { recursive: true, force: true }));
      const raced = spawnSync("bash", ["-euo", "pipefail", "-c", cleanup.run], {
        env: {
          ...baseEnv,
          PATH: `${fakeBin}:${baseEnv.PATH}`,
          HARNESS_ROOT: racingOwnedPath,
          HARNESS_ROOT_ID: `${racingOwnedStat.dev}:${racingOwnedStat.ino}`,
          SWAP_MARKER: swapMarker,
          SWAP_OWNED_BACKUP: racingBackup,
          SWAP_REPLACEMENT: replacement,
        },
        encoding: "utf8",
      });
      expect(raced.status, raced.stderr).toBe(64);
      expect(existsSync(join(racingOwnedPath, "must-remain"))).toBe(true);
      expect(existsSync(racingBackup)).toBe(true);
    },
  );
});

describe("fast inner-loop typecheck scripts", () => {
  // The "Fast inner loops" section of AGENTS.md tells future agents to reach
  // for typecheck:fast / typecheck:watch as a narrower signal than the full
  // typecheck. This guards that the scripts it names actually exist and that
  // the documented fast typecheck genuinely runs clean — the doc never points
  // at an aspirational script.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  it("declares typecheck:fast and typecheck:watch in package.json", () => {
    expect(pkg.scripts["typecheck:fast"]).toBeTruthy();
    expect(pkg.scripts["typecheck:watch"]).toBeTruthy();
    // typecheck:watch must launch a watch (tsc --build --watch); typecheck:fast
    // must be a real tsc --build (not an alias of the full typecheck verbatim).
    expect(pkg.scripts["typecheck:watch"]).toContain("--watch");
    expect(pkg.scripts["typecheck:fast"]).toContain("tsc --build");
    expect(pkg.scripts["typecheck:fast"]).not.toBe(pkg.scripts.typecheck);
  });

  it("typecheck:fast runs clean (exit 0) against the real tree", () => {
    // Run the real script via npm so the test exercises exactly what AGENTS.md
    // documents. tsc --build is incremental; the cost here is a warm build of
    // the app packages, well within the timeout. A type error anywhere in the
    // gateway/collector/cli dependency chain makes this throw — the regression
    // net for "the documented fast typecheck still passes".
    const out = execFileSync("npm", ["run", "typecheck:fast"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(out).not.toMatch(/error TS\d+/);
  }, 120000);
});

describe("agent-doc executable-claim drift guard (C6)", () => {
  // The agent docs (root AGENTS.md, ios/AGENTS.md, android/AGENTS.md) are the
  // agent contract: every `npm run <script>` and `scripts/<file>` they instruct
  // an agent to run must actually resolve, and the corrected Android Roborazzi
  // framing must keep matching the real screenshot mechanism. This block parses
  // the docs for the commands they name and asserts each is real — so a future
  // edit that names a non-existent script, or that re-introduces the false
  // "@Preview blocks are rendered by recordRoborazziDebug" claim, reddens here.
  //
  // CLAUDE.md is a symlink to AGENTS.md (same for ios/ and android/), so reading
  // AGENTS.md covers both names.
  const docs = ["AGENTS.md", "ios/AGENTS.md", "android/AGENTS.md"];

  function readDoc(rel) {
    return readFileSync(join(repoRoot, rel), "utf8");
  }

  // Every `npm run <script>` an agent doc tells the agent to run must resolve in
  // the package.json that owns it (root, or the `--prefix <dir>` package).
  function npmRunRefs(text) {
    const refs = [];
    const re = /npm (?:--prefix ([a-z][a-z0-9_-]*) )?run ([a-z][a-z0-9:_-]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) refs.push({ prefix: m[1] ?? null, script: m[2] });
    return refs;
  }

  // Every `scripts/<file>` / `android/scripts/<file>` token with a real script
  // extension must exist on disk.
  function scriptFileRefs(text) {
    const refs = new Set();
    const re = /(?:android\/)?scripts\/[A-Za-z0-9_-]+\.(?:sh|mjs|ts|js)/g;
    let m;
    while ((m = re.exec(text)) !== null) refs.add(m[0]);
    return [...refs];
  }

  const scriptCache = new Map();
  function scriptsOf(prefix) {
    const key = prefix ?? "<root>";
    if (!scriptCache.has(key)) {
      const pkgPath = prefix
        ? join(repoRoot, prefix, "package.json")
        : join(repoRoot, "package.json");
      scriptCache.set(key, JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {});
    }
    return scriptCache.get(key);
  }

  it.each(docs)("every `npm run` script named in %s exists in its package.json", (rel) => {
    const refs = npmRunRefs(readDoc(rel));
    // Sanity: the parser found something to check, so a doc that quietly stopped
    // naming any commands can't vacuously pass.
    if (rel === "AGENTS.md") expect(refs.length).toBeGreaterThan(0);
    for (const { prefix, script } of refs) {
      const scripts = scriptsOf(prefix);
      expect(
        scripts[script],
        `${rel} instructs \`npm ${prefix ? `--prefix ${prefix} ` : ""}run ${script}\` but ${
          prefix ?? "root"
        }/package.json has no such script`,
      ).toBeTruthy();
    }
  });

  it.each(docs)("every `scripts/<file>` named in %s exists on disk", (rel) => {
    const refs = scriptFileRefs(readDoc(rel));
    for (const ref of refs) {
      expect(existsSync(join(repoRoot, ref)), `${rel} names ${ref} which does not exist`).toBe(
        true,
      );
    }
  });

  // The criterion's named claim: android/AGENTS.md must describe the REAL
  // mechanism — explicit captureRoboImage cases in *ScreenshotTest.kt, no
  // @Preview scanner — and that mechanism must actually be how PNGs are made.
  it("android/AGENTS.md points at the real captureRoboImage screenshot tests, which exist and use captureRoboImage", () => {
    const screenshotDir = join(
      repoRoot,
      "android/app/src/test/kotlin/dev/omnesis/android/screenshots",
    );
    expect(
      existsSync(screenshotDir),
      `${screenshotDir} (the Android screenshot tests) is missing`,
    ).toBe(true);

    // The doc must name the *ScreenshotTest.kt mechanism and the captureRoboImage
    // call — the real source of PNGs.
    const androidDoc = readDoc("android/AGENTS.md");
    expect(androidDoc).toMatch(/\*ScreenshotTest\.kt/);
    expect(androidDoc).toMatch(/captureRoboImage/);

    // The mechanism is real: at least one *ScreenshotTest.kt exists and calls
    // captureRoboImage (not a @Preview scanner). Asserts the doc's claim holds
    // against the code, so a future test-layout change that breaks the contract
    // surfaces here.
    const testFiles = execFileSync(
      "bash",
      ["-c", `ls ${JSON.stringify(screenshotDir)}/*ScreenshotTest.kt`],
      { cwd: repoRoot, encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(testFiles.length).toBeGreaterThan(0);
    const withCapture = testFiles.filter((f) =>
      readFileSync(f, "utf8").includes("captureRoboImage("),
    );
    expect(
      withCapture.length,
      "no *ScreenshotTest.kt calls captureRoboImage — the documented render mechanism is gone",
    ).toBeGreaterThan(0);

    // Negative guard against a @Preview scanner: no screenshot test discovers
    // @Preview functions (e.g. via a Roborazzi compose-preview scanner import).
    // If one is ever wired, the doc must be updated — fail here to force that.
    for (const f of testFiles) {
      const src = readFileSync(f, "utf8");
      expect(
        /ComposablePreviewScanner|PreviewParameterScanner|scanPreviews/i.test(src),
        `${f} uses a @Preview scanner — update android/AGENTS.md, which states no scanner is wired`,
      ).toBe(false);
    }
  });
});

describe("scripts/synth-gateway.sh source seeding", () => {
  // A fake curl answering the source add with the given status codes in turn.
  function seedWith(addStatuses) {
    const root = mkdtempSync(join(tmpdir(), "omnesis-synth-seed-test-"));
    try {
      const bin = join(root, "bin");
      const config = join(root, "config");
      mkdirSync(bin);
      mkdirSync(config);
      writeFileSync(join(config, "token"), "fixture-token");
      const counter = join(root, "adds");
      const curl = join(bin, "curl");
      writeFileSync(
        curl,
        `#!/usr/bin/env bash
case "$*" in
  *'/admin/devices'*) printf '{"items":[{"id":"device_fixture","kind":"collector"}]}' ;;
  *'/admin/sources/add'*)
    n=$(( $(cat '${counter}' 2>/dev/null || echo 0) + 1 )); echo "$n" >'${counter}'
    statuses=(${addStatuses.join(" ")})
    status=\${statuses[$(( n <= \${#statuses[@]} ? n - 1 : \${#statuses[@]} - 1 ))]}
    if [[ "$status" == 2* ]]; then printf '{"sourceIds":["fixture"]}\\n%s' "$status"
    else printf '{"error":"fixture rejected"}\\n%s' "$status"; fi
    ;;
  *'/admin/search-snapshot/refresh'*) printf '{}' ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(curl, 0o755);
      const result = spawnSync("bash", [join(repoRoot, "scripts/synth-gateway.sh"), "seed"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OMNESIS_CONFIG_DIR: config },
        encoding: "utf8",
        timeout: 60_000,
      });
      return { result, adds: Number(readFileSync(counter, "utf8")) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("fails at a rejected source instead of reporting a seeded gateway", () => {
    const { result, adds } = seedWith([400]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Failed to add synth source");
    expect(result.stderr).toContain("HTTP 400");
    expect(result.stderr).toContain("fixture rejected");
    expect(result.stdout).not.toContain("Refreshing search snapshot");
    expect(adds).toBe(1);
  });

  it("retries a gateway that is still finishing its boot", () => {
    const { result, adds } = seedWith([503, 503, 200]);
    expect(result.stderr).not.toContain("Failed to add synth source");
    expect(result.stdout).toContain("Refreshing search snapshot");
    expect(adds).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe("scripts/shot-portal.sh on-demand portal screenshot loop (C9)", () => {
  // shot-portal.sh generalises the landing-page capture into an on-demand
  // route screenshot loop: it boots (or reuses) an isolated SYNTHETIC gateway
  // FROM THIS WORKTREE on a high port, navigates the headless portal to
  // /portal/<route>, waits on a SELECTOR (never networkidle — the portal holds
  // SSE/WS), and writes a PNG to /tmp the agent can Read. This block proves the
  // round-trip end to end against a real isolated gateway, the fail-loud
  // negative control (an unsatisfiable wait selector → named non-zero, no
  // blank PNG), and that the landing-page capture is NOT regressed.
  const shotPortal = join(repoRoot, "scripts/shot-portal.sh");
  const devInstance = join(repoRoot, "scripts/dev-instance.sh");
  // High port well clear of the live gateway (7600), dev-instance (17600),
  // playwright (17800), demo (27600), and the OAuth ports (3000-3003); a small
  // per-run offset keeps reruns from colliding with a lingering listener.
  const PORT = 18900 + Math.floor(Math.random() * 200);
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-shot-portal-"));
  const outDir = mkdtempSync(join(tmpdir(), "omnesis-shot-out-"));

  // One isolated gateway booted once and reused across the cases below (boot is
  // the slow part). The env pins the script's isolated config dir + port so it
  // never touches the live gateway / ~/.config/omnesis.
  const shotEnv = {
    ...leanGatewayEnv,
    OMNESIS_SHOT_PORT: String(PORT),
    OMNESIS_SHOT_CONFIG_DIR: configDir,
    OMNESIS_SHOT_READY_TIMEOUT: "120",
    OMNESIS_LOG_LEVEL: "warn",
  };

  function runShot(args, { extraEnv = {}, timeout = 120000 } = {}) {
    return new Promise((resolve) => {
      execFile(
        "bash",
        [shotPortal, ...args],
        {
          cwd: repoRoot,
          env: { ...process.env, ...shotEnv, ...extraEnv },
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  // A valid PNG starts with the 8-byte signature and carries a non-trivial
  // body; the IHDR width/height live at bytes 16/20 (big-endian). Reading the
  // header proves the file is a real raster, not a zero-byte/truncated stub.
  function readPng(path) {
    const buf = readFileSync(path);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const validHeader = buf.length >= 24 && buf.subarray(0, 8).equals(sig);
    return {
      bytes: buf.length,
      validHeader,
      width: validHeader ? buf.readUInt32BE(16) : 0,
      height: validHeader ? buf.readUInt32BE(20) : 0,
    };
  }

  // Stopping escalates TERM to KILL per process after ~5 s and stops the
  // gateway and its collector in turn, then sweeps. On a busy host that
  // legitimately outlasts the default 10 s hook budget.
  const TEARDOWN_TIMEOUT_MS = 60_000;

  // Tear the gateway down even if a case throws. Stop via the script's own
  // path, then hard-kill any listener still bound to the isolated port (the
  // synth collector can re-spawn the gateway after a soft stop). The process
  // serves our isolated config dir, so it is unambiguously ours.
  afterAll(() => {
    try {
      execFileSync("bash", [devInstance, "stop"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OMNESIS_CONFIG_DIR: configDir,
          OMNESIS_GATEWAY_PORT: String(PORT),
        },
        stdio: "ignore",
      });
    } catch {
      /* already stopped */
    }
    try {
      const pids = execFileSync("bash", ["-c", `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t || true`], {
        encoding: "utf8",
      })
        .split(/\s+/)
        .filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          /* gone */
        }
      }
    } catch {
      /* lsof absent — nothing to clean */
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }, TEARDOWN_TIMEOUT_MS);

  it("boots an isolated synthetic gateway, shoots a real route, and writes a non-trivial PNG; landing-page capture is not regressed; a bad selector fails loud", async () => {
    // ── Positive: shoot a real portal route ─────────────────────────
    // --keep leaves the gateway up so the negative control + landing-page
    // regression check below reuse it instead of paying the boot cost again.
    const out = join(outDir, "people.png");
    const ok = await runShot(["people", "--keep", "--out", out], { timeout: 240000 });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("Screenshot written:");
    expect(existsSync(out)).toBe(true);

    const png = readPng(out);
    expect(png.validHeader, "output is not a valid PNG").toBe(true);
    // A rendered portal page is tens of KB at retina density; a blank/error
    // frame would be far smaller. Generous floor — we assert "real content
    // rendered", not an exact byte count (headless rendering is not
    // pixel-deterministic).
    expect(png.bytes).toBeGreaterThan(15000);
    expect(png.width).toBeGreaterThan(1000);
    expect(png.height).toBeGreaterThan(500);

    // ── Negative control: an unsatisfiable wait selector must FAIL LOUD ──
    // The route renders, but the selector never appears: the script must exit
    // non-zero with its named signal and must NOT write the real PNG (only a
    // distinctly-named -debug frame is permitted). Reuses the kept gateway.
    const badOut = join(outDir, "neg.png");
    const bad = await runShot(
      ["people", "--keep", "--wait", ".shot-portal-selector-never-exists-zzz", "--out", badOut],
      { extraEnv: { PORTAL_WAIT_TIMEOUT: "3000" }, timeout: 90000 },
    );
    expect(bad.code, bad.out).not.toBe(0);
    expect(bad.out).toContain("never became visible");
    // The real asset must be absent — no silent blank PNG masquerading as a shot.
    expect(existsSync(badOut), "a blank PNG was written despite the selector miss").toBe(false);

    // ── Regression: the landing-page capture still produces its asset at the
    // expected dimensions. capture-portal.mjs now shares its plumbing with
    // shot-portal via scripts/lib/portal-capture.mjs; this proves the refactor
    // did not break the showcase pipeline. At PORTAL_ZOOM=1.5 the asset is
    // 1440/1.5 layout px painted at deviceScaleFactor 3 → 2880 physical px wide
    // (same as before the refactor).
    const caCert = join(configDir, "tls", "cert.pem");
    const token = readFileSync(join(configDir, "token"), "utf8").trim();
    const landingOut = join(outDir, "landing.png");
    execFileSync("node", [join(repoRoot, "scripts/capture-portal.mjs")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORTAL_URL: `https://localhost:${PORT}`,
        PORTAL_TOKEN: token,
        PORTAL_OUT: landingOut,
        PORTAL_APPEARANCE: "dark",
        PORTAL_ZOOM: "1.5",
        NODE_EXTRA_CA_CERTS: caCert,
      },
      stdio: "pipe",
      timeout: 120000,
    });
    const landing = readPng(landingOut);
    expect(landing.validHeader, "landing-page capture is not a valid PNG").toBe(true);
    expect(landing.width, "landing-page asset width regressed").toBe(2880);
    expect(landing.height).toBeGreaterThan(500);
  }, 360000);

  it("commits no operator-private default (no operator-home absolute path / hostname)", () => {
    const src = readFileSync(shotPortal, "utf8");
    // Generic /tmp defaults only — no /home/<user> or /Users/<user> baked in.
    expect(src).not.toMatch(/\/home\/[a-z]/i);
    expect(src).not.toMatch(/\/Users\/[a-z]/i);
    // The isolated config dir + port defaults are generic /tmp + a high port.
    expect(src).toMatch(/OMNESIS_SHOT_CONFIG_DIR:-\/tmp\/omnesis-shot-portal/);
    expect(src).toMatch(/OMNESIS_SHOT_PORT:-18700/);
    // Never the live gateway port as a default.
    expect(src).not.toMatch(/OMNESIS_SHOT_PORT:-7600\b/);
  });
});

describe("scripts/ios-logic.sh sim-less native logic lane guards (C11)", () => {
  // scripts/ios-logic.sh shifts the iOS PURE-LOGIC feedback loop left: it runs
  // the SwiftPM `swift test` lane on a configured macOS host over ssh WITHOUT a
  // simulator build. The real `swift test` round-trip needs the macOS Swift
  // toolchain (exercised manually on the host); these are the Linux-runnable,
  // CI-safe NEGATIVE CONTROLS for the script's fail-loud guards — they MIRROR
  // the C10 ios-snapshot.sh guards and must fire WITHOUT a real Mac.
  //
  //   - unset OMNESIS_EPIC_MACOS_HOST → a clear error + non-zero exit (the
  //     script never falls back to a guessed personal alias).
  //   - a scratch path that resolves into a CI runner `_work` clone → refused.
  //   - a scratch path marked as the primary checkout → refused.
  //
  // The host guards need the script to "ssh" somewhere; we stub `ssh` with a
  // local shim that drops the host arg and runs the remaining command in a
  // local bash, so `printf`/`test`/`mkdir` resolve against a sandbox dir on
  // THIS box. That lets the path-guard logic run end-to-end on Linux.
  const iosLogic = join(repoRoot, "scripts/ios-logic.sh");

  function sshStubPath() {
    const binDir = tmpDir("omnesis-ios-logic-bin-");
    const sshShim = join(binDir, "ssh");
    writeFileSync(sshShim, '#!/usr/bin/env bash\nshift\nexec bash -c "$@"\n', { mode: 0o755 });
    const need = [
      "bash",
      "rsync",
      "dirname",
      "printf",
      "test",
      "mkdir",
      "cat",
      "ls",
      "wc",
      "tr",
      "find",
      "cp",
      "rm",
    ];
    for (const tool of need) {
      const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
        encoding: "utf8",
      }).trim();
      if (real && real.startsWith("/")) symlinkSync(real, join(binDir, tool));
    }
    return binDir;
  }

  function runIosLogic(args, { extraEnv = {}, path = null, timeout = 20000 }) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...extraEnv };
      if (path) env.PATH = path;
      execFile(
        "bash",
        [iosLogic, ...args],
        { cwd: repoRoot, env, timeout },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("fails loud with EX_CONFIG (78) when OMNESIS_EPIC_MACOS_HOST is unset — never a guessed alias", async () => {
    const { code, out } = await runIosLogic([], { extraEnv: { OMNESIS_EPIC_MACOS_HOST: "" } });
    expect(code).toBe(78);
    expect(out).toContain("OMNESIS_EPIC_MACOS_HOST is not set");
    expect(out).toMatch(/export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>/);
  }, 30000);

  it("fails loud (exit 64) when --filter is given without a value", async () => {
    const { code, out } = await runIosLogic(["--filter"], {
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "stub" },
    });
    expect(code).toBe(64);
    expect(out).toContain("--filter needs a value");
  }, 20000);

  it("refuses a scratch path that resolves into a CI runner _work clone", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-ios-logic-work-");
    const target = join(sandbox, "actions-runner", "_work", "Omnesis", "Omnesis");
    mkdirSync(target, { recursive: true });
    const { code, out } = await runIosLogic([], {
      path,
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "stub", OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE: target },
    });
    expect(code).toBe(1);
    expect(out).toContain("CI runner clone");
    // It must refuse BEFORE rsyncing — no up-sync transfer line.
    expect(out).not.toMatch(/rsync ios\//);
  }, 30000);

  it("refuses a scratch path marked as the primary checkout (.omnesis-primary sentinel)", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-ios-logic-primary-");
    const target = join(sandbox, "Projects", "Omnesis");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".omnesis-primary"), "");
    const { code, out } = await runIosLogic([], {
      path,
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "stub", OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE: target },
    });
    expect(code).toBe(1);
    expect(out).toContain("primary checkout");
    expect(out).not.toMatch(/rsync ios\//);
  }, 30000);

  it("runs `swift test` (sim-less), never `xcodebuild` / a simulator destination", () => {
    // The whole point of the C11 logic lane is NO simulator build: the COMMAND
    // it runs over ssh must be SwiftPM `swift test`, not `xcodebuild test
    // -destination 'platform=iOS Simulator…'`. (Comments may mention the slow
    // ios-snapshot.sh simulator lane by way of contrast — so we scope the
    // assertion to the executed-command lines, not the whole file.)
    const src = readFileSync(iosLogic, "utf8");
    const commandLines = src.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    expect(commandLines.some((l) => /swift test/.test(l))).toBe(true);
    expect(commandLines.some((l) => /xcodebuild/.test(l))).toBe(false);
    expect(commandLines.some((l) => /iOS Simulator/.test(l))).toBe(false);
    // It preserves the warm SwiftPM .build cache (excluded from the up-sync).
    expect(src).toMatch(/--exclude '\.build'/);
  });

  it("commits no operator-private default (no host alias / operator-home absolute path)", () => {
    const src = readFileSync(iosLogic, "utf8");
    expect(src).not.toMatch(/\/Users\/[a-z]/i);
    expect(src).not.toMatch(/\/home\/[a-z]/i);
    // The default warm-scratch path is HOME-relative on the host, never absolute.
    expect(src).toMatch(/OMNESIS_EPIC_MACOS_IOS_LOGIC_WORKTREE:-\\\$HOME\/omnesis-ios-logic/);
  });
});

describe("ios/Package.swift sim-less logic target (C11)", () => {
  // The C11 iOS logic lane is `swift test` against ios/Package.swift's
  // OmnesisTests target. For that to stay sim-less the UIKit-touching /
  // live-gateway tests must be EXCLUDED from the SwiftPM target (the iOS-only
  // UI is canImport-compiled-out of the macOS library, so those tests can't
  // compile/run there). Guard the contract: each excluded file must (a) be
  // listed in Package.swift AND (b) still exist on disk — a rename that drops
  // it from the exclude list silently breaks the sim-less lane.
  const pkg = join(repoRoot, "ios/Package.swift");
  const excluded = [
    "PreviewSnapshotTests.swift",
    "AppearanceTests.swift",
    "GatewayErrorViewTests.swift",
    "AdminCoordinatorReconnectTests.swift",
    "GatewayLiveE2ETests.swift",
  ];

  it("excludes the UIKit/live tests from the SwiftPM OmnesisTests target", () => {
    const src = readFileSync(pkg, "utf8");
    for (const f of excluded) {
      expect(src, `${f} must be excluded from the SwiftPM logic target`).toContain(`"${f}"`);
      // And the file it names must actually exist (no stale exclude).
      expect(
        existsSync(join(repoRoot, "ios/Tests/OmnesisTests", f)),
        `${f} is excluded but missing on disk`,
      ).toBe(true);
    }
  });

  it("no UIKit-importing test is left UN-excluded (would break the sim-less lane)", () => {
    // Any test that imports UIKit can't compile on macOS; if one isn't in the
    // exclude list, `swift test` (the logic lane) breaks. AppearanceTests imports
    // only SwiftUI but exercises the UIKit-gated AppearanceStore — kept excluded.
    const src = readFileSync(pkg, "utf8");
    const testDir = join(repoRoot, "ios/Tests/OmnesisTests");
    const files = execFileSync("bash", ["-c", `ls ${testDir}/*.swift`], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((p) => p.split("/").pop());
    for (const f of files) {
      const body = readFileSync(join(testDir, f), "utf8");
      if (/^import UIKit$/m.test(body)) {
        expect(
          src,
          `${f} imports UIKit but is not excluded — the sim-less swift test lane will fail to compile`,
        ).toContain(`"${f}"`);
      }
    }
  });
});

describe("scripts/android-logic.sh emulator-less JVM logic lane guards (C11)", () => {
  // scripts/android-logic.sh shifts the Android PURE-LOGIC feedback loop left:
  // it runs `./gradlew <module>:testDebugUnitTest` on a configured macOS host
  // over ssh WITHOUT an emulator. The real round-trip needs the Android
  // toolchain (exercised manually on the host); these are the Linux-runnable,
  // CI-safe NEGATIVE CONTROLS, mirroring the C20 android-render.sh guards.
  const androidLogic = join(repoRoot, "scripts/android-logic.sh");

  function sshStubPath() {
    const binDir = tmpDir("omnesis-android-logic-bin-");
    const sshShim = join(binDir, "ssh");
    writeFileSync(sshShim, '#!/usr/bin/env bash\nshift\nexec bash -c "$@"\n', { mode: 0o755 });
    const need = [
      "bash",
      "rsync",
      "dirname",
      "printf",
      "test",
      "mkdir",
      "cat",
      "ls",
      "wc",
      "tr",
      "find",
      "cp",
      "rm",
    ];
    for (const tool of need) {
      const real = execFileSync("bash", ["-c", `command -v ${tool} || true`], {
        encoding: "utf8",
      }).trim();
      if (real && real.startsWith("/")) symlinkSync(real, join(binDir, tool));
    }
    return binDir;
  }

  function runAndroidLogic(args, { extraEnv = {}, path = null, timeout = 20000 }) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...extraEnv };
      if (path) env.PATH = path;
      execFile(
        "bash",
        [androidLogic, ...args],
        { cwd: repoRoot, env, timeout },
        (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("fails loud with EX_CONFIG (78) when OMNESIS_EPIC_MACOS_HOST is unset — never a guessed alias", async () => {
    const { code, out } = await runAndroidLogic([], { extraEnv: { OMNESIS_EPIC_MACOS_HOST: "" } });
    expect(code).toBe(78);
    expect(out).toContain("OMNESIS_EPIC_MACOS_HOST is not set");
    expect(out).toMatch(/export OMNESIS_EPIC_MACOS_HOST=<your-macos-ssh-alias>/);
  }, 30000);

  it("rejects an unknown argument loudly (exit 64)", async () => {
    const { code, out } = await runAndroidLogic(["--bogus"], {
      extraEnv: { OMNESIS_EPIC_MACOS_HOST: "stub" },
    });
    expect(code).toBe(64);
    expect(out).toContain("unknown argument");
  }, 20000);

  it("refuses a scratch path that resolves into a CI runner _work clone", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-android-logic-work-");
    const target = join(sandbox, "actions-runner", "_work", "Omnesis", "Omnesis");
    mkdirSync(target, { recursive: true });
    const { code, out } = await runAndroidLogic([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("CI runner clone");
    expect(out).not.toMatch(/rsync android\//);
  }, 30000);

  it("refuses a scratch path marked as the primary checkout (.omnesis-primary sentinel)", async () => {
    const path = sshStubPath();
    const sandbox = tmpDir("omnesis-android-logic-primary-");
    const target = join(sandbox, "Projects", "Omnesis");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, ".omnesis-primary"), "");
    const { code, out } = await runAndroidLogic([], {
      path,
      extraEnv: {
        OMNESIS_EPIC_MACOS_HOST: "stub",
        OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE: target,
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("primary checkout");
    expect(out).not.toMatch(/rsync android\//);
  }, 30000);

  it("runs testDebugUnitTest (JVM), never an emulator/Roborazzi task", () => {
    // The whole point of the C11 logic lane is NO emulator + NO Roborazzi
    // render: the COMMAND it runs must drive testDebugUnitTest, not
    // connectedAndroidTest or record/verifyRoborazzi. (Comments may mention the
    // slow android-render.sh Roborazzi lane by way of contrast — so we scope the
    // assertion to the executed-command lines, not the whole file.)
    const src = readFileSync(androidLogic, "utf8");
    const commandLines = src.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    expect(commandLines.some((l) => /testDebugUnitTest/.test(l))).toBe(true);
    expect(commandLines.some((l) => /connectedDebugAndroidTest|connectedAndroidTest/.test(l))).toBe(
      false,
    );
    expect(commandLines.some((l) => /Roborazzi/.test(l))).toBe(false);
    // It preserves the warm Gradle cache (excluded from the up-sync) + opts into
    // the build/configuration cache so a repeat run is fast.
    expect(src).toMatch(/--exclude '\.gradle'/);
    expect(src).toMatch(/--build-cache --configuration-cache/);
    // Default scopes to the pure-JVM logic modules (no :app screenshot module).
    expect(src).toMatch(/:core-transport:testDebugUnitTest/);
  });

  it("commits no operator-private default (no host alias / operator-home absolute path)", () => {
    const src = readFileSync(androidLogic, "utf8");
    expect(src).not.toMatch(/\/Users\/[a-z]/i);
    expect(src).not.toMatch(/\/home\/[a-z]/i);
    expect(src).toMatch(
      /OMNESIS_EPIC_MACOS_ANDROID_LOGIC_WORKTREE:-\\\$HOME\/omnesis-android-logic/,
    );
    expect(src).toMatch(/OMNESIS_ANDROID_SDK_HOME:-\\\$HOME\/Library\/Android\/sdk/);
  });
});
