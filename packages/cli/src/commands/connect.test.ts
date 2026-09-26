// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { parse as parseYaml } from "yaml";

type OAuthAuthorizationResult = "AUTHORIZED" | "REDIRECT";
type OAuthFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

const integrationMocks = vi.hoisted(() => ({
  requestJson: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: "ok",
    experimental: true,
    compat: { watchPrivacyPolicy: 1 },
  })),
  authorizeOAuth: vi.fn<(provider: unknown) => Promise<OAuthAuthorizationResult>>(
    async (provider: unknown) => {
      const oauth = provider as {
        saveClientInformation(value: Record<string, unknown>): void;
        saveTokens(value: Record<string, unknown>): void;
      };
      oauth.saveClientInformation({ client_id: "client_fictional" });
      oauth.saveTokens({
        access_token: "access_fictional",
        refresh_token: "refresh_fictional",
        token_type: "Bearer",
      });
      return "AUTHORIZED" as const;
    },
  ),
  oauthFetch: vi.fn<() => OAuthFetch>(() => vi.fn<OAuthFetch>()),
}));

/** The `client_name` the last OAuth authorization would have registered. */
function registeredClientName(): string | undefined {
  const provider = integrationMocks.authorizeOAuth.mock.lastCall?.[0] as
    | IntegrationOAuthProvider
    | undefined;
  return provider?.clientMetadata.client_name;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
});
// Whether the installed OpenClaw takes `--accept-capabilities` is probed by
// running it; that probe has its own suite against fake binaries. Here it is a
// seam so each test decides which kind of OpenClaw release it models.
vi.mock("./openclaw-capability-consent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-capability-consent.js")>();
  return { ...actual, openClawCapabilityConsentSupport: vi.fn(() => "unsupported") };
});
vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  // Trust establishment reaches the network and the developer's own config
  // directory, so it is a seam here: what these tests assert about it is which
  // arguments it is handed, not what it does with them.
  return {
    ...actual,
    fetchPeerCert: vi.fn(),
    ensureGatewayTrust: vi.fn(async () => ({ action: "skipped" as const })),
  };
});
vi.mock("@omnesis/agent-integration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/agent-integration")>();
  return {
    ...actual,
    authorizeIntegrationOAuth: integrationMocks.authorizeOAuth,
    authorizeIntegrationOAuthWithCredentialLock: integrationMocks.authorizeOAuth,
    integrationOAuthFetch: integrationMocks.oauthFetch,
    PinnedGatewayHttpClient: class {
      requestJson(...args: unknown[]): Promise<unknown> {
        return integrationMocks.requestJson(...args);
      }

      postJson(...args: unknown[]): Promise<unknown> {
        return integrationMocks.requestJson("POST", ...args);
      }
    },
    writeIntegrationCredentials: vi.fn(actual.writeIntegrationCredentials),
  };
});
vi.mock("./devices.js", () => ({
  redeemAgentIntegrationPairingCode: vi.fn(),
}));
// The harness's own CLI — its restart and its skill report — is a seam here:
// no suite may restart a real OpenClaw or Hermes.
const harnessCommands = vi.hoisted(() => ({
  run: vi.fn<
    (
      spec: { command: string; args: string[]; env?: Record<string, string> },
      mode: "inherit" | "capture",
    ) => Promise<{ code: number; stdout: string }>
  >(),
}));
vi.mock("../harness-restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-restart.js")>()),
  spawnHarnessCommand: harnessCommands.run,
}));

import { ensureGatewayTrust, fetchPeerCert } from "@omnesis/core";
import {
  loadIntegrationCredentials,
  writeIntegrationCredentials,
} from "@omnesis/agent-integration";
import { CliError } from "../utils.js";
import {
  buildHarnessSkill,
  buildHermesSkill,
  buildOpenClawSkill,
  type Harness,
} from "../harness-skills.js";
import { redeemAgentIntegrationPairingCode } from "./devices.js";
import { authorizeHarness } from "./connect-oauth.js";
import { openClawCapabilityConsentSupport } from "./openclaw-capability-consent.js";
import {
  assertHermesCompletionNotifications,
  assertOpenClawCompletionNotifications,
  connectCommand,
  dotenvSetting,
  encodeDotenvValue,
  harnessHome,
  isHarness,
  mergeOpenClawSkillEnv,
  normalizeHarnessGatewayUrl,
  openClawConfigPath,
  integrationSourceCommit,
  publishManifestForLocalInstall,
  prepareOpenClawInstallArchive,
  retireLegacyHermesConfig,
  retireLegacyOpenClawConfig,
  skillFilePath,
  upsertEnvLines,
} from "./connect.js";
import type { IntegrationOAuthProvider } from "@omnesis/agent-integration";

const tempHomes: string[] = [];
const previousTrustFingerprint = process.env.OMNESIS_TRUST_FINGERPRINT;
const previousConfigDir = process.env.OMNESIS_CONFIG_DIR;

const ENV = {
  OMNESIS_GATEWAY_URL: "https://gateway.example.org:7600",
  OMNESIS_TOKEN: `omn_${"c".repeat(32)}`,
};
const SKILL_ENV = { OMNESIS_AGENT_HARNESS: "openclaw" };
/** What a gateway with the Watch runtime on offers the installed integration. */
const WITH_WATCHES = { subscriptions: true } as const;
/** What a default gateway offers: Answer and transcript ingestion, no Watches. */
const WITHOUT_WATCHES = { subscriptions: false } as const;
const ROTATED_CERT_PEM = "-----BEGIN CERTIFICATE-----\ncm90YXRlZA==\n-----END CERTIFICATE-----\n";
const ROTATED_FINGERPRINT = "d".repeat(64);

const PAIRING = {
  device: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "OpenClaw agent",
    kind: "agent",
  },
  credentials: {
    delivery: {
      tokenId: "22222222-2222-4222-8222-222222222222",
      token: `omn_${"a".repeat(32)}`,
      scopes: ["subscriptions:receive"],
    },
    ingestion: {
      tokenId: "33333333-3333-4333-8333-333333333333",
      token: `omn_${"b".repeat(32)}`,
      scopes: ["write:openclaw"],
    },
    management: {
      tokenId: "44444444-4444-4444-8444-444444444444",
      token: ENV.OMNESIS_TOKEN,
      scopes: ["subscriptions:manage"],
    },
  },
};

function parseFrontmatter(skill: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  if (!match) throw new Error("missing YAML frontmatter");
  const parsed: unknown = parseYaml(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("frontmatter is not a YAML mapping");
  }
  return parsed as Record<string, unknown>;
}

function run(args: Record<string, unknown>): Promise<void> {
  return (connectCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
    args,
  });
}

/** An installation `--refresh` can act on: credentials, identity, env, skill. */
function seedRefreshableInstall(home: string, harness: Harness): string {
  const credentialsPath = join(home, "omnesis", "integration.json");
  mkdirSync(dirname(credentialsPath), { recursive: true });
  writeFileSync(
    credentialsPath,
    `${JSON.stringify({
      gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
      deliveryToken: PAIRING.credentials.delivery.token,
      ingestionToken: PAIRING.credentials.ingestion.token,
      managementToken: PAIRING.credentials.management.token,
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: { client_id: "client_fictional" },
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
      maxConcurrentRuns: 2,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(home, "omnesis", "integration-identity.json"), `fictional-${harness}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(home, ".env"), "UNRELATED=keep\n", { mode: 0o600 });
  const skillPath = skillFilePath(harness, home);
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, "stale skill\n");
  return credentialsPath;
}

function readableTree(root: string): string {
  const visit = (path: string): string =>
    readdirSync(path, { withFileTypes: true })
      .map((entry) => {
        const child = join(path, entry.name);
        return entry.isDirectory() ? visit(child) : readFileSync(child, "utf8");
      })
      .join("\n");
  return visit(root);
}

/** What each harness's skill report says when the Omnesis skill is ready. */
const READY_SKILL_REPORT = {
  openclaw: '{"eligible":["omnesis"],"disabled":[],"blocked":[],"missingRequirements":[]}',
  hermes: "│ omnesis │ productivity │ local │ local │ enabled │",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  harnessCommands.run.mockImplementation(async (spec, mode) => ({
    code: 0,
    stdout:
      mode === "capture"
        ? READY_SKILL_REPORT[spec.command.endsWith("hermes") ? "hermes" : "openclaw"]
        : "",
  }));
  integrationMocks.requestJson.mockImplementation(async () => ({
    status: "ok",
    experimental: true,
    compat: { watchPrivacyPolicy: 1 },
  }));
  integrationMocks.authorizeOAuth.mockImplementation(async (provider: unknown) => {
    const oauth = provider as {
      saveClientInformation(value: Record<string, unknown>): void;
      saveTokens(value: Record<string, unknown>): void;
    };
    oauth.saveClientInformation({ client_id: "client_fictional" });
    oauth.saveTokens({
      access_token: "access_fictional",
      refresh_token: "refresh_fictional",
      token_type: "Bearer",
    });
    return "AUTHORIZED" as const;
  });
  integrationMocks.oauthFetch.mockImplementation(() => vi.fn<OAuthFetch>());
  process.env.OMNESIS_TRUST_FINGERPRINT = "a".repeat(64);
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-connect-config-"));
  tempHomes.push(configDir);
  process.env.OMNESIS_CONFIG_DIR = configDir;
  (redeemAgentIntegrationPairingCode as Mock).mockResolvedValue(PAIRING);
  (fetchPeerCert as Mock).mockResolvedValue({
    pem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
    fingerprint: "a".repeat(64),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  if (previousTrustFingerprint === undefined) {
    delete process.env.OMNESIS_TRUST_FINGERPRINT;
  } else {
    process.env.OMNESIS_TRUST_FINGERPRINT = previousTrustFingerprint;
  }
  if (previousConfigDir === undefined) {
    delete process.env.OMNESIS_CONFIG_DIR;
  } else {
    process.env.OMNESIS_CONFIG_DIR = previousConfigDir;
  }
});

describe("upsertEnvLines", () => {
  it("appends missing keys to an empty file with a trailing newline", () => {
    const out = upsertEnvLines("", ENV);
    expect(out).toBe(
      `OMNESIS_GATEWAY_URL=https://gateway.example.org:7600\n` +
        `OMNESIS_TOKEN=${ENV.OMNESIS_TOKEN}\n`,
    );
  });

  it("replaces existing assignments in place and preserves unrelated lines", () => {
    const existing = "# hermes secrets\nOMNESIS_TOKEN=old\nOTHER_KEY=keep\n";
    const out = upsertEnvLines(existing, ENV);
    expect(out).toBe(
      `# hermes secrets\nOMNESIS_TOKEN=${ENV.OMNESIS_TOKEN}\nOTHER_KEY=keep\n` +
        "OMNESIS_GATEWAY_URL=https://gateway.example.org:7600\n",
    );
  });

  it("replaces `export KEY=` style assignments without duplicating them", () => {
    const out = upsertEnvLines("export OMNESIS_TOKEN=old\n", {
      OMNESIS_TOKEN: "new",
    });
    expect(out).toBe("OMNESIS_TOKEN=new\n");
    expect(out.match(/OMNESIS_TOKEN/g)).toHaveLength(1);
  });

  it("removes later duplicate managed assignments so stale values cannot win", () => {
    const out = upsertEnvLines(
      "OMNESIS_TOKEN=old-first\nOTHER_KEY=keep\nOMNESIS_TOKEN=old-last\n",
      { OMNESIS_TOKEN: ENV.OMNESIS_TOKEN },
    );
    expect(out).toBe(`OMNESIS_TOKEN=${ENV.OMNESIS_TOKEN}\nOTHER_KEY=keep\n`);
  });

  it("removes legacy sensitive environment keys", () => {
    const out = upsertEnvLines(
      "OMNESIS_INTEGRATION_CREDENTIALS=/disclosed/integration.json\nOTHER_KEY=keep\n",
      ENV,
      ["OMNESIS_INTEGRATION_CREDENTIALS"],
    );
    expect(out).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(out).not.toContain("/disclosed/integration.json");
    expect(out).toContain("OTHER_KEY=keep");
  });

  it("is idempotent", () => {
    const once = upsertEnvLines("A=1\n", ENV);
    expect(upsertEnvLines(once, ENV)).toBe(once);
  });

  it("round-trips opaque values containing dotenv metacharacters", () => {
    const value = "fictional:#room,custom:${NOT_EXPANDED},matrix:fictional'\\peer";
    const out = upsertEnvLines("", { FICTIONAL_OPAQUE_VALUE: value });
    expect(out).toContain(`FICTIONAL_OPAQUE_VALUE='`);
    expect(out).not.toContain("FICTIONAL_OPAQUE_VALUE=fictional:#");
    expect(dotenvSetting(out, "FICTIONAL_OPAQUE_VALUE")).toBe(value);
  });

  it("leaves simple values readable and quotes unsafe values", () => {
    expect(encodeDotenvValue("telegram:fictional-owner")).toBe("telegram:fictional-owner");
    expect(encodeDotenvValue("value # ${OTHER}")).toBe("'value # ${OTHER}'");
  });
});

describe("mergeOpenClawSkillEnv", () => {
  it("creates the skills.entries.omnesis.env path in an empty config", () => {
    const merged = JSON.parse(mergeOpenClawSkillEnv("", SKILL_ENV)) as {
      skills: { entries: { omnesis: { env: Record<string, string> } } };
    };
    expect(merged.skills.entries.omnesis.env).toEqual(SKILL_ENV);
  });

  it("preserves unrelated config keys and existing skill entries", () => {
    const existing = JSON.stringify({
      plugins: { entries: { whatsapp: { enabled: true } } },
      skills: { entries: { "git-sync": { enabled: true } } },
    });
    const merged = JSON.parse(mergeOpenClawSkillEnv(existing, SKILL_ENV)) as Record<
      string,
      unknown
    >;
    expect(merged).toMatchObject({
      plugins: { entries: { whatsapp: { enabled: true } } },
      skills: {
        entries: {
          "git-sync": { enabled: true },
          omnesis: { env: SKILL_ENV },
        },
      },
    });
  });

  it("merges over an existing omnesis env without dropping extra vars", () => {
    const existing = JSON.stringify({
      skills: { entries: { omnesis: { env: { EXTRA: "x", OMNESIS_TOKEN: "stale" } } } },
    });
    const merged = JSON.parse(mergeOpenClawSkillEnv(existing, SKILL_ENV)) as {
      skills: { entries: { omnesis: { env: Record<string, string> } } };
    };
    expect(merged.skills.entries.omnesis.env).toEqual({ EXTRA: "x", ...SKILL_ENV });
  });

  it("enables the production plugin and scrubs a legacy disclosed credential path", () => {
    const merged = JSON.parse(
      mergeOpenClawSkillEnv(
        JSON.stringify({
          skills: {
            entries: {
              omnesis: {
                env: {
                  OMNESIS_INTEGRATION_CREDENTIALS: "/disclosed/integration.json",
                  EXTRA: "keep",
                },
              },
            },
          },
          plugins: {
            entries: {
              "omnesis-integration": {
                config: {
                  credentialsPath: "/disclosed/integration.json",
                  keep: true,
                },
              },
            },
          },
        }),
        SKILL_ENV,
      ),
    );
    expect(merged).toMatchObject({
      skills: {
        entries: {
          omnesis: {
            env: { ...SKILL_ENV, EXTRA: "keep" },
          },
        },
      },
      plugins: {
        entries: {
          "omnesis-integration": {
            enabled: true,
            config: { keep: true },
          },
        },
      },
    });
    expect(JSON.stringify(merged)).not.toContain("credentialsPath");
    expect(JSON.stringify(merged)).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(JSON.stringify(merged)).not.toContain("/disclosed/integration.json");
  });

  it("retires only the legacy bridge entry and known Omnesis load path", () => {
    const legacyToken = "omn_fictional_legacy_bridge_secret";
    const existing = JSON.stringify({
      plugins: {
        allow: ["unrelated-plugin", "omnesis-bridge"],
        load: {
          paths: [
            "/Users/fictional/omnesis-src/integrations/openclaw-omnesis-plugin",
            "/opt/fictional/unrelated-plugin",
          ],
        },
        entries: {
          "omnesis-bridge": {
            enabled: true,
            config: {
              gatewayUrl: "https://gateway.example.org:7600",
              token: legacyToken,
            },
          },
          "unrelated-plugin": { enabled: true },
        },
      },
    });
    const retired = retireLegacyOpenClawConfig(existing);
    expect(JSON.parse(retired)).toMatchObject({
      plugins: {
        allow: ["unrelated-plugin"],
        load: { paths: ["/opt/fictional/unrelated-plugin"] },
        entries: { "unrelated-plugin": { enabled: true } },
      },
    });
    expect(retired).not.toContain(legacyToken);
    expect(retireLegacyOpenClawConfig(retired)).toBe(retired);
    expect(mergeOpenClawSkillEnv(existing, ENV)).not.toContain(legacyToken);
  });

  it("fails loud with manual guidance on unparseable config", () => {
    let error: unknown;
    try {
      mergeOpenClawSkillEnv("{ not json", ENV);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).not.toContain(ENV.OMNESIS_TOKEN);
  });

  it.each([
    "[]",
    '{"skills":[]}',
    '{"skills":{"entries":null}}',
    '{"skills":{"entries":{"omnesis":{"env":[]}}}}',
  ])("rejects a non-object config node before writing: %s", (config) => {
    expect(() => mergeOpenClawSkillEnv(config, ENV)).toThrowError(CliError);
  });

  it("rejects disabled OpenClaw completion notifications", () => {
    expect(() =>
      assertOpenClawCompletionNotifications(
        JSON.stringify({ tools: { exec: { notifyOnExit: false } } }),
      ),
    ).toThrowError(/notifyOnExit is disabled/);
  });

  it.each(["off", "error"])(
    "rejects Hermes completion notifications that cannot wake a successful waiter: %s",
    (setting) => {
      expect(() =>
        assertHermesCompletionNotifications(
          `display: { background_process_notifications: ${setting} }\n`,
          "",
          {},
        ),
      ).toThrowError(/must be "concise", "all" or "result"/);
    },
  );

  it.each([
    { config: "display:\n  background_process_notifications: concise\n", env: "", runtime: {} },
    { config: "display:\n  background_process_notifications: result\n", env: "", runtime: {} },
    { config: "", env: "", runtime: {} },
    {
      config: "display: { background_process_notifications: off }\n",
      env: "",
      runtime: { HERMES_BACKGROUND_NOTIFICATIONS: "Concise" },
    },
    { config: "", env: "HERMES_BACKGROUND_NOTIFICATIONS=concise\n", runtime: {} },
  ])(
    "accepts Hermes completion notifications that report every finished process: %o",
    ({ config, env, runtime }) => {
      expect(() => assertHermesCompletionNotifications(config, env, runtime)).not.toThrow();
    },
  );

  it("honors the Hermes dotenv notification override over config", () => {
    expect(() =>
      assertHermesCompletionNotifications(
        "display:\n  background_process_notifications: all\n",
        "HERMES_BACKGROUND_NOTIFICATIONS=error\n",
        {},
      ),
    ).toThrowError(/must be "concise", "all" or "result"/);
  });
});

describe("legacy Hermes config migration", () => {
  it("removes only omnesis-bridge from the enabled list and is idempotent", () => {
    const existing =
      "plugins:\n  enabled:\n    - fictional-weather\n    - omnesis-bridge\n" +
      "display:\n  background_process_notifications: all\n";
    const retired = retireLegacyHermesConfig(existing);
    expect(parseYaml(retired)).toEqual({
      plugins: { enabled: ["fictional-weather"] },
      display: { background_process_notifications: "all" },
    });
    expect(retireLegacyHermesConfig(retired)).toBe(retired);
  });
});

describe("harness paths", () => {
  it("recognizes exactly the supported harnesses", () => {
    expect(isHarness("openclaw")).toBe(true);
    expect(isHarness("hermes")).toBe(true);
    expect(isHarness("codex")).toBe(false);
  });

  it("places the skill in each harness's discovered skills root", () => {
    expect(skillFilePath("openclaw", "/h/.openclaw")).toBe("/h/.openclaw/skills/omnesis/SKILL.md");
    expect(skillFilePath("hermes", "/h/.hermes")).toBe(
      "/h/.hermes/skills/productivity/omnesis/SKILL.md",
    );
  });

  it("honors an explicit --dir override over defaults", () => {
    expect(harnessHome("openclaw", "/custom")).toBe("/custom");
    expect(harnessHome("hermes", "/custom")).toBe("/custom");
  });

  it("resolves OpenClaw profiles and explicit config paths", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.stubEnv("OPENCLAW_HOME", "");
    vi.stubEnv("OPENCLAW_PROFILE", "fictional-testing");
    expect(harnessHome("openclaw")).toMatch(/\.openclaw-fictional-testing$/);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "~/fictional-openclaw.json");
    expect(openClawConfigPath("/unused")).toMatch(/fictional-openclaw\.json$/);
  });

  it("matches OpenClaw effective-home and relative override resolution", () => {
    const effectiveHome = mkdtempSync(join(tmpdir(), "omnesis-openclaw-effective-home-"));
    tempHomes.push(effectiveHome);
    vi.stubEnv("OPENCLAW_HOME", effectiveHome);
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.stubEnv("OPENCLAW_STATE_DIR", "   ");
    expect(harnessHome("openclaw")).toBe(join(effectiveHome, ".openclaw"));

    vi.stubEnv("OPENCLAW_STATE_DIR", "~/fictional-state");
    expect(harnessHome("openclaw")).toBe(join(effectiveHome, "fictional-state"));
    vi.stubEnv("OPENCLAW_STATE_DIR", "relative-fictional-state");
    expect(harnessHome("openclaw")).toBe(resolve("relative-fictional-state"));

    vi.stubEnv("OPENCLAW_CONFIG_PATH", "~/fictional-config.json");
    expect(openClawConfigPath("/unused")).toBe(join(effectiveHome, "fictional-config.json"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "relative-fictional-config.json");
    expect(openClawConfigPath("/unused")).toBe(resolve("relative-fictional-config.json"));

    vi.stubEnv("OPENCLAW_STATE_DIR", "undefined");
    expect(harnessHome("openclaw")).toBe(resolve("undefined"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "null");
    expect(openClawConfigPath("/unused")).toBe(resolve("null"));

    vi.stubEnv("OPENCLAW_STATE_DIR", "");
    vi.stubEnv("OPENCLAW_PROFILE", "../../../../fictional-outside");
    expect(() => harnessHome("openclaw")).toThrow(/Invalid OPENCLAW_PROFILE/);
  });

  it("prefers an existing legacy OpenClaw config before creating a canonical file", () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-legacy-config-path-"));
    tempHomes.push(home);
    const legacy = join(home, "clawdbot.json");
    writeFileSync(legacy, '{"fictionalLegacy":true}\n');
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    expect(openClawConfigPath(home)).toBe(legacy);
  });

  it("requires HTTPS except for loopback gateway URLs", () => {
    expect(normalizeHarnessGatewayUrl("https://gateway.example.org:7600/")).toBe(
      "https://gateway.example.org:7600",
    );
    expect(normalizeHarnessGatewayUrl("http://127.0.0.2:7600/")).toBe("http://127.0.0.2:7600");
    expect(() => normalizeHarnessGatewayUrl("http://127.0.0.1evil:7600")).toThrowError(
      /require HTTPS/,
    );
    expect(() => normalizeHarnessGatewayUrl("http://agent.localhost:7600")).toThrowError(
      /require HTTPS/,
    );
    expect(() => normalizeHarnessGatewayUrl("http://gateway.example.org:7600")).toThrowError(
      /require HTTPS/,
    );
    expect(() =>
      normalizeHarnessGatewayUrl("https://gateway.example.org/\nOMNESIS_TOKEN=forged"),
    ).toThrowError(/control characters/);
    expect(() => normalizeHarnessGatewayUrl("https://gateway.example.org/prefix")).toThrowError(
      /must not contain a path/,
    );
  });
});

describe("harness skill content", () => {
  // Pin the frontmatter fields consumed by each harness loader.
  it("openclaw: carries the management eligibility gate", () => {
    const skill = buildOpenClawSkill(WITH_WATCHES);
    expect(parseFrontmatter(skill)).toMatchObject({
      name: "omnesis",
      metadata: {
        openclaw: {
          emoji: "🧠",
          requires: {
            bins: ["omnesis"],
          },
        },
      },
    });
    expect(skill).toContain("native `omnesis_subscriptions` tool");
    expect(skill).toContain("native `omnesis_answer` tool");
    // Every ask goes through the native tool. A skill that sent a scheduled
    // run to the CLI would put the question behind a shell the harness cannot
    // hold open reliably.
    expect(skill).toContain("cron, and in any other background run");
    expect(skill).toContain("Never run the `omnesis` CLI from a shell");
    expect(skill).toContain("`approval_not_available`");
    expect(skill).toContain("describes the question");
    expect(skill).toContain("Do not set a tight per-job timeout");
    expect(skill).not.toContain("omnesis subscriptions create");
    expect(skill).not.toContain("omnesis triggers");
  });

  it("hermes: declares prerequisites without an environment bearer", () => {
    const skill = buildHermesSkill(WITH_WATCHES);
    expect(parseFrontmatter(skill)).toMatchObject({
      name: "omnesis",
      platforms: ["linux", "macos"],
      prerequisites: { commands: ["omnesis"] },
    });
    expect(parseFrontmatter(skill)).not.toHaveProperty("required_environment_variables");
    expect(skill).toContain("native `omnesis_subscriptions` tool");
    expect(skill).toContain("native `omnesis_answer` tool");
    // Every ask goes through the native tool. A skill that sent a scheduled
    // run to the CLI would put the question behind a shell the harness cannot
    // hold open reliably.
    expect(skill).toContain("cron, and in any other background run");
    expect(skill).toContain("Never run the `omnesis` CLI from a shell");
    expect(skill).toContain("`approval_not_available`");
    expect(skill).toContain("describes the question");
    expect(skill).toContain("Do not set a tight per-job timeout");
    expect(skill).toContain("document watch");
    expect(skill).toContain("analytics watch");
    expect(skill).toContain("one integration identity");
    expect(skill).toContain("leave it pending for approval, or deny it");
    const description = /description: "([^"]+)"/.exec(skill)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(skill).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(skill).not.toContain("managementToken");
  });

  it("both variants explain document-watch and analytics-watch semantics", () => {
    for (const skill of [buildOpenClawSkill(WITH_WATCHES), buildHermesSkill(WITH_WATCHES)]) {
      expect(skill).toContain("`idempotencyKey`");
      // A document watch can match precisely or by meaning. Naming only the
      // fuzzy half is what steered an agent away from the deterministic path.
      expect(skill).toMatch(/match\s+precisely/);
      expect(skill).toMatch(/or by meaning/);
      // Arrival and condition are different things, and the agent has to be
      // able to tell them apart to ask for the right one.
      expect(skill).toMatch(/a new\s+record \*\*arrives\*\*/);
      expect(skill).toMatch(/condition over the data becomes true/);
      expect(skill).toContain("does not backfill documents already indexed");
      expect(skill).toContain("filtered existence");
      expect(skill).toContain("`count`/`sum`/`avg`/`min`/`max`");
      expect(skill).toContain("grouping");
      expect(skill).toContain("rolling or prior windows");
      expect(skill).toContain("arithmetic");
      expect(skill).toMatch(/currently\s+ingested analytics/);
      expect(skill).toContain("already true on the first evaluation");
      expect(skill).toContain("never query rows or computed values");
      expect(skill).toContain("never promise to report the current value");
      expect(skill).toContain('absence or "nothing arrived" conditions');
      expect(skill).toContain("wall-clock schedules");
      expect(skill).toContain("cross-table/cross-source joins");
      expect(skill).toContain("Do not invent a summary push or firing-rate budget");
      expect(skill).toContain("Never use TriggerSpec");
      expect(skill).toMatch(/every\s+valid session/);
      expect(skill).not.toMatch(/heart rate/i);
      // The agent talks to the operator about their watches; `subscription`
      // survives only where it names the transport (the tool ids).
      expect(skill).not.toMatch(/\bsubscriptions?\b(?![_`])/i);
    }
  });

  it.each(["openclaw", "hermes"] as const)(
    "connect %s --skill-only replaces a stale installed skill",
    async (harness: Harness) => {
      const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-`));
      tempHomes.push(home);
      const path = skillFilePath(harness, home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "stale skill\n");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run({ harness, dir: home, "skill-only": true });

      expect(readFileSync(path, "utf8")).toBe(buildHarnessSkill(harness, WITH_WATCHES));
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "connect %s --skill-only keeps the capability the installation was told about",
    async (harness: Harness) => {
      // `--skill-only` never reaches a gateway, so the only honest source for
      // what the skill may describe is what the last connect recorded.
      const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-skill-only-capability-`));
      tempHomes.push(home);
      const credentialsPath = seedRefreshableInstall(home, harness);
      const stored = loadIntegrationCredentials(credentialsPath);
      writeIntegrationCredentials(credentialsPath, {
        ...stored,
        capabilities: { subscriptions: false },
      });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run({ harness, dir: home, "skill-only": true });

      const skill = readFileSync(skillFilePath(harness, home), "utf8");
      expect(skill).toBe(buildHarnessSkill(harness, WITHOUT_WATCHES));
      expect(skill).not.toContain("omnesis_subscriptions");
      // Offline by construction: no gateway was consulted to decide this.
      expect(integrationMocks.requestJson).not.toHaveBeenCalled();
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "connect %s --skill-only marks the harness so its shells can be recognised",
    async (harness: Harness) => {
      const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-marker-`));
      tempHomes.push(home);
      const stateEnvPath = join(home, ".env");
      writeFileSync(stateEnvPath, "OMNESIS_GATEWAY_URL=https://gateway.example:7600\n");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run({ harness, dir: home, "skill-only": true });

      const envText = readFileSync(stateEnvPath, "utf8");
      // An installation that upgrades without re-pairing still gets the marker,
      // so `omnesis answer` from an agent shell can point at the native tool.
      expect(dotenvSetting(envText, "OMNESIS_AGENT_HARNESS")).toBe(harness);
      expect(dotenvSetting(envText, "OMNESIS_GATEWAY_URL")).toBeUndefined();
    },
  );

  it("removes the retired Hermes owner setting during a skill-only install", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-skill-only-legacy-owner-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    writeFileSync(join(home, ".env"), "OMNESIS_HERMES_OWNER_IDS=telegram:fictional-owner\n");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "hermes", dir: home, "skill-only": true });

    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("OMNESIS_HERMES_OWNER_IDS");
    expect(existsSync(skillFilePath("hermes", home))).toBe(true);
  });

  it.each(["openclaw", "hermes"] as const)(
    "connect %s --refresh replaces plugin and skill without changing the pairing",
    async (harness: Harness) => {
      const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-refresh-`));
      tempHomes.push(home);
      if (harness === "openclaw") {
        writeFileSync(join(home, "openclaw.json"), "{}\n");
      } else {
        writeFileSync(
          join(home, "config.yaml"),
          "display:\n  background_process_notifications: all\n" +
            "plugins:\n  enabled:\n    - fictional-weather\n    - omnesis-bridge\n",
        );
      }
      const credentialsPath = join(home, "omnesis", "integration.json");
      const identityPath = join(home, "omnesis", "integration-identity.json");
      mkdirSync(dirname(credentialsPath), { recursive: true });
      const credentials = JSON.stringify({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
        maxConcurrentRuns: harness === "hermes" ? 1 : 2,
      });
      const identity = `fictional-${harness}-identity\n`;
      writeFileSync(credentialsPath, `${credentials}\n`, { mode: 0o600 });
      writeFileSync(identityPath, identity, { mode: 0o600 });
      writeFileSync(
        join(home, ".env"),
        `OMNESIS_GATEWAY_URL=${ENV.OMNESIS_GATEWAY_URL}\n` +
          `OMNESIS_TOKEN=${ENV.OMNESIS_TOKEN}\n` +
          "OMNESIS_HERMES_OWNER_IDS=telegram:retired-fictional-owner\n" +
          "UNRELATED=keep\n",
        { mode: 0o600 },
      );
      const skillPath = skillFilePath(harness, home);
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, "stale skill\n");
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run({ harness, dir: home, refresh: true });

      expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
      });
      expect(readFileSync(identityPath, "utf8")).toBe(identity);
      const env = readFileSync(join(home, ".env"), "utf8");
      expect(dotenvSetting(env, "OMNESIS_TOKEN")).toBeUndefined();
      expect(dotenvSetting(env, "OMNESIS_GATEWAY_URL")).toBeUndefined();
      expect(dotenvSetting(env, "OMNESIS_AGENT_HARNESS")).toBe(harness);
      expect(env).not.toContain("OMNESIS_HERMES_OWNER_IDS");
      expect(env).toContain("UNRELATED=keep");
      expect(readFileSync(skillPath, "utf8")).toBe(buildHarnessSkill(harness, WITH_WATCHES));
      expect(integrationMocks.requestJson).toHaveBeenCalledWith("GET", "/health");
      expect(spawnSync).toHaveBeenCalled();
      if (harness === "hermes") {
        expect(existsSync(join(home, "plugins", "omnesis-integration", "adapter.py"))).toBe(true);
        expect(parseYaml(readFileSync(join(home, "config.yaml"), "utf8"))).toMatchObject({
          plugins: { enabled: ["fictional-weather"] },
        });
      }
    },
  );

  it.each(["openclaw", "hermes"] as const)(
    "connect %s --refresh preserves a legacy operational pairing while adding OAuth",
    async (harness: Harness) => {
      const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-legacy-access-upgrade-`));
      tempHomes.push(home);
      if (harness === "openclaw") writeFileSync(join(home, "openclaw.json"), "{}\n");
      else {
        writeFileSync(
          join(home, "config.yaml"),
          "display:\n  background_process_notifications: all\n",
        );
      }
      const credentialsPath = join(home, "omnesis", "integration.json");
      mkdirSync(dirname(credentialsPath), { recursive: true });
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({
          gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
          deliveryToken: PAIRING.credentials.delivery.token,
          ingestionToken: PAIRING.credentials.ingestion.token,
          maxConcurrentRuns: harness === "hermes" ? 1 : 2,
        })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        join(home, ".env"),
        upsertEnvLines("", {
          OMNESIS_TOKEN: PAIRING.credentials.management.token,
          OMNESIS_GATEWAY_URL: ENV.OMNESIS_GATEWAY_URL,
        }),
        { mode: 0o600 },
      );

      await run({ harness, dir: home, refresh: true });

      expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
      });
    },
  );

  it("re-establishes trust on refresh instead of trusting the stored pin", async () => {
    // Refresh observes the live certificate the way a first connect does and
    // re-pins what the running plugin will present, so a renewed gateway
    // certificate costs a refresh rather than a fresh pairing code. Validating
    // against the pin already in the credential file would make the one
    // failure `--refresh` cannot repair.
    const home = mkdtempSync(join(tmpdir(), "omnesis-refresh-rotation-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    const credentialsPath = seedRefreshableInstall(home, "openclaw");
    (fetchPeerCert as Mock).mockResolvedValue({
      pem: ROTATED_CERT_PEM,
      fingerprint: ROTATED_FINGERPRINT,
    });
    process.env.OMNESIS_TRUST_FINGERPRINT = ROTATED_FINGERPRINT;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "openclaw", dir: home, refresh: true });

    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(fetchPeerCert).toHaveBeenCalled();
    expect(loadIntegrationCredentials(credentialsPath).tls).toEqual({
      caPem: ROTATED_CERT_PEM,
      leafFingerprintSha256: ROTATED_FINGERPRINT,
    });
  });

  it.each([
    { refresh: false, label: "a first connect" },
    { refresh: true, label: "a refresh" },
  ])(
    "accepts the plugin's capabilities on $label when OpenClaw gates installs on consent",
    async ({ refresh }) => {
      const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-consent-"));
      tempHomes.push(home);
      writeFileSync(join(home, "openclaw.json"), "{}\n");
      if (refresh) seedRefreshableInstall(home, "openclaw");
      (openClawCapabilityConsentSupport as Mock).mockReturnValueOnce("supported");
      const logged: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
        logged.push(parts.join(" "));
      });

      await run(
        refresh
          ? { harness: "openclaw", dir: home, refresh: true }
          : {
              harness: "openclaw",
              dir: home,
              "gateway-url": ENV.OMNESIS_GATEWAY_URL,
              code: "PAIR-CODE",
            },
      );

      // Probed with the environment the install itself runs under.
      expect(openClawCapabilityConsentSupport).toHaveBeenCalledWith(
        expect.objectContaining({ OPENCLAW_STATE_DIR: home }),
      );
      expect(spawnSync).toHaveBeenCalledWith(
        "openclaw",
        [
          "plugins",
          "install",
          "--force",
          "--accept-capabilities",
          expect.stringMatching(/^npm-pack:.*\.tgz$/),
        ],
        expect.anything(),
      );
      // Only the install takes the flag; the other plugin commands never do.
      const others = (spawnSync as Mock).mock.calls.filter(
        ([command, args]) => command === "openclaw" && Array.isArray(args) && args[1] !== "install",
      );
      expect(others.length).toBeGreaterThan(0);
      for (const [, args] of others) expect(args).not.toContain("--accept-capabilities");
      expect(logged).toContain(
        "Accepted the capabilities the Omnesis integration plugin declares to OpenClaw.",
      );
    },
  );

  it.each([
    { support: "unsupported", notice: undefined },
    {
      support: "unknown",
      notice:
        "Could not ask OpenClaw whether it takes capability consent; installing without accepting capabilities.",
    },
  ])("installs without the consent flag when support is $support", async ({ support, notice }) => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-pre-consent-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    seedRefreshableInstall(home, "openclaw");
    (openClawCapabilityConsentSupport as Mock).mockReturnValueOnce(support);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(" "));
    });

    await run({ harness: "openclaw", dir: home, refresh: true });

    expect(openClawCapabilityConsentSupport).toHaveBeenCalledTimes(1);
    const install = (spawnSync as Mock).mock.calls.find(
      ([, args]) => Array.isArray(args) && args[1] === "install",
    );
    expect(install?.[1]).toEqual([
      "plugins",
      "install",
      "--force",
      expect.stringMatching(/^npm-pack:.*\.tgz$/),
    ]);
    expect(logged.join("\n")).not.toContain("Accepted the capabilities");
    expect(logged.filter((line) => line.startsWith("Could not ask OpenClaw"))).toEqual(
      notice === undefined ? [] : [notice],
    );
  });

  it("never probes OpenClaw when connecting Hermes", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-no-consent-probe-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    seedRefreshableInstall(home, "hermes");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "hermes", dir: home, refresh: true });

    expect(openClawCapabilityConsentSupport).not.toHaveBeenCalled();
  });

  it("warns when the plugin about to be installed is a different version", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-version-drift-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    seedRefreshableInstall(home, "openclaw");
    integrationMocks.requestJson.mockImplementation(async (...args: unknown[]) =>
      args[0] === "GET" && args[1] === "/health"
        ? {
            // A gateway far ahead of any plugin this checkout could pack.
            version: "999.0.0",
            capabilities: { subscriptions: true },
            status: "ok",
            compat: { watchPrivacyPolicy: 1 },
          }
        : {},
    );
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.join(" "));
    });

    await run({ harness: "openclaw", dir: home, refresh: true });

    // A warning, never a refusal: the protocol version is the only gate.
    expect(logged.join("\n")).toContain("omnesis connect openclaw --refresh");
    expect(logged.join("\n")).toContain("999.0.0");
    expect(spawnSync).toHaveBeenCalled();
  });

  it("refuses refresh before installer mutation when saved credentials are missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-refresh-missing-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    writeFileSync(join(home, ".env"), `${upsertEnvLines("", ENV)}`);

    await expect(run({ harness: "hermes", dir: home, refresh: true })).rejects.toThrow(
      /no saved Omnesis integration credentials/,
    );

    expect(spawnSync).not.toHaveBeenCalled();
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(existsSync(skillFilePath("hermes", home))).toBe(false);
  });

  it("ignores and removes stale corpus credentials from the skill environment", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-refresh-mismatch-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    mkdirSync(join(home, "omnesis"), { recursive: true });
    writeFileSync(
      join(home, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, ".env"),
      upsertEnvLines("", {
        OMNESIS_GATEWAY_URL: "https://different-gateway.example.org:7600",
        OMNESIS_TOKEN: ENV.OMNESIS_TOKEN,
      }),
      { mode: 0o600 },
    );

    await expect(run({ harness: "hermes", dir: home, refresh: true })).resolves.toBeUndefined();
    const refreshedEnv = readFileSync(join(home, ".env"), "utf8");
    expect(refreshedEnv).not.toContain("OMNESIS_TOKEN");
    expect(refreshedEnv).not.toContain("OMNESIS_GATEWAY_URL");
  });

  it("preserves credentials and the installed skill when a refresh installer fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-refresh-installer-failure-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    mkdirSync(join(home, "omnesis"), { recursive: true });
    const credentialsPath = join(home, "omnesis", "integration.json");
    const credentials = `${JSON.stringify({
      gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
      deliveryToken: PAIRING.credentials.delivery.token,
      ingestionToken: PAIRING.credentials.ingestion.token,
      managementToken: PAIRING.credentials.management.token,
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: { client_id: "client_fictional" },
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
    })}\n`;
    writeFileSync(credentialsPath, credentials, { mode: 0o600 });
    writeFileSync(join(home, ".env"), upsertEnvLines("", ENV), { mode: 0o600 });
    const skillPath = skillFilePath("hermes", home);
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "working old skill\n");
    (spawnSync as Mock).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fictional installer failure",
    });

    await expect(run({ harness: "hermes", dir: home, refresh: true })).rejects.toThrow(
      /Could not install/,
    );

    expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
      deliveryToken: PAIRING.credentials.delivery.token,
      ingestionToken: PAIRING.credentials.ingestion.token,
      managementToken: PAIRING.credentials.management.token,
      oauth: {
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
    });
    expect(readFileSync(skillPath, "utf8")).toBe("working old skill\n");
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  it("rejects refresh options that could imply re-pairing", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-refresh-option-conflict-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    await expect(
      run({ harness: "openclaw", dir: home, refresh: true, code: "PAIR-CODE" }),
    ).rejects.toThrow(/uses the existing pairing/);
    await expect(
      run({ harness: "openclaw", dir: home, refresh: true, "skill-only": true }),
    ).rejects.toThrow(/either --refresh or --skill-only/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });
});

describe("OpenClaw source artifact", () => {
  it("stamps only a clean checkout's exact commit into a local manifest", () => {
    const repository = mkdtempSync(join(tmpdir(), "omnesis-plugin-identity-"));
    tempHomes.push(repository);
    writeFileSync(join(repository, "tracked.txt"), "clean\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "omnesis-test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "release@example.com"], { cwd: repository });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    expect(integrationSourceCommit(repository)).toBe(commit);
    expect(publishManifestForLocalInstall({ version: "1.2.3" }, commit)).toMatchObject({
      version: "1.2.3",
      omnesisSourceCommit: commit,
    });

    writeFileSync(join(repository, "tracked.txt"), "dirty\n");
    expect(integrationSourceCommit(repository)).toBeUndefined();
    expect(publishManifestForLocalInstall({ version: "1.2.3" })).not.toHaveProperty(
      "omnesisSourceCommit",
    );
  });

  it.each(["absent", "stale"] as const)(
    "builds and packs current source with ambient dist %s",
    (distState) => {
      const fixture = mkdtempSync(join(process.cwd(), ".openclaw-artifact-fixture-"));
      tempHomes.push(fixture);
      const sourceRoot = join(process.cwd(), "packages", "agent-integration");
      cpSync(join(sourceRoot, "src"), join(fixture, "src"), { recursive: true });
      cpSync(join(sourceRoot, "hermes"), join(fixture, "hermes"), { recursive: true });
      for (const file of ["package.json", "openclaw-entry.mjs", "openclaw.plugin.json"]) {
        cpSync(join(sourceRoot, file), join(fixture, file));
      }
      writeFileSync(
        join(fixture, "tsconfig.json"),
        JSON.stringify({
          extends: join(process.cwd(), "tsconfig.base.json"),
          compilerOptions: { rootDir: "src" },
          include: ["src/**/*.ts"],
          exclude: ["src/**/*.test.ts"],
        }),
      );
      if (distState === "stale") {
        mkdirSync(join(fixture, "dist"), { recursive: true });
        writeFileSync(
          join(fixture, "dist", "openclaw.js"),
          "throw new Error('ambient stale artifact must not ship');\n",
        );
      }

      const artifact = prepareOpenClawInstallArchive({
        packageRoot: fixture,
        entry: join(fixture, "src", "index.ts"),
      });
      try {
        const compiled = execFileSync(
          "tar",
          ["-xOf", artifact.archivePath, "package/dist/openclaw.js"],
          { encoding: "utf8" },
        );
        expect(compiled).toContain("readSessionTranscriptEvents");
        expect(compiled).not.toContain("ambient stale artifact");
        const manifest = JSON.parse(
          execFileSync("tar", ["-xOf", artifact.archivePath, "package/package.json"], {
            encoding: "utf8",
          }),
        ) as { main: string; devDependencies?: unknown };
        expect(manifest.main).toBe("./dist/index.js");
        expect(manifest.devDependencies).toBeUndefined();
        const packed = execFileSync("tar", ["-tf", artifact.archivePath], { encoding: "utf8" });
        expect(packed).toContain("package/openclaw.plugin.json");
        // The three runtime assets ship; the adapter's own test suite sits in
        // that same directory and has no business on an operator's machine.
        expect(packed).toContain("package/hermes/adapter.py");
        expect(packed).toContain("package/hermes/plugin.yaml");
        expect(packed).toContain("package/hermes/__init__.py");
        expect(packed).not.toContain("test_adapter.py");
      } finally {
        artifact.cleanup();
      }
    },
  );
});

describe("connect credential wiring", () => {
  it("finishes OAuth when a headless user approves the short code in the portal", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-oauth-portal-code-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    let callbackLocation = "";
    integrationMocks.requestJson.mockImplementation(async (_method, path) =>
      path === "/agent-integration/oauth-binding"
        ? { binding: "execution-binding-fictional" }
        : { status: "ok", experimental: true, compat: { watchPrivacyPolicy: 1 } },
    );
    integrationMocks.authorizeOAuth
      .mockImplementationOnce(async (provider: unknown) => {
        const oauth = provider as {
          readonly redirectUrl: string;
          state(): string;
          saveClientInformation(value: Record<string, unknown>): void;
          saveCodeVerifier(value: string): void;
          redirectToAuthorization(url: URL): Promise<void>;
        };
        oauth.saveClientInformation({ client_id: "client_fictional" });
        oauth.saveCodeVerifier("pkce-verifier-fictional");
        const state = oauth.state();
        const authorization = new URL("https://gateway.example.org:7600/oauth/authorize");
        authorization.searchParams.set("client_id", "client_fictional");
        authorization.searchParams.set("redirect_uri", oauth.redirectUrl);
        authorization.searchParams.set("state", state);
        callbackLocation = `${oauth.redirectUrl}?code=code_fictional&state=${encodeURIComponent(state)}`;
        await oauth.redirectToAuthorization(authorization);
        return "REDIRECT" as const;
      })
      .mockImplementationOnce(async (provider: unknown) => {
        const oauth = provider as { saveTokens(value: Record<string, unknown>): void };
        oauth.saveTokens({
          access_token: "access_fictional",
          refresh_token: "refresh_fictional",
          token_type: "Bearer",
        });
        return "AUTHORIZED" as const;
      });
    const oauthFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/oauth/authorize") {
        return new Response(null, {
          status: 303,
          headers: { location: "/oauth/consent?request=browser-handle-fictional" },
        });
      }
      if (url.pathname === "/oauth/consent") {
        return new Response("Enter ABCD-EFGH in your portal.", { status: 200 });
      }
      if (url.pathname === "/oauth/authorize/status") {
        return Response.json({ status: "approved" });
      }
      if (url.pathname === "/oauth/authorize/complete") {
        return new Response(null, { status: 303, headers: { location: callbackLocation } });
      }
      throw new Error(`Unexpected OAuth request to ${url.pathname}`);
    });
    integrationMocks.oauthFetch.mockReturnValueOnce(oauthFetch);

    await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    expect(integrationMocks.authorizeOAuth).toHaveBeenCalledTimes(2);
    expect(oauthFetch).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/oauth/authorize/status" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      JSON.parse(readFileSync(join(home, "omnesis", "integration.json"), "utf8")),
    ).toMatchObject({
      oauth: {
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
    });
    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(1);
  });

  it("refreshes without a callback listener and recovers a busy callback port for reauthorization", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test port did not listen");
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-oauth-port-recovery-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    mkdirSync(join(home, "omnesis"), { recursive: true });
    const credentialsPath = join(home, "omnesis", "integration.json");
    writeFileSync(
      credentialsPath,
      `${JSON.stringify({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          redirectUri: `http://127.0.0.1:${address.port}/callback`,
          clientInformation: { client_id: "client_old_fictional" },
          tokens: { access_token: "access_expired", refresh_token: "refresh_expired" },
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(home, ".env"), "OMNESIS_AGENT_HARNESS=hermes\n", { mode: 0o600 });
    let callbackLocation = "";
    integrationMocks.requestJson.mockImplementation(async (_method, path) =>
      path === "/agent-integration/oauth-binding"
        ? { binding: "execution-binding-fictional" }
        : { status: "ok", experimental: true, compat: { watchPrivacyPolicy: 1 } },
    );
    const redirect = async (provider: unknown, clientId: string) => {
      const oauth = provider as {
        readonly redirectUrl: string;
        state(): string;
        saveClientInformation(value: Record<string, unknown>): void;
        saveCodeVerifier(value: string): void;
        redirectToAuthorization(url: URL): Promise<void>;
      };
      oauth.saveClientInformation({ client_id: clientId });
      oauth.saveCodeVerifier("pkce-verifier-fictional");
      const state = oauth.state();
      const authorization = new URL("https://gateway.example.org:7600/oauth/authorize");
      authorization.searchParams.set("client_id", clientId);
      authorization.searchParams.set("redirect_uri", oauth.redirectUrl);
      authorization.searchParams.set("state", state);
      callbackLocation = `${oauth.redirectUrl}?code=code_fictional&state=${encodeURIComponent(state)}`;
      await oauth.redirectToAuthorization(authorization);
      return "REDIRECT" as const;
    };
    integrationMocks.authorizeOAuth
      .mockImplementationOnce((provider) => redirect(provider, "client_old_fictional"))
      .mockImplementationOnce((provider) => redirect(provider, "client_new_fictional"))
      .mockImplementationOnce(async (provider: unknown) => {
        const oauth = provider as { saveTokens(value: Record<string, unknown>): void };
        oauth.saveTokens({
          access_token: "access_rotated",
          refresh_token: "refresh_rotated",
          token_type: "Bearer",
        });
        return "AUTHORIZED" as const;
      });
    const oauthFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/oauth/authorize") {
        return new Response(null, {
          status: 303,
          headers: { location: "/oauth/consent?request=browser-handle-port" },
        });
      }
      if (url.pathname === "/oauth/consent")
        return new Response("Enter ABCD-EFGH", { status: 200 });
      if (url.pathname === "/oauth/authorize/status") {
        return Response.json({ status: "approved" });
      }
      if (url.pathname === "/oauth/authorize/complete") {
        return new Response(null, { status: 303, headers: { location: callbackLocation } });
      }
      throw new Error(`Unexpected OAuth request to ${url.pathname}`);
    });
    integrationMocks.oauthFetch.mockReturnValueOnce(oauthFetch);
    try {
      await run({ harness: "hermes", dir: home, refresh: true });
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const persisted = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      oauth: { redirectUri: string; clientInformation: { client_id: string }; tokens: unknown };
    };
    expect(new URL(persisted.oauth.redirectUri).port).not.toBe(String(address.port));
    expect(persisted.oauth.clientInformation.client_id).toBe("client_new_fictional");
    expect(persisted.oauth.tokens).toMatchObject({ access_token: "access_rotated" });
    expect(integrationMocks.authorizeOAuth).toHaveBeenCalledTimes(3);
  });

  it("moves a busy saved callback before a first OAuth enrollment without refresh authority", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("test port did not listen");
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-oauth-first-port-"));
    tempHomes.push(home);
    mkdirSync(join(home, "omnesis"), { recursive: true });
    const credentialsPath = join(home, "omnesis", "integration.json");
    writeFileSync(
      credentialsPath,
      `${JSON.stringify({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          redirectUri: `http://127.0.0.1:${address.port}/callback`,
          clientInformation: { client_id: "client_stale_fictional" },
          tokens: {},
        },
      })}\n`,
      { mode: 0o600 },
    );
    let callbackLocation = "";
    integrationMocks.requestJson.mockImplementation(async (_method, path) =>
      path === "/agent-integration/oauth-binding"
        ? { binding: "execution-binding-fictional" }
        : { status: "ok", experimental: true, compat: { watchPrivacyPolicy: 1 } },
    );
    integrationMocks.authorizeOAuth
      .mockImplementationOnce(async (provider: unknown) => {
        const oauth = provider as {
          readonly redirectUrl: string;
          state(): string;
          saveClientInformation(value: Record<string, unknown>): void;
          saveCodeVerifier(value: string): void;
          redirectToAuthorization(url: URL): Promise<void>;
        };
        oauth.saveClientInformation({ client_id: "client_new_fictional" });
        oauth.saveCodeVerifier("pkce-verifier-fictional");
        const state = oauth.state();
        const authorization = new URL("https://gateway.example.org:7600/oauth/authorize");
        authorization.searchParams.set("client_id", "client_new_fictional");
        authorization.searchParams.set("redirect_uri", oauth.redirectUrl);
        authorization.searchParams.set("state", state);
        callbackLocation = `${oauth.redirectUrl}?code=code_fictional&state=${encodeURIComponent(state)}`;
        await oauth.redirectToAuthorization(authorization);
        return "REDIRECT" as const;
      })
      .mockImplementationOnce(async (provider: unknown) => {
        const oauth = provider as { saveTokens(value: Record<string, unknown>): void };
        oauth.saveTokens({
          access_token: "access_first_fictional",
          refresh_token: "refresh_first_fictional",
          token_type: "Bearer",
        });
        return "AUTHORIZED" as const;
      });
    integrationMocks.oauthFetch.mockReturnValueOnce(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/oauth/authorize") {
        return new Response(null, {
          status: 303,
          headers: { location: "/oauth/consent?request=browser-handle-first" },
        });
      }
      if (url.pathname === "/oauth/consent") return new Response("Enter ABCD-EFGH");
      if (url.pathname === "/oauth/authorize/status") {
        return Response.json({ status: "approved" });
      }
      if (url.pathname === "/oauth/authorize/complete") {
        return new Response(null, { status: 303, headers: { location: callbackLocation } });
      }
      throw new Error(`Unexpected OAuth request to ${url.pathname}`);
    });

    try {
      await authorizeHarness(home, "hermes", loadIntegrationCredentials(credentialsPath));
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const persisted = loadIntegrationCredentials(credentialsPath);
    expect(new URL(persisted.oauth.redirectUri).port).not.toBe(String(address.port));
    expect(persisted.oauth.clientInformation).toMatchObject({
      client_id: "client_new_fictional",
    });
    expect(persisted.oauth.tokens).toMatchObject({ access_token: "access_first_fictional" });
    expect(integrationMocks.authorizeOAuth).toHaveBeenCalledTimes(2);
  });

  it("resumes denied OAuth without re-pairing or leaking credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-oauth-denied-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    integrationMocks.authorizeOAuth.mockImplementationOnce(async (provider: unknown) => {
      const oauth = provider as {
        saveClientInformation(value: Record<string, unknown>): void;
        saveDiscoveryState(value: Record<string, unknown>): void;
        saveCodeVerifier(value: string): void;
        state(): string;
      };
      oauth.saveDiscoveryState({
        authorizationServerUrl: ENV.OMNESIS_GATEWAY_URL,
        authorizationServerMetadata: { issuer: ENV.OMNESIS_GATEWAY_URL },
      });
      oauth.saveClientInformation({ client_id: "client_retry_fictional" });
      oauth.saveCodeVerifier("latest-pkce-verifier-fictional");
      oauth.state();
      throw new Error("access_denied");
    });

    const first = await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).not.toContain(PAIRING.credentials.management.token);
    const recoveryText = readFileSync(join(home, "omnesis", "connect-recovery.json"), "utf8");
    expect(recoveryText).not.toContain(PAIRING.credentials.delivery.token);
    expect(recoveryText).not.toContain(PAIRING.credentials.ingestion.token);
    expect(recoveryText).not.toContain(PAIRING.credentials.management.token);
    expect(
      JSON.parse(readFileSync(join(home, "omnesis", "integration.json"), "utf8")),
    ).toMatchObject({
      oauth: {
        codeVerifier: "latest-pkce-verifier-fictional",
        discoveryState: { authorizationServerUrl: ENV.OMNESIS_GATEWAY_URL },
      },
    });
    expect(existsSync(join(home, ".env"))).toBe(true);

    await run({ harness: "hermes", dir: home });
    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain("OMNESIS_TOKEN");
    expect(existsSync(join(home, "omnesis", "connect-recovery.json"))).toBe(false);
  });

  it("installs against a gateway without Watches, and says so in the skill", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-no-watches-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    vi.spyOn(console, "log").mockImplementation(() => {});
    integrationMocks.requestJson.mockImplementation(async (...args: unknown[]) =>
      args[0] === "GET" && args[1] === "/health"
        ? {
            version: "0.4.0",
            status: "ok",
            experimental: false,
            capabilities: { subscriptions: false },
            compat: { watchPrivacyPolicy: 1 },
          }
        : {},
    );

    await run({
      harness: "openclaw",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    // The pairing happened: a default gateway is a perfectly good host for a
    // managed integration, it simply has no Watch runtime behind it.
    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(1);
    const skill = readFileSync(skillFilePath("openclaw", home), "utf8");
    expect(skill).toBe(buildHarnessSkill("openclaw", WITHOUT_WATCHES));
    expect(skill).not.toContain("omnesis_subscriptions");
    expect(skill).toContain("native `omnesis_answer` tool");
    expect(skill).toContain("Watches are not available on this installation");
    // The plugin reads this back to decide which tools to register, in a
    // process that registers them before it has spoken to any gateway.
    expect(
      loadIntegrationCredentials(join(home, "omnesis", "integration.json")).capabilities,
    ).toEqual({ subscriptions: false });
  });

  it("refuses a gateway too old to state the Watch privacy contract", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-old-gateway-"));
    tempHomes.push(home);
    const configPath = join(home, "openclaw.json");
    writeFileSync(configPath, "{}\n");
    integrationMocks.requestJson.mockResolvedValueOnce({
      status: "ok",
      experimental: true,
      compat: {},
    });

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/gateway must be upgraded/i);

    expect(integrationMocks.requestJson).toHaveBeenCalledWith("GET", "/health");
    expect(integrationMocks.requestJson).not.toHaveBeenCalledWith("GET", "/status");
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(readFileSync(configPath, "utf8")).toBe("{}\n");
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(existsSync(join(home, "omnesis"))).toBe(false);
    expect(existsSync(join(process.env.OMNESIS_CONFIG_DIR!, "tls", "cert.pem"))).toBe(false);
  });

  it("refuses an older gateway before refreshing harness files", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-refresh-old-gateway-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    mkdirSync(join(home, "omnesis"), { recursive: true });
    writeFileSync(
      join(home, "omnesis", "integration.json"),
      `${JSON.stringify({
        gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
        deliveryToken: PAIRING.credentials.delivery.token,
        ingestionToken: PAIRING.credentials.ingestion.token,
        managementToken: PAIRING.credentials.management.token,
        oauth: {
          redirectUri: "http://127.0.0.1:48123/callback",
          clientInformation: { client_id: "client_fictional" },
          tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
        },
        maxConcurrentRuns: 1,
      })}\n`,
    );
    writeFileSync(
      join(home, ".env"),
      `OMNESIS_GATEWAY_URL=${ENV.OMNESIS_GATEWAY_URL}\nOMNESIS_TOKEN=${ENV.OMNESIS_TOKEN}\n`,
    );
    const skillPath = skillFilePath("hermes", home);
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "existing skill\n");
    integrationMocks.requestJson.mockResolvedValueOnce({
      status: "ok",
      experimental: true,
      compat: {},
    });

    await expect(run({ harness: "hermes", dir: home, refresh: true })).rejects.toThrow(
      /gateway must be upgraded/i,
    );

    expect(readFileSync(skillPath, "utf8")).toBe("existing skill\n");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("fails certificate rotation before redeeming or writing credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-cert-rotation-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    (fetchPeerCert as Mock)
      .mockResolvedValueOnce({
        pem: "-----BEGIN CERTIFICATE-----\nYmVmb3Jl\n-----END CERTIFICATE-----\n",
        fingerprint: "a".repeat(64),
      })
      .mockResolvedValueOnce({
        pem: "-----BEGIN CERTIFICATE-----\nYWZ0ZXI=\n-----END CERTIFICATE-----\n",
        fingerprint: "b".repeat(64),
      });

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/certificate changed during setup/);

    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(existsSync(join(home, "omnesis", "integration.json"))).toBe(false);
    expect(existsSync(join(home, "omnesis", "integration-identity.json"))).toBe(false);
    expect(existsSync(join(home, "omnesis", "management.json"))).toBe(false);
    expect(existsSync(skillFilePath("openclaw", home))).toBe(false);
  });

  it("pairs OpenClaw, preserves its config, and writes every secret-bearing file as 0600", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-"));
    tempHomes.push(home);
    const configPath = join(home, "openclaw.json");
    const legacyBridgeToken = "omn_fictional_retired_bridge_secret";
    const existingConfig = JSON.stringify({
      unrelated: { keep: true },
      tools: { exec: { notifyOnExit: true } },
      skills: {
        entries: {
          omnesis: {
            env: {
              OMNESIS_INTEGRATION_CREDENTIALS: "/disclosed/integration.json",
              EXTRA: "keep",
            },
          },
        },
      },
      plugins: {
        load: {
          paths: [
            "/Users/fictional/omnesis-src/integrations/openclaw-omnesis-plugin",
            "/opt/fictional/unrelated-plugin",
          ],
        },
        entries: {
          "omnesis-bridge": {
            enabled: true,
            config: { token: legacyBridgeToken },
          },
          "omnesis-integration": {
            config: { credentialsPath: "/disclosed/integration.json" },
          },
        },
      },
    });
    writeFileSync(configPath, existingConfig, { mode: 0o644 });
    writeFileSync(
      join(home, ".env"),
      "OMNESIS_INTEGRATION_CREDENTIALS=/disclosed/integration.json\nUNRELATED=keep\n",
    );
    (spawnSync as Mock).mockImplementationOnce(() => {
      const installerConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
        string,
        unknown
      >;
      installerConfig.installerAdded = { keep: true };
      writeFileSync(configPath, `${JSON.stringify(installerConfig)}\n`);
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "openclaw",
      dir: home,
      "gateway-url": `${ENV.OMNESIS_GATEWAY_URL}/`,
      code: "PAIR-CODE",
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "openclaw",
      [
        "plugins",
        "install",
        "--force",
        expect.stringMatching(/^npm-pack:.*omnesis-openclaw-plugin-.*\.tgz$/),
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: home,
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
        }),
      }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "openclaw",
      ["plugins", "uninstall", "omnesis-bridge", "--force"],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCLAW_STATE_DIR: home,
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
        }),
      }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "openclaw",
      ["plugins", "registry", "--refresh", "--json"],
      expect.objectContaining({
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: home }),
      }),
    );
    const registryRefresh = (spawnSync as Mock).mock.calls.find(
      ([, args]) => Array.isArray(args) && args.join(" ") === "plugins registry --refresh --json",
    );
    expect(registryRefresh?.[2].env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY).toBeUndefined();
    const identity = JSON.parse(
      readFileSync(join(home, "omnesis", "integration-identity.json"), "utf8"),
    ) as { suggestedName: string };
    expect(identity.suggestedName).toMatch(/^omnesis-openclaw-[a-f0-9]{12}$/);
    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledWith(
      ENV.OMNESIS_GATEWAY_URL,
      "PAIR-CODE",
      "openclaw",
      {
        idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        maxConcurrentRuns: 2,
        suggestedName: identity.suggestedName,
        tls: {
          caPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
          leafFingerprintSha256: "a".repeat(64),
        },
      },
    );
    expect(registeredClientName()).toBe("OpenClaw");
    const credentialsPath = join(home, "omnesis", "integration.json");
    const stateEnv = readFileSync(join(home, ".env"), "utf8");
    expect(stateEnv).not.toContain("OMNESIS_TOKEN");
    expect(stateEnv).not.toContain("OMNESIS_GATEWAY_URL");
    expect(stateEnv).toContain("UNRELATED=keep");
    expect(stateEnv).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(stateEnv).not.toContain(PAIRING.credentials.management.token);
    expect(JSON.parse(readFileSync(credentialsPath, "utf8"))).toMatchObject({
      gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
      deliveryToken: PAIRING.credentials.delivery.token,
      ingestionToken: PAIRING.credentials.ingestion.token,
      managementToken: PAIRING.credentials.management.token,
      oauth: {
        clientInformation: { client_id: "client_fictional" },
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
      tls: {
        caPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
        leafFingerprintSha256: "a".repeat(64),
      },
      maxConcurrentRuns: 2,
    });
    expect(readFileSync(credentialsPath, "utf8")).toContain(PAIRING.credentials.management.token);
    expect(existsSync(join(home, "omnesis", "management.json"))).toBe(false);
    const mergedConfig = JSON.parse(readFileSync(configPath, "utf8"));
    expect(mergedConfig).toMatchObject({
      unrelated: { keep: true },
      installerAdded: { keep: true },
      skills: {
        entries: {
          omnesis: {
            env: {
              ...SKILL_ENV,
              EXTRA: "keep",
            },
          },
        },
      },
      plugins: {
        entries: {
          "omnesis-integration": {
            enabled: true,
          },
        },
      },
    });
    expect(JSON.stringify(mergedConfig)).not.toContain("credentialsPath");
    expect(JSON.stringify(mergedConfig)).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(JSON.stringify(mergedConfig)).not.toContain(legacyBridgeToken);
    expect(mergedConfig).toMatchObject({
      plugins: { load: { paths: ["/opt/fictional/unrelated-plugin"] } },
    });
    const backup = readFileSync(`${configPath}.bak-omnesis`, "utf8");
    expect(backup).toBe(retireLegacyOpenClawConfig(existingConfig));
    expect(backup).not.toContain(legacyBridgeToken);
    const skill = readFileSync(skillFilePath("openclaw", home), "utf8");
    const modelVisibleConfiguration = `${stateEnv}\n${JSON.stringify(mergedConfig)}\n${skill}`;
    expect(modelVisibleConfiguration).not.toContain(PAIRING.credentials.management.token);
    expect(modelVisibleConfiguration).not.toContain("integration.json");
    expect(modelVisibleConfiguration).not.toContain("management.json");
    expect(modelVisibleConfiguration).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    // The runtime must retain its operational management credential in the
    // private integration file, while model-visible config must neither copy
    // the bearer nor disclose that file's location.
    const shellReadableHome = readableTree(home);
    expect(shellReadableHome).toContain(PAIRING.credentials.management.token);
    expect(shellReadableHome).not.toContain("management.json");
    expect(shellReadableHome).not.toContain(legacyBridgeToken);
    for (const path of [
      join(home, ".env"),
      credentialsPath,
      join(home, "omnesis", "integration-identity.json"),
      configPath,
      `${configPath}.bak-omnesis`,
    ]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // The atomic writer stages each payload under a name private to
      // that write, so match on the shared `.tmp` suffix rather than on
      // any one name.
      expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("replays the same pairing attempt after a crash before credentials reach disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-connect-redemption-recovery-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    (writeIntegrationCredentials as Mock).mockImplementationOnce(() => {
      throw new Error("fictional process crash before credential persistence");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/fictional process crash/u);

    const journalPath = join(home, "omnesis", "connect-redemption.json");
    expect(existsSync(journalPath)).toBe(true);
    expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      pairingCode: string;
      idempotencyKey: string;
    };
    expect(journal).toMatchObject({
      pairingCode: "PAIR-CODE",
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(existsSync(join(home, "omnesis", "integration.json"))).toBe(false);

    await run({ harness: "openclaw", dir: home });

    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(2);
    const firstOptions = (redeemAgentIntegrationPairingCode as Mock).mock.calls[0][3];
    const replayOptions = (redeemAgentIntegrationPairingCode as Mock).mock.calls[1][3];
    expect(replayOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(join(home, "omnesis", "connect-recovery.json"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(home, "omnesis", "integration.json"), "utf8")),
    ).toMatchObject({ gatewayUrl: ENV.OMNESIS_GATEWAY_URL });
  });

  it("uses one explicit OpenClaw config path for validation, installation, and commit", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-custom-config-"));
    const configRoot = mkdtempSync(join(tmpdir(), "omnesis-openclaw-config-root-"));
    tempHomes.push(home, configRoot);
    const defaultConfigPath = join(home, "openclaw.json");
    const selectedConfigPath = join(configRoot, "fictional-profile.json");
    const defaultConfig = '{"mustRemain":"untouched"}\n';
    writeFileSync(defaultConfigPath, defaultConfig);
    writeFileSync(selectedConfigPath, '{"selected":true}\n');
    vi.stubEnv("OPENCLAW_CONFIG_PATH", selectedConfigPath);
    vi.stubEnv("OPENCLAW_PROFILE", "fictional-profile");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "openclaw",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    expect(readFileSync(defaultConfigPath, "utf8")).toBe(defaultConfig);
    expect(JSON.parse(readFileSync(selectedConfigPath, "utf8"))).toMatchObject({
      selected: true,
      plugins: { entries: { "omnesis-integration": { enabled: true } } },
      skills: { entries: { omnesis: { env: SKILL_ENV } } },
    });
    const openClawCalls = (spawnSync as Mock).mock.calls.filter(
      ([command]) => command === "openclaw",
    );
    expect(openClawCalls).toHaveLength(3);
    for (const [, , options] of openClawCalls) {
      expect(options.env).toMatchObject({
        OPENCLAW_STATE_DIR: home,
        OPENCLAW_CONFIG_PATH: selectedConfigPath,
        OPENCLAW_PROFILE: "fictional-profile",
      });
    }
  });

  it("updates an existing legacy OpenClaw config without creating a partial canonical config", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-legacy-config-"));
    tempHomes.push(home);
    const legacyConfigPath = join(home, "clawdbot.json");
    writeFileSync(
      legacyConfigPath,
      '{"channels":{"fictional":{"enabled":true}},"models":{"fictional":"keep"}}\n',
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "openclaw",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    expect(existsSync(join(home, "openclaw.json"))).toBe(false);
    expect(JSON.parse(readFileSync(legacyConfigPath, "utf8"))).toMatchObject({
      channels: { fictional: { enabled: true } },
      models: { fictional: "keep" },
      plugins: { entries: { "omnesis-integration": { enabled: true } } },
    });
    for (const [command, , options] of (spawnSync as Mock).mock.calls) {
      if (command === "openclaw") {
        expect(options.env.OPENCLAW_CONFIG_PATH).toBe(legacyConfigPath);
      }
    }
  });

  it("retires a stale legacy load path for activation and restores it on failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-recovery-"));
    tempHomes.push(home);
    const configPath = join(home, "openclaw.json");
    const legacyPath = "/private/tmp/openclaw-omnesis-plugin";
    const originalConfig = JSON.stringify({
      unrelated: { keep: true },
      plugins: {
        load: { paths: [legacyPath, "/opt/fictional/unrelated-plugin"] },
        entries: { "omnesis-bridge": { enabled: true } },
      },
    });
    writeFileSync(configPath, originalConfig);
    (spawnSync as Mock).mockImplementationOnce(() => {
      expect(readFileSync(configPath, "utf8")).not.toContain(legacyPath);
      return { status: 1, stdout: "", stderr: "fictional activation failure" };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/non-secret recovery marker/);

    const recoveryPath = join(home, "omnesis", "connect-recovery.json");
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(existsSync(recoveryPath)).toBe(true);

    (spawnSync as Mock).mockImplementationOnce(() => {
      expect(readFileSync(configPath, "utf8")).not.toContain(legacyPath);
      return { status: 0, stdout: "", stderr: "" };
    });
    await run({ harness: "openclaw", dir: home });

    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(1);
    expect(existsSync(recoveryPath)).toBe(false);
    const installedConfig = readFileSync(configPath, "utf8");
    expect(installedConfig).not.toContain(legacyPath);
    expect(installedConfig).toContain("/opt/fictional/unrelated-plugin");
    expect(installedConfig).toContain('"unrelated"');
  });

  const colorWarning =
    "(node:12345) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.\n" +
    "(Use `node --trace-warnings ...` to show where the warning was created)\n";

  const untrackedLegacyPlugin =
    'Plugin "omnesis-bridge" is not associated with a tracked package install. Refresh the plugin registry, then reinstall the package or run openclaw doctor before retrying.';

  it.each([
    { warning: "", absent: "Plugin not found: omnesis-bridge" },
    { warning: colorWarning, absent: "Plugin not found: omnesis-bridge" },
    { warning: "", absent: untrackedLegacyPlugin },
    { warning: colorWarning, absent: untrackedLegacyPlugin },
  ])(
    "accepts OpenClaw's no-legacy-record result $absent with runtime output $warning",
    async ({ warning, absent }) => {
      const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-fresh-registry-"));
      tempHomes.push(home);
      writeFileSync(join(home, "openclaw.json"), "{}\n");
      (spawnSync as Mock)
        .mockReset()
        .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
        .mockReturnValueOnce({
          status: 1,
          stdout: "",
          stderr: `${warning}${absent}\n`,
        })
        .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
      vi.spyOn(console, "log").mockImplementation(() => {});

      await run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      });

      expect(spawnSync).toHaveBeenCalledTimes(3);
      expect(existsSync(skillFilePath("openclaw", home))).toBe(true);
      expect(existsSync(join(home, "omnesis", "connect-recovery.json"))).toBe(false);
    },
  );

  it.each([
    {
      status: 1,
      stderr: `${colorWarning}Plugin not found: omnesis-bridge\nError: unable to write plugin registry\n`,
    },
    { status: 1, stderr: `${colorWarning}Plugin not found: unrelated-plugin\n` },
    {
      status: 1,
      stderr: untrackedLegacyPlugin.replace("omnesis-bridge", "unrelated-plugin"),
    },
    {
      status: 1,
      stderr:
        'Plugin "omnesis-bridge" has no authoritative package-owner metadata. Refresh the plugin registry, then reinstall the package or run openclaw doctor before retrying.',
    },
    {
      status: 1,
      stderr:
        "(node:12345) Warning: unable to read plugin registry\nPlugin not found: omnesis-bridge\n",
    },
    { status: 2, stderr: `${colorWarning}Plugin not found: omnesis-bridge\n` },
    { status: null, stderr: null, error: new Error("spawn openclaw ENOENT") },
  ])("refuses an ambiguous or unrelated legacy retirement diagnostic %j", async (result) => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-retirement-error-"));
    tempHomes.push(home);
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    (spawnSync as Mock)
      .mockReset()
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ stdout: "", ...result });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/Could not retire the legacy OpenClaw Omnesis registry entry/);

    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(existsSync(join(home, "omnesis", "connect-recovery.json"))).toBe(true);
  });

  it("pairs Hermes, removes stale duplicate env values, and leaves OpenClaw config absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-"));
    tempHomes.push(home);
    // "concise": what Hermes's own installer writes since v0.21.
    writeFileSync(
      join(home, "config.yaml"),
      "plugins:\n  enabled:\n    - fictional-weather\n    - omnesis-bridge\n" +
        "display:\n  background_process_notifications: concise\n",
    );
    const legacyPlugin = join(home, "plugins", "omnesis-bridge");
    mkdirSync(legacyPlugin, { recursive: true });
    writeFileSync(join(legacyPlugin, "plugin.yaml"), "name: omnesis-bridge\n");
    writeFileSync(
      join(home, ".env"),
      "OMNESIS_TOKEN=old-first\nUNRELATED=keep\nOMNESIS_TOKEN=old-last\n" +
        "OMNESIS_INTEGRATION_CREDENTIALS=/disclosed/integration.json\n",
    );
    (spawnSync as Mock).mockImplementationOnce(() => {
      // Simulate the real `plugins enable` mutation. The migration must
      // clean the legacy bridge from this post-install state, not restore the
      // pre-install snapshot and erase the replacement plugin.
      writeFileSync(
        join(home, "config.yaml"),
        "plugins:\n  enabled:\n    - fictional-weather\n    - omnesis-bridge\n" +
          "    - omnesis-integration\n" +
          "  entries:\n    omnesis-integration:\n      allow_tool_override: false\n" +
          "installer_preserved: true\n" +
          "display:\n  background_process_notifications: all\n",
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "hermes",
      ["plugins", "enable", "--no-allow-tool-override", "omnesis-integration"],
      expect.objectContaining({
        env: expect.objectContaining({ HERMES_HOME: home }),
      }),
    );
    expect(registeredClientName()).toBe("Hermes");
    const env = readFileSync(join(home, ".env"), "utf8");
    expect(env).not.toContain("OMNESIS_TOKEN");
    expect(env).not.toContain("OMNESIS_GATEWAY_URL");
    expect(env).not.toContain("OMNESIS_HERMES_OWNER_IDS");
    expect(env).not.toContain("OMNESIS_INTEGRATION_CREDENTIALS");
    expect(env).not.toContain(PAIRING.credentials.management.token);
    expect(env).toContain("UNRELATED=keep");
    expect(
      JSON.parse(readFileSync(join(home, "omnesis", "integration.json"), "utf8")),
    ).toMatchObject({
      gatewayUrl: ENV.OMNESIS_GATEWAY_URL,
      deliveryToken: PAIRING.credentials.delivery.token,
      ingestionToken: PAIRING.credentials.ingestion.token,
      managementToken: PAIRING.credentials.management.token,
      oauth: {
        clientInformation: { client_id: "client_fictional" },
        tokens: { access_token: "access_fictional", refresh_token: "refresh_fictional" },
      },
      tls: {
        caPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
        leafFingerprintSha256: "a".repeat(64),
      },
      maxConcurrentRuns: 1,
    });
    expect(existsSync(join(home, "omnesis", "management.json"))).toBe(false);
    const skill = readFileSync(skillFilePath("hermes", home), "utf8");
    expect(`${env}\n${skill}`).not.toContain("integration.json");
    expect(`${env}\n${skill}`).not.toContain("management.json");
    expect(readableTree(home)).toContain(PAIRING.credentials.management.token);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "plugins", "omnesis-integration", "adapter.py"))).toBe(true);
    expect(existsSync(legacyPlugin)).toBe(false);
    expect(
      existsSync(join(home, "omnesis", "retired-plugins", "omnesis-bridge", "plugin.yaml")),
    ).toBe(true);
    expect(parseYaml(readFileSync(join(home, "config.yaml"), "utf8"))).toMatchObject({
      plugins: {
        enabled: ["fictional-weather", "omnesis-integration"],
        entries: { "omnesis-integration": { allow_tool_override: false } },
      },
      installer_preserved: true,
    });
    expect(existsSync(join(home, "openclaw.json"))).toBe(false);
  });

  it("keeps legacy Hermes working on activation failure and resumes from durable credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-recovery-"));
    tempHomes.push(home);
    const configPath = join(home, "config.yaml");
    writeFileSync(
      configPath,
      "plugins:\n  enabled:\n    - omnesis-bridge\n" +
        "display:\n  background_process_notifications: all\n",
    );
    const legacyPlugin = join(home, "plugins", "omnesis-bridge");
    mkdirSync(legacyPlugin, { recursive: true });
    writeFileSync(join(legacyPlugin, "plugin.yaml"), "name: omnesis-bridge\n");
    (spawnSync as Mock).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fictional enable failure",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/non-secret recovery marker/);

    const recoveryPath = join(home, "omnesis", "connect-recovery.json");
    expect(existsSync(recoveryPath)).toBe(true);
    expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(recoveryPath, "utf8")).not.toContain(PAIRING.credentials.delivery.token);
    expect(readFileSync(join(home, "omnesis", "integration.json"), "utf8")).toContain(
      PAIRING.credentials.ingestion.token,
    );
    expect(readFileSync(join(home, ".env"), "utf8")).not.toContain(
      PAIRING.credentials.management.token,
    );
    expect(existsSync(legacyPlugin)).toBe(true);
    expect(readFileSync(configPath, "utf8")).toContain("omnesis-bridge");
    expect(existsSync(skillFilePath("hermes", home))).toBe(false);

    (spawnSync as Mock).mockImplementationOnce(() => {
      writeFileSync(
        configPath,
        "plugins:\n  enabled:\n    - omnesis-bridge\n    - omnesis-integration\n" +
          "  entries:\n    omnesis-integration:\n      allow_tool_override: false\n" +
          "display:\n  background_process_notifications: all\n",
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    await run({ harness: "hermes", dir: home });

    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledTimes(1);
    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(legacyPlugin)).toBe(false);
    expect(
      existsSync(join(home, "omnesis", "retired-plugins", "omnesis-bridge", "plugin.yaml")),
    ).toBe(true);
    expect(parseYaml(readFileSync(configPath, "utf8"))).toMatchObject({
      plugins: {
        enabled: ["omnesis-integration"],
        entries: { "omnesis-integration": { allow_tool_override: false } },
      },
    });
    expect(existsSync(skillFilePath("hermes", home))).toBe(true);
  });

  it("retires a legacy Hermes plugin that appears while a recovery is pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-recovery-race-"));
    tempHomes.push(home);
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, "display:\n  background_process_notifications: all\n");
    (spawnSync as Mock).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "fictional enable failure",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/non-secret recovery marker/);

    const legacyPlugin = join(home, "plugins", "omnesis-bridge");
    mkdirSync(legacyPlugin, { recursive: true });
    writeFileSync(join(legacyPlugin, "plugin.yaml"), "name: omnesis-bridge\n");
    writeFileSync(configPath, "plugins:\n  enabled:\n    - omnesis-bridge\n");

    (spawnSync as Mock).mockImplementationOnce(() => {
      writeFileSync(
        configPath,
        "plugins:\n  enabled:\n    - omnesis-bridge\n    - omnesis-integration\n" +
          "  entries:\n    omnesis-integration:\n      allow_tool_override: false\n" +
          "concurrent_setting: keep\n",
      );
      return { status: 0, stdout: "", stderr: "" };
    });
    await run({ harness: "hermes", dir: home });

    expect(parseYaml(readFileSync(configPath, "utf8"))).toMatchObject({
      plugins: {
        enabled: ["omnesis-integration"],
        entries: { "omnesis-integration": { allow_tool_override: false } },
      },
      concurrent_setting: "keep",
    });
    expect(existsSync(legacyPlugin)).toBe(false);
    expect(
      existsSync(join(home, "omnesis", "retired-plugins", "omnesis-bridge", "plugin.yaml")),
    ).toBe(true);
  });

  it("removes the retired Hermes owner setting during a full reconnect", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-retired-owner-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    writeFileSync(
      join(home, ".env"),
      "UNRELATED=keep\nOMNESIS_HERMES_OWNER_IDS=telegram:fictional-owner\n",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });
    const cleared = readFileSync(join(home, ".env"), "utf8");
    expect(cleared).not.toContain("OMNESIS_HERMES_OWNER_IDS");
    expect(cleared).toContain("UNRELATED=keep");
  });

  it("uses Hermes' installation-local executable when it is not on PATH", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-local-bin-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    const localHermes = join(home, "hermes-agent", "venv", "bin", "hermes");
    mkdirSync(dirname(localHermes), { recursive: true });
    writeFileSync(localHermes, "#!/bin/sh\n", { mode: 0o700 });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
    });

    expect(spawnSync).toHaveBeenCalledWith(
      localHermes,
      ["plugins", "enable", "--no-allow-tool-override", "omnesis-integration"],
      expect.objectContaining({
        env: expect.objectContaining({ HERMES_HOME: home }),
      }),
    );
  });

  it("does not write credentials when the gateway rejects an elevated bundle", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-extra-scope-"));
    tempHomes.push(home);
    (redeemAgentIntegrationPairingCode as Mock).mockRejectedValue(
      new CliError("Gateway returned a malformed pairing response.", 1),
    );

    await expect(
      run({
        harness: "openclaw",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/malformed pairing response/);

    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(existsSync(join(home, "omnesis", "integration.json"))).toBe(false);
    expect(existsSync(join(home, "omnesis", "management.json"))).toBe(false);
    expect(existsSync(skillFilePath("openclaw", home))).toBe(false);
  });

  it.each([
    {
      config: "display: { background_process_notifications: error }\n",
      env: "",
    },
    {
      config: "display:\n  background_process_notifications: all\n",
      env: "HERMES_BACKGROUND_NOTIFICATIONS=off\nUNRELATED=keep\n",
    },
  ])(
    "rejects Hermes notification settings before redeeming or writing",
    async ({ config, env }) => {
      const home = mkdtempSync(join(tmpdir(), "omnesis-hermes-notifications-"));
      tempHomes.push(home);
      writeFileSync(join(home, "config.yaml"), config);
      if (env) writeFileSync(join(home, ".env"), env);

      await expect(
        run({
          harness: "hermes",
          dir: home,
          "gateway-url": ENV.OMNESIS_GATEWAY_URL,
          code: "PAIR-CODE",
        }),
      ).rejects.toThrow(/must be "concise", "all" or "result"/);

      expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
      expect(existsSync(skillFilePath("hermes", home))).toBe(false);
      expect(existsSync(join(home, ".env")) ? readFileSync(join(home, ".env"), "utf8") : "").toBe(
        env,
      );
    },
  );

  it("rejects missing non-interactive pairing inputs without writing anything", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-connect-missing-input-"));
    tempHomes.push(home);

    await expect(run({ harness: "openclaw", dir: home })).rejects.toThrow(
      /needs --gateway-url and --code/,
    );

    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(existsSync(skillFilePath("openclaw", home))).toBe(false);
  });
});

describe("connect --print-home", () => {
  it("answers where the harness lives without touching it", async () => {
    // The caller that most needs the answer is one deciding whether to connect
    // at all, so it is answered for a directory that does not exist yet.
    const home = join(mkdtempSync(join(tmpdir(), "omnesis-print-home-")), "not-created-yet");
    tempHomes.push(dirname(home));
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "openclaw", dir: home, "print-home": true });

    // Exactly one line, because a caller reads the whole answer as a path.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(home);
    expect(existsSync(home)).toBe(false);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(ensureGatewayTrust).not.toHaveBeenCalled();
  });

  it("refuses to resolve a path for a run that also asked to connect", async () => {
    // Printing and connecting are two different things to want; taking the
    // cheaper one silently would look like a connect that did nothing.
    const home = mkdtempSync(join(tmpdir(), "omnesis-print-home-acting-"));
    tempHomes.push(home);

    await expect(
      run({ harness: "openclaw", dir: home, "print-home": true, code: "PAIR-CODE" }),
    ).rejects.toThrow(/--print-home only resolves a path; drop --code/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  it("treats a flag that was passed as false as not passed at all", async () => {
    // `--no-refresh` and an unset boolean arrive the same way; neither is a
    // request to connect, so neither should block the path from being printed.
    const home = mkdtempSync(join(tmpdir(), "omnesis-print-home-false-"));
    tempHomes.push(home);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "openclaw", dir: home, "print-home": true, refresh: false });

    expect(logged).toHaveBeenCalledWith(home);
  });

  it("applies the harness's own resolution rules rather than a caller's guess", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-print-home-legacy-"));
    tempHomes.push(root);
    // OpenClaw keeps its state in `.clawdbot` on an installation old enough to
    // predate the rename, and `.openclaw` on every other one.
    mkdirSync(join(root, ".clawdbot"), { recursive: true });
    vi.stubEnv("OPENCLAW_HOME", root);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    await run({ harness: "openclaw", "print-home": true });

    expect(logged).toHaveBeenCalledWith(join(root, ".clawdbot"));
  });
});

describe("connect --trust-fingerprint", () => {
  /** A Hermes installation a fresh connect can complete against. */
  function seedHermesHome(): string {
    const home = mkdtempSync(join(tmpdir(), "omnesis-connect-pin-"));
    tempHomes.push(home);
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    return home;
  }

  /** The fingerprint the mocked gateway certificate carries by default. */
  const PRESENTED = "a".repeat(64);

  /**
   * Make the mocked gateway present a real certificate, and answer with its
   * fingerprint. A verified certificate is saved and added to this process's
   * CA store, which the suite's placeholder PEM cannot survive.
   */
  function presentRealCertificate(): string {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-connect-cert-"));
    tempHomes.push(directory);
    const certPath = join(directory, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        certPath,
        "-days",
        "3",
        "-nodes",
        "-subj",
        "/CN=fictional-connect-gateway",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const pem = readFileSync(certPath, "utf8");
    const fingerprint = createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
    (fetchPeerCert as Mock).mockResolvedValue({ pem, fingerprint });
    return fingerprint;
  }

  it("binds the pairing to the certificate it verified", async () => {
    // The pin has to govern the connection that carries the single-use code,
    // not merely a probe taken before it. Passing the fingerprint the gateway
    // presents is what a kept promise looks like from here.
    const home = seedHermesHome();
    const presented = presentRealCertificate();

    await run({
      harness: "hermes",
      dir: home,
      "gateway-url": ENV.OMNESIS_GATEWAY_URL,
      code: "PAIR-CODE",
      "trust-fingerprint": `sha256:${presented}`,
    });

    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledWith(
      ENV.OMNESIS_GATEWAY_URL,
      "PAIR-CODE",
      "hermes",
      expect.objectContaining({
        tls: expect.objectContaining({ leafFingerprintSha256: presented }),
      }),
    );
  });

  it("refuses a certificate the pin does not name, before spending the code", async () => {
    // OMNESIS_TRUST_FINGERPRINT is set to the presented fingerprint by this
    // suite's setup, and would trust this gateway on sight. A pin outranks it.
    const home = seedHermesHome();

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
        "trust-fingerprint": `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toThrow(/fingerprint mismatch/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    expect(existsSync(join(home, "omnesis", "integration.json"))).toBe(false);
  });

  it("pins a refresh too, which re-establishes trust the way a first connect does", async () => {
    const home = seedHermesHome();
    seedRefreshableInstall(home, "hermes");

    await expect(
      run({
        harness: "hermes",
        dir: home,
        refresh: true,
        "trust-fingerprint": `sha256:${"c".repeat(64)}`,
      }),
    ).rejects.toThrow(/fingerprint mismatch/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  it("refuses an empty value rather than falling back to trust on first sight", async () => {
    const home = seedHermesHome();

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
        "trust-fingerprint": "",
      }),
    ).rejects.toThrow(/not a SHA-256 certificate fingerprint/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a SHA-256 fingerprint, before anything is dialled", async () => {
    const home = seedHermesHome();

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
        "trust-fingerprint": "sha256:beef",
      }),
    ).rejects.toThrow(CliError);
    expect(fetchPeerCert).not.toHaveBeenCalled();
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  /**
   * A pending redemption journal, written the way a crash mid-connect writes
   * one: the code has been minted and may already be spent, so the resume
   * reuses the certificate the journal recorded rather than observing one.
   */
  async function seedRedemptionJournal(home: string): Promise<string> {
    (writeIntegrationCredentials as Mock).mockImplementationOnce(() => {
      throw new Error("fictional process crash before credential persistence");
    });
    await expect(
      run({
        harness: "hermes",
        dir: home,
        "gateway-url": ENV.OMNESIS_GATEWAY_URL,
        code: "PAIR-CODE",
      }),
    ).rejects.toThrow(/fictional process crash/u);
    const journalPath = join(home, "omnesis", "connect-redemption.json");
    expect(existsSync(journalPath)).toBe(true);
    (redeemAgentIntegrationPairingCode as Mock).mockClear();
    return journalPath;
  }

  it("checks a pin brought to a resume against the certificate the journal recorded", async () => {
    const home = seedHermesHome();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await seedRedemptionJournal(home);

    await run({ harness: "hermes", dir: home, "trust-fingerprint": `sha256:${PRESENTED}` });

    expect(redeemAgentIntegrationPairingCode).toHaveBeenCalledWith(
      ENV.OMNESIS_GATEWAY_URL,
      "PAIR-CODE",
      "hermes",
      expect.objectContaining({
        tls: expect.objectContaining({ leafFingerprintSha256: PRESENTED }),
      }),
    );
  });

  it("refuses a resume whose journal names another certificate, replaying nothing", async () => {
    const home = seedHermesHome();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const journalPath = await seedRedemptionJournal(home);

    await expect(
      run({ harness: "hermes", dir: home, "trust-fingerprint": `sha256:${"e".repeat(64)}` }),
    ).rejects.toThrow(/recorded a different gateway certificate/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
    // The journal survives, so the resume can be retried without the pin or
    // with the right one; the code it holds is not thrown away by a typo.
    expect(existsSync(journalPath)).toBe(true);
  });

  it("says so when the journal has no certificate to check a pin against", async () => {
    // A plaintext gateway records no TLS material, so the pin is not merely
    // unmatched — there is nothing on that transport that could match it.
    const home = seedHermesHome();
    mkdirSync(join(home, "omnesis"), { recursive: true });
    writeFileSync(
      join(home, "omnesis", "connect-redemption.json"),
      `${JSON.stringify({
        version: 1,
        harness: "hermes",
        gatewayUrl: "http://127.0.0.1:7600",
        identity: {
          version: 1,
          harness: "hermes",
          suggestedName: `omnesis-hermes-${"0".repeat(12)}`,
        },
        pairingCode: "PAIR-CODE",
        idempotencyKey: "a".repeat(43),
        maxConcurrentRuns: 1,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      run({ harness: "hermes", dir: home, "trust-fingerprint": `sha256:${PRESENTED}` }),
    ).rejects.toThrow(/has no certificate to verify/);
    expect(redeemAgentIntegrationPairingCode).not.toHaveBeenCalled();
  });

  it("refuses a pin on a run that reaches no gateway to verify", async () => {
    const home = seedHermesHome();

    await expect(
      run({
        harness: "hermes",
        dir: home,
        "skill-only": true,
        "trust-fingerprint": `sha256:${"d".repeat(64)}`,
      }),
    ).rejects.toThrow(/--skill-only reaches no gateway/);
  });
});

describe("connect loads the plugin it installed", () => {
  /** A refreshable installation of `harness`, with the config file its checks read. */
  function refreshableHome(harness: Harness, { hermesVenv = false } = {}): string {
    const home = mkdtempSync(join(tmpdir(), `omnesis-${harness}-reload-`));
    tempHomes.push(home);
    if (harness === "openclaw") {
      writeFileSync(join(home, "openclaw.json"), "{}\n");
    } else {
      writeFileSync(
        join(home, "config.yaml"),
        "display:\n  background_process_notifications: all\n",
      );
    }
    if (hermesVenv) {
      const venv = join(home, "hermes-agent", "venv", "bin");
      mkdirSync(venv, { recursive: true });
      writeFileSync(join(venv, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    seedRefreshableInstall(home, harness);
    return home;
  }

  function captureLog(): () => string {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return () => lines.join("\n");
  }

  const streamed = () =>
    harnessCommands.run.mock.calls.filter(([, mode]) => mode === "inherit").map(([spec]) => spec);
  const captured = () =>
    harnessCommands.run.mock.calls.filter(([, mode]) => mode === "capture").map(([spec]) => spec);

  it("--yes restarts OpenClaw in the home it installed into, then reports the skill ready", async () => {
    const home = refreshableHome("openclaw");
    const output = captureLog();

    await run({ harness: "openclaw", dir: home, refresh: true, yes: true });

    const [restart] = streamed();
    expect(restart?.args).toEqual(["gateway", "restart"]);
    expect(restart?.env).toMatchObject({
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: join(home, "openclaw.json"),
    });
    expect(captured().map((spec) => spec.args)).toEqual([["skills", "check", "--json"]]);
    expect(output()).toContain("Restarted OpenClaw with the new plugin.");
    expect(output()).toContain("OpenClaw reports the omnesis skill ready.");
    expect(output()).not.toContain("Verify with");
  });

  it("--yes restarts Hermes through the executable in its home", async () => {
    const home = refreshableHome("hermes", { hermesVenv: true });
    const output = captureLog();

    await run({ harness: "hermes", dir: home, refresh: true, yes: true });

    const [restart] = streamed();
    expect(restart?.command).toBe(join(home, "hermes-agent", "venv", "bin", "hermes"));
    expect(restart?.env).toMatchObject({ HERMES_HOME: home });
    expect(captured()[0]?.args).toEqual(["skills", "list", "--source", "local"]);
    expect(output()).toContain("Hermes reports the omnesis skill ready.");
    expect(output()).toContain("new session");
  });

  it("without a terminal or --yes, names the restart instead of running it", async () => {
    const home = refreshableHome("openclaw");
    const output = captureLog();

    await run({ harness: "openclaw", dir: home, refresh: true });

    expect(streamed()).toEqual([]);
    expect(output()).toMatch(/Restart openclaw to load the refreshed plugin .*gateway restart/u);
    // The skill is still checked: whether it is ready does not wait on the restart.
    expect(captured()).toHaveLength(1);
  });

  it("--no-restart names the restart even under --yes", async () => {
    const home = refreshableHome("hermes");
    const output = captureLog();

    await run({ harness: "hermes", dir: home, refresh: true, yes: true, restart: false });

    expect(streamed()).toEqual([]);
    expect(output()).toContain("hermes gateway restart");
  });

  it("--skill-only changes no plugin, so it restarts nothing", async () => {
    const home = refreshableHome("openclaw");
    const output = captureLog();

    await run({ harness: "openclaw", dir: home, "skill-only": true, yes: true });

    expect(streamed()).toEqual([]);
    expect(output()).not.toContain("Restart openclaw");
    expect(output()).toContain("OpenClaw reports the omnesis skill ready.");
  });

  it("a restart that fails leaves the connect done and says what to run", async () => {
    const home = refreshableHome("openclaw");
    const output = captureLog();
    harnessCommands.run.mockImplementation(async (_spec, mode) =>
      mode === "inherit"
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: READY_SKILL_REPORT.openclaw },
    );

    await run({ harness: "openclaw", dir: home, refresh: true, yes: true });

    expect(output()).toContain("Could not restart openclaw");
    expect(output()).toMatch(/Restart openclaw to load the refreshed plugin .*gateway restart/u);
  });

  it("a skill the harness does not report ready is said, with the command that shows why", async () => {
    const home = refreshableHome("openclaw");
    const output = captureLog();
    harnessCommands.run.mockImplementation(async (_spec, mode) => ({
      code: 0,
      stdout: mode === "capture" ? '{"eligible":[],"disabled":["omnesis"]}' : "",
    }));

    await run({ harness: "openclaw", dir: home, refresh: true, yes: true });

    expect(output()).toContain("it is disabled in OpenClaw's config");
    expect(output()).toContain("openclaw skills info omnesis");
    expect(output()).not.toContain("new session");
  });
});
