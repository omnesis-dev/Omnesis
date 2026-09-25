// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Strict, read-only preflight and printable plan for source→package migration. */

import { constants, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  rebindServiceExecutable,
  serviceConfigDir,
  serviceGatewayBind,
  serviceGatewayPort,
} from "../service/rebind.js";
import { CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import {
  CLI_PACKAGE,
  detectInstallMethod,
  formatCommandSpec,
  isResolvedVersion,
  npmViewVersionSpec,
  parseSourceApplyState,
  sourceHeadSpec,
  sourceManagedSpec,
  sourceRefShaSpec,
  sourceStatusSpec,
  UPDATE_STATE_FILE,
  type CommandSpec,
  type HostRoles,
} from "./detect.js";
import {
  canonicalPackageRoot,
  captureDirectoryIdentity,
  captureOptionalRegularFile,
  captureOwnedSourceLauncher,
  captureRegularFile,
  type FileIdentity,
  type FileSnapshot,
} from "./package-migration-files.js";
import type { ServiceComponent } from "@omnesis/core";
import type {
  MigrationRunControl,
  MigrationRunOutcome,
  MigrationRunner,
  SourceToPackageDeps,
  SourceToPackageOptions,
} from "./package-migration-types.js";

export interface UnitChange {
  component: ServiceComponent;
  path: string;
  before: string;
  after: string;
  identity: FileIdentity;
}

export interface MigrationPlan {
  rootDir: string;
  rootIdentity: FileIdentity;
  version: string;
  prefix: string;
  packageExecutable: string;
  launcherPath: string;
  launcherBefore: string;
  launcherAfter: string;
  launcherIdentity: FileIdentity;
  unitChanges: UnitChange[];
  packagePreexisting: boolean;
  gatewayPort: number;
  gatewayBind: string;
  gatewayEnv: { path: string; snapshot: FileSnapshot | null } | null;
}

async function assertServiceDefinition(
  component: ServiceComponent,
  path: string,
  sourceRoot: string,
  deps: SourceToPackageDeps,
): Promise<void> {
  const definition = await deps.supervisor.inspectDefinition(component);
  if (
    !isAbsolute(definition.fragmentPath) ||
    canonicalPath(definition.fragmentPath) !== canonicalPath(path)
  ) {
    throw new CliError(
      `The effective ${component} service fragment is not the installer-managed unit at ${path}.`,
      EXIT_USER_ERROR,
    );
  }
  if (definition.overridePaths.length > 0) {
    throw new CliError(
      `The ${component} service has unsupported overrides: ${definition.overridePaths.join(", ")}. Remove them before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  if (definition.inheritedEnvironment.length > 0) {
    throw new CliError(
      `The ${component} service inherits ${definition.inheritedEnvironment.join(", ")} from its service manager. Move those values into ${deps.configDir}/.env before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  const normalizedEnvironment = definition.inheritedEnvironmentText
    .replaceAll(`'"'"'`, "'")
    .replace(/\\x([0-9a-f]{2})/giu, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\([\\ '"$`])/gu, "$1");
  if (
    definition.inheritedEnvironmentText.includes(sourceRoot) ||
    normalizedEnvironment.includes(sourceRoot)
  ) {
    throw new CliError(
      `The ${component} service-manager environment still references the source checkout. Remove that reference before migrating.`,
      EXIT_USER_ERROR,
    );
  }
}

/** Revalidate service-manager state that npm and the unit snapshots cannot protect. */
export async function assertMigrationServiceDefinitions(
  plan: MigrationPlan,
  deps: SourceToPackageDeps,
): Promise<void> {
  for (const unit of plan.unitChanges) {
    await assertServiceDefinition(unit.component, unit.path, plan.rootDir, deps);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Stable PATH entry that also preserves the prefix for later package updates. */
export function packageLauncher(prefix: string, packageExecutable: string): string {
  return `#!/bin/sh
NPM_CONFIG_PREFIX=${shellQuote(prefix)}
export NPM_CONFIG_PREFIX
exec ${shellQuote(packageExecutable)} "$@"
`;
}

export function packageInstallSpec(
  version: string,
  prefix: string,
  registry?: string,
): CommandSpec {
  const args = ["install", "-g", `${CLI_PACKAGE}@${version}`, "--prefix", prefix];
  if (registry) args.push("--registry", registry);
  return { command: "npm", args };
}

export function packageUninstallSpec(prefix: string): CommandSpec {
  return { command: "npm", args: ["uninstall", "-g", CLI_PACKAGE, "--prefix", prefix] };
}

export function throwMigrationCommandFailure(label: string, outcome: MigrationRunOutcome): never {
  const detail = outcome.stdout.trim();
  throw new CliError(
    `${label} failed${detail ? `: ${detail}` : ` (exit ${outcome.code})`}`,
    EXIT_FAILURE,
  );
}

export async function captureMigrationCommand(
  run: MigrationRunner,
  spec: CommandSpec,
  label: string,
  control?: MigrationRunControl,
): Promise<string> {
  const outcome = await run(spec, "capture", control);
  if (outcome.code !== 0) throwMigrationCommandFailure(label, outcome);
  return outcome.stdout.trim();
}

export function assertCompletedSourceState(configDir: string, rootDir: string, head: string): void {
  const path = join(configDir, UPDATE_STATE_FILE);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CliError(
      `The source ownership record is missing at ${path}. Re-run the source installer before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new CliError(
      `The source ownership record at ${path} is not safe to read.`,
      EXIT_USER_ERROR,
    );
  }
  const state = parseSourceApplyState(readFileSync(path, "utf8"));
  if (
    state?.method !== "source" ||
    state.phase !== "complete" ||
    realpathSync(state.rootDir) !== rootDir ||
    state.commit !== head
  ) {
    throw new CliError(
      "The completed source ownership record does not match this checkout and HEAD.",
      EXIT_USER_ERROR,
    );
  }
}

function assertSupportedRoles(roles: HostRoles): void {
  for (const component of ["gateway", "collector"] as const) {
    const role = roles[component];
    if (role.conflictingServices && role.conflictingServices.length > 0) {
      throw new CliError(
        `Cannot migrate this host while ${component} has additional service layouts: ${role.conflictingServices.join(", ")}.`,
        EXIT_USER_ERROR,
      );
    }
    if (role.present && !role.supervised) {
      throw new CliError(
        `Cannot migrate this host while its ${component} uses an unsupported manual, named, or hardened service layout.`,
        EXIT_USER_ERROR,
      );
    }
  }
}

function isWithin(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return resolve(realpathSync(existing), relative(existing, absolute));
}

function pathEntry(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError(`Cannot inspect package path ${path}.`, EXIT_USER_ERROR);
  }
}

function assertPackageDirectory(path: string): boolean {
  const entry = pathEntry(path);
  if (!entry) return false;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new CliError(`Package path ${path} must be a real directory.`, EXIT_USER_ERROR);
  }
  return true;
}

async function selectPrefix(deps: SourceToPackageDeps, rootDir: string): Promise<string> {
  const outcome = await deps.run({ command: "npm", args: ["prefix", "-g"] }, "capture");
  const reported = outcome.code === 0 ? outcome.stdout.trim() : "";
  const canonicalReported = reported && isAbsolute(reported) ? canonicalPath(reported) : "";
  const launcherPath = canonicalPath(join(deps.homeDir, ".local", "bin", "omnesis"));
  if (
    canonicalReported &&
    !isWithin(canonicalReported, rootDir) &&
    canonicalPath(join(canonicalReported, "bin", "omnesis")) !== launcherPath &&
    (
      await Promise.all(
        ["", "bin", "lib", "lib/node_modules", `lib/node_modules/${CLI_PACKAGE}`].map(
          (relativePath) => deps.canWrite(join(canonicalReported, relativePath)),
        ),
      )
    ).every(Boolean)
  ) {
    return canonicalReported;
  }
  const fallback = canonicalPath(join(deps.homeDir, ".npm-global"));
  if (isWithin(fallback, rootDir)) {
    throw new CliError(
      `The package prefix ${fallback} is inside the source checkout; choose a safe npm prefix before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  if (canonicalPath(join(fallback, "bin", "omnesis")) === launcherPath) {
    throw new CliError(
      `The fallback package prefix would overwrite the source launcher at ${launcherPath}. Choose a safe npm prefix before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  return fallback;
}

async function assertExistingPackageSafe(
  prefix: string,
  packageExecutable: string,
  version: string,
  deps: SourceToPackageDeps,
): Promise<boolean> {
  assertPackageDirectory(join(prefix, "bin"));
  const libExists = assertPackageDirectory(join(prefix, "lib"));
  const modulesRoot = join(prefix, "lib", "node_modules");
  const modulesExist = libExists && assertPackageDirectory(modulesRoot);
  const lexicalPackageRoot = join(prefix, "lib", "node_modules", CLI_PACKAGE);
  const packageRootEntry = modulesExist ? pathEntry(lexicalPackageRoot) : null;
  if (packageRootEntry?.isSymbolicLink() || (packageRootEntry && !packageRootEntry.isDirectory())) {
    throw new CliError(
      `Package path ${lexicalPackageRoot} must be a real directory.`,
      EXIT_USER_ERROR,
    );
  }
  if (!pathEntry(packageExecutable)) {
    if (packageRootEntry) {
      throw new CliError(
        `A partial package install already exists at ${lexicalPackageRoot}; repair or remove it before migrating.`,
        EXIT_USER_ERROR,
      );
    }
    return false;
  }
  let real: string;
  try {
    real = realpathSync(packageExecutable);
  } catch {
    throw new CliError(
      `Cannot resolve existing package binary ${packageExecutable}.`,
      EXIT_USER_ERROR,
    );
  }
  let packageRoot: string;
  try {
    packageRoot = `${canonicalPackageRoot(prefix, CLI_PACKAGE).replaceAll("\\", "/")}/`;
  } catch {
    throw new CliError(
      `${packageExecutable} is not backed by the selected prefix's Omnesis package root.`,
      EXIT_USER_ERROR,
    );
  }
  if (!real.replaceAll("\\", "/").startsWith(packageRoot)) {
    throw new CliError(
      `${packageExecutable} is not owned by the selected Omnesis package prefix.`,
      EXIT_USER_ERROR,
    );
  }
  const installed = await captureMigrationCommand(
    deps.run,
    { command: packageExecutable, args: ["--version"] },
    "Existing package version check",
  );
  if (installed !== version) {
    throw new CliError(
      `The selected package prefix already contains Omnesis ${installed}; move or remove it before migrating ${version}.`,
      EXIT_USER_ERROR,
    );
  }
  return true;
}

async function assertSourcePathResolution(
  launcherPath: string,
  argv1: string,
  deps: SourceToPackageDeps,
): Promise<void> {
  const found = await captureMigrationCommand(
    deps.run,
    { command: "sh", args: ["-c", "command -v omnesis"] },
    "PATH preflight",
  );
  if (!isAbsolute(found)) {
    throw new CliError(
      `PATH resolves omnesis to non-absolute location '${found}'.`,
      EXIT_USER_ERROR,
    );
  }
  const resolved = realpathSync(found);
  if (resolved !== realpathSync(launcherPath) && resolved !== realpathSync(argv1)) {
    throw new CliError(
      `PATH resolves omnesis to unrelated executable ${found}; fix PATH before migrating.`,
      EXIT_USER_ERROR,
    );
  }
}

export async function buildMigrationPlan(
  opts: SourceToPackageOptions,
  deps: SourceToPackageDeps,
): Promise<MigrationPlan> {
  if (deps.platform !== "linux" && deps.platform !== "darwin") {
    throw new CliError(
      `Source-to-package migration is not supported on ${deps.platform}.`,
      EXIT_USER_ERROR,
    );
  }
  const installation = detectInstallMethod(deps.argv1);
  if (installation.method !== "source") {
    throw new CliError(
      "This command is only for an installer-managed source checkout.",
      EXIT_USER_ERROR,
    );
  }
  const rootDir = realpathSync(installation.rootDir);
  const rootIdentity = captureDirectoryIdentity(rootDir);
  const version = deps.currentVersion.trim();
  if (!isResolvedVersion(version)) {
    throw new CliError(
      `The source checkout reports invalid version '${version}'.`,
      EXIT_USER_ERROR,
    );
  }

  const managed = await captureMigrationCommand(
    deps.run,
    sourceManagedSpec(rootDir),
    "Source ownership check",
  );
  if (managed !== "managed") {
    throw new CliError(
      "This source checkout was not created as an installer-managed checkout.",
      EXIT_USER_ERROR,
    );
  }
  const status = await captureMigrationCommand(
    deps.run,
    sourceStatusSpec(rootDir),
    "Source cleanliness check",
  );
  if (status) {
    throw new CliError(
      "The source checkout has local changes. Preserve or discard them before migrating.",
      EXIT_USER_ERROR,
    );
  }
  const head = await captureMigrationCommand(
    deps.run,
    sourceHeadSpec(rootDir),
    "Source HEAD check",
  );
  assertCompletedSourceState(deps.configDir, rootDir, head);
  const tag = `v${version}`;
  const release = await captureMigrationCommand(
    deps.run,
    sourceRefShaSpec(rootDir, tag),
    `Release tag ${tag}`,
  );
  if (!/^[0-9a-f]{40}$/u.test(head) || head !== release) {
    throw new CliError(
      `The source checkout must be exactly on release ${tag}; update it separately before migrating.`,
      EXIT_USER_ERROR,
    );
  }

  const published = await captureMigrationCommand(
    deps.run,
    npmViewVersionSpec(version, opts.registry),
    `Published package ${CLI_PACKAGE}@${version}`,
  );
  if (published !== version) {
    throw new CliError(
      `The registry did not resolve ${CLI_PACKAGE}@${version} to that exact version.`,
      EXIT_USER_ERROR,
    );
  }

  assertSupportedRoles(deps.roles);
  const prefix = await selectPrefix(deps, rootDir);
  const packageExecutable = join(prefix, "bin", "omnesis");
  const packagePreexisting = await assertExistingPackageSafe(
    prefix,
    packageExecutable,
    version,
    deps,
  );
  if (opts.registry && packagePreexisting) {
    throw new CliError(
      `The selected prefix already contains ${CLI_PACKAGE}@${version}; remove it before using --registry so the migration can prove that registry supplied the package.`,
      EXIT_USER_ERROR,
    );
  }
  const launcherPath = join(deps.homeDir, ".local", "bin", "omnesis");
  const launcher = captureOwnedSourceLauncher(launcherPath, rootDir, deps.configDir, deps.homeDir);
  await assertSourcePathResolution(launcherPath, deps.argv1, deps);
  const launcherAfter = packageLauncher(prefix, packageExecutable);
  const unitChanges: UnitChange[] = [];
  let gatewayPort = 7600;
  let gatewayBind = "0.0.0.0";
  let gatewayEnv: MigrationPlan["gatewayEnv"] = null;
  for (const component of ["gateway", "collector"] as const) {
    if (!deps.roles[component].present) continue;
    const path = deps.supervisor.unitPath(component);
    const snapshot = captureRegularFile(path);
    await assertServiceDefinition(component, path, rootDir, deps);
    const serviceConfig = serviceConfigDir(deps.platform, snapshot.content) ?? deps.configDir;
    if (!isAbsolute(serviceConfig)) {
      throw new CliError(
        `The ${component} service uses a non-absolute config directory '${serviceConfig}'.`,
        EXIT_USER_ERROR,
      );
    }
    if (canonicalPath(serviceConfig) !== canonicalPath(deps.configDir)) {
      throw new CliError(
        `The ${component} service uses ${serviceConfig}, not this update command's config directory ${deps.configDir}. Re-run with OMNESIS_CONFIG_DIR set to the service directory.`,
        EXIT_USER_ERROR,
      );
    }
    if (component === "gateway") {
      const gatewayEnvPath = join(serviceConfig, ".env");
      gatewayEnv = {
        path: gatewayEnvPath,
        snapshot: captureOptionalRegularFile(gatewayEnvPath),
      };
      gatewayPort = serviceGatewayPort(
        deps.platform,
        snapshot.content,
        gatewayEnv?.snapshot?.content,
      );
      gatewayBind = serviceGatewayBind(
        deps.platform,
        snapshot.content,
        gatewayEnv?.snapshot?.content,
      );
    }
    unitChanges.push({
      component,
      path,
      before: snapshot.content,
      after: rebindServiceExecutable(
        deps.platform,
        snapshot.content,
        launcherPath,
        packageExecutable,
      ),
      identity: snapshot.identity,
    });
  }
  return {
    rootDir,
    rootIdentity,
    version,
    prefix,
    packageExecutable,
    launcherPath,
    launcherBefore: launcher.content,
    launcherAfter,
    launcherIdentity: launcher.identity,
    unitChanges,
    packagePreexisting,
    gatewayPort,
    gatewayBind,
    gatewayEnv,
  };
}

export function printMigrationPlan(
  plan: MigrationPlan,
  opts: SourceToPackageOptions,
  log: (line: string) => void,
): void {
  log(`Move this host from source to ${CLI_PACKAGE}@${plan.version}.`);
  log(
    plan.packagePreexisting
      ? `  Reuse verified package: ${plan.packageExecutable}`
      : `  Install exact package: ${formatCommandSpec(packageInstallSpec(plan.version, plan.prefix, opts.registry))}`,
  );
  for (const unit of plan.unitChanges) log(`  Rebind and reload ${unit.component}: ${unit.path}`);
  if (plan.unitChanges.some((unit) => unit.component === "gateway")) {
    log(`  Require the gateway to report version ${plan.version}.`);
  }
  log(`  Replace the installer-owned PATH launcher: ${plan.launcherPath}`);
  log(
    opts.keepCheckout
      ? `  Keep source checkout: ${plan.rootDir}`
      : `  Offer to remove: ${plan.rootDir}`,
  );
  log("No configuration, credentials, or indexed data move.");
}

/** Default writability probe used by the command adapter. */
export async function canWritePrefix(path: string): Promise<boolean> {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  try {
    await access(probe, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
