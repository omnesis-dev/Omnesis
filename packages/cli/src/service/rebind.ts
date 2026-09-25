// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Rewrite only the executable in an installer-generated service unit.
 *
 * A delivery-method migration must preserve every other byte: custom config
 * paths, collector URLs, keyring credentials, environment overrides and
 * hardening all belong to the existing unit. Regenerating it from today's
 * defaults would silently discard that state.
 */

import { parseDotEnv } from "@omnesis/config";
import { escapeXml, systemdEscapeArg } from "./units.js";

function replaceExactlyOnce(
  content: string,
  from: string,
  to: string,
  description: string,
): string {
  const first = content.indexOf(from);
  if (first < 0) throw new Error(`${description} does not run the expected source launcher`);
  if (content.indexOf(from, first + from.length) >= 0) {
    throw new Error(`${description} contains the source launcher more than once`);
  }
  return `${content.slice(0, first)}${to}${content.slice(first + from.length)}`;
}

function assertCanonicalSystemdEnvironment(body: string): void {
  for (const match of body.matchAll(/^[ \t]*Environment[ \t]*=.*$/gmu)) {
    if (
      !/^Environment=(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"]*|"[A-Za-z_][A-Za-z0-9_]*=(?:[^"\\]|\\["\\])*")$/u.test(
        match[0],
      )
    ) {
      throw new Error("systemd [Service] uses unsupported Environment syntax");
    }
  }
}

/** Replace ProgramArguments[0] in an installer-generated LaunchAgent plist. */
export function rebindLaunchdExecutable(
  content: string,
  sourceExecutable: string,
  packageExecutable: string,
): string {
  if (/<key>\s*(?:Program|BundleProgram)\s*<\/key>/u.test(content)) {
    throw new Error("LaunchAgent plist has an external program override");
  }
  const key = "<key>ProgramArguments</key>";
  const keyAt = content.indexOf(key);
  if (keyAt < 0 || content.indexOf(key, keyAt + key.length) >= 0) {
    throw new Error("LaunchAgent plist has no unique ProgramArguments array");
  }
  const arrayAt = content.indexOf("<array>", keyAt + key.length);
  const arrayEnd = arrayAt < 0 ? -1 : content.indexOf("</array>", arrayAt);
  if (arrayAt < 0 || arrayEnd < 0) {
    throw new Error("LaunchAgent plist has no complete ProgramArguments array");
  }
  const head = content.slice(arrayAt, arrayEnd);
  const source = `<string>${escapeXml(sourceExecutable)}</string>`;
  const target = `<string>${escapeXml(packageExecutable)}</string>`;
  const firstArgument = /<string>[\s\S]*?<\/string>/u.exec(head)?.[0];
  if (firstArgument === target && !head.includes(source)) return content;
  if (firstArgument !== source) {
    throw new Error("LaunchAgent ProgramArguments[0] does not run the expected source launcher");
  }
  const rebound = replaceExactlyOnce(head, source, target, "LaunchAgent ProgramArguments[0]");
  return `${content.slice(0, arrayAt)}${rebound}${content.slice(arrayEnd)}`;
}

/** Replace the executable token of ExecStart in an installer-generated unit. */
export function rebindSystemdExecutable(
  content: string,
  sourceExecutable: string,
  packageExecutable: string,
): string {
  const sections = [...content.matchAll(/^\[([^\]]+)\]\s*$/gmu)];
  const serviceSections = sections.flatMap((section, index) => {
    if (section[1] !== "Service" || section.index === undefined) return [];
    return [
      {
        start: section.index + section[0].length,
        end: sections[index + 1]?.index ?? content.length,
      },
    ];
  });
  if (serviceSections.length === 0) {
    throw new Error("systemd unit has no [Service] section");
  }
  for (const section of serviceSections) {
    const body = content.slice(section.start, section.end);
    assertCanonicalSystemdEnvironment(body);
    const externalEnvironment =
      /^[ \t]*(EnvironmentFile|PassEnvironment|UnsetEnvironment)[ \t]*=/mu.exec(body)?.[1];
    if (externalEnvironment) {
      throw new Error(`systemd [Service] uses unsupported ${externalEnvironment}`);
    }
  }
  const source = `ExecStart=${systemdEscapeArg(sourceExecutable)}`;
  const target = `ExecStart=${systemdEscapeArg(packageExecutable)}`;
  const sourceLine = new RegExp(`^${escapeRegExp(source)}(?=\\s|$)`, "mu");
  const targetLine = new RegExp(`^${escapeRegExp(target)}(?=\\s|$)`, "mu");
  const sourceSections = serviceSections.filter((section) =>
    sourceLine.test(content.slice(section.start, section.end)),
  );
  const sourceCount = serviceSections.reduce(
    (count, section) =>
      count +
      [...content.slice(section.start, section.end).matchAll(new RegExp(sourceLine.source, "gmu"))]
        .length,
    0,
  );
  const targetCount = serviceSections.reduce(
    (count, section) =>
      count +
      [...content.slice(section.start, section.end).matchAll(new RegExp(targetLine.source, "gmu"))]
        .length,
    0,
  );
  if (targetCount === 1 && sourceCount === 0) return content;
  if (sourceCount !== 1 || sourceSections.length !== 1) {
    throw new Error("systemd [Service] does not have one expected ExecStart executable");
  }
  const { start, end } = sourceSections[0]!;
  const body = content.slice(start, end);
  const rebound = body.replace(sourceLine, target);
  return `${content.slice(0, start)}${rebound}${content.slice(end)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Platform dispatch kept pure for preflight and rollback tests. */
export function rebindServiceExecutable(
  platform: NodeJS.Platform,
  content: string,
  sourceExecutable: string,
  packageExecutable: string,
): string {
  if (platform === "darwin") {
    return rebindLaunchdExecutable(content, sourceExecutable, packageExecutable);
  }
  if (platform === "linux") {
    return rebindSystemdExecutable(content, sourceExecutable, packageExecutable);
  }
  throw new Error(`Service executable rebinding is not supported on ${platform}`);
}

/** Detect a path preserved anywhere in a unit, including platform escaping. */
export function serviceUnitReferencesPath(
  platform: NodeJS.Platform,
  content: string,
  path: string,
): boolean {
  if (content.includes(path)) return true;
  if (platform === "linux") {
    const escapedFragment = path.replace(/%/gu, "%%").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
    return content.includes(systemdEscapeArg(path)) || content.includes(escapedFragment);
  }
  if (platform === "darwin") return content.includes(escapeXml(path));
  return false;
}

/** Undo `escapeXml` on plist element text. */
export function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function serviceEnvironmentValues(
  platform: NodeJS.Platform,
  content: string,
  key: string,
): string[] {
  if (platform === "linux") {
    return [...content.matchAll(/^Environment=(.+)$/gmu)].flatMap((match) => {
      let assignment = match[1] ?? "";
      if (assignment.startsWith('"')) {
        if (!assignment.endsWith('"')) return [];
        assignment = assignment.slice(1, -1).replace(/\\(["\\])/gu, "$1");
      }
      assignment = assignment.replaceAll("%%", "%");
      const prefix = `${key}=`;
      return assignment.startsWith(prefix) ? [assignment.slice(prefix.length)] : [];
    });
  }
  if (platform === "darwin") {
    const escapedKey = escapeRegExp(key);
    return [
      ...content.matchAll(
        new RegExp(`<key>${escapedKey}<\\/key>\\s*<string>([^<]*)<\\/string>`, "gu"),
      ),
    ].map((match) => decodeXml(match[1] ?? ""));
  }
  return [];
}

function serviceEnvironmentValue(
  platform: NodeJS.Platform,
  content: string,
  key: string,
): string | null {
  const values = serviceEnvironmentValues(platform, content, key);
  if (values.length > 1) throw new Error(`service unit has an ambiguous ${key} value`);
  return values[0] ?? null;
}

/** Read the config directory baked into an installer-generated service unit. */
export function serviceConfigDir(platform: NodeJS.Platform, content: string): string | null {
  return serviceEnvironmentValue(platform, content, "OMNESIS_CONFIG_DIR");
}

/** Read the gateway listen port preserved in an installer-generated unit. */
export function serviceGatewayPort(
  platform: NodeJS.Platform,
  content: string,
  configEnvContent?: string,
): number {
  const unitValue = serviceEnvironmentValue(platform, content, "OMNESIS_GATEWAY_PORT");
  const value =
    unitValue !== null
      ? unitValue
      : configEnvContent === undefined
        ? "7600"
        : (parseDotEnv(configEnvContent).OMNESIS_GATEWAY_PORT ?? "7600");
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`service unit has invalid gateway port '${value}'`);
  }
  return Number(value);
}

/** Read the gateway bind address from the unit, then its config environment. */
export function serviceGatewayBind(
  platform: NodeJS.Platform,
  content: string,
  configEnvContent?: string,
): string {
  const unitValue = serviceEnvironmentValue(platform, content, "OMNESIS_BIND");
  const value =
    unitValue !== null
      ? unitValue
      : configEnvContent === undefined
        ? "0.0.0.0"
        : (parseDotEnv(configEnvContent).OMNESIS_BIND ?? "0.0.0.0");
  if (value.length === 0 || /[\s/?#@]/u.test(value)) {
    throw new Error(`service unit has invalid gateway bind address '${value}'`);
  }
  return value;
}
