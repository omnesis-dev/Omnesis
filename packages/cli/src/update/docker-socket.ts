// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether the one-shot update container can reach the Docker daemon, checked
 * before an update changes anything — and, when it cannot for want of the
 * socket's group, the compose file's updater given that group.
 *
 * The installer runs the updater as the host account with `group_add` for the
 * socket's group. The group that counts is the one the socket has INSIDE a
 * container, which is not always the host's: a daemon in a VM (the Mac's
 * Docker apps) hands a container the VM's side of the socket, owned by root
 * there, and a rootless daemon maps the owner to the container's root.
 * Releases up to 0.7.2 wrote the host's group, so on such a daemon their
 * update could not pull anything. This container sees the socket exactly as
 * the next update container will — same service, same mount, same account —
 * so the group it reads here is the one to join.
 */

import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";

/** Where the compose file mounts this host's Docker socket in the updater. */
export const CONTAINER_DOCKER_SOCKET = "/var/run/docker.sock";

export type DockerSocketAccess =
  | { kind: "ok" }
  /** Absent, or not the socket the compose file mounts: Docker reports it. */
  | { kind: "unknown" }
  | {
      kind: "denied";
      /** The socket's group as this container sees it, when it can be read. */
      socketGid: number | null;
      /** The groups this process runs with. */
      groups: readonly number[];
      /**
       * Whether this process runs in a container — the updater — whose view
       * of the socket is the one the next update container has.
       */
      inContainer: boolean;
    };

export interface DockerSocketProbeDeps {
  env: NodeJS.ProcessEnv;
  /** Resolves with the connect error's code, or null once connected. */
  connect(path: string): Promise<string | null>;
  socketGid(path: string): number | null;
  groups(): readonly number[];
  inContainer(): boolean;
}

export const nodeDockerSocketProbeDeps: DockerSocketProbeDeps = {
  env: process.env,
  connect: (path) =>
    new Promise((resolve) => {
      const socket = connect(path);
      const done = (code: string | null): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(code);
      };
      socket.setTimeout(5_000, () => done("ETIMEDOUT"));
      socket.once("connect", () => done(null));
      socket.once("error", (err: NodeJS.ErrnoException) => done(err.code ?? "EIO"));
    }),
  socketGid: (path) => {
    try {
      return statSync(path).gid;
    } catch {
      return null;
    }
  },
  groups: () => {
    const groups = new Set<number>();
    if (typeof process.getgid === "function") groups.add(process.getgid());
    if (typeof process.getgroups === "function")
      for (const gid of process.getgroups()) groups.add(gid);
    return [...groups];
  },
  // Docker creates this file in every container it starts.
  inContainer: () => existsSync("/.dockerenv"),
};

/** Connect to the mounted socket, the way the Docker client is about to. */
export async function probeDockerSocket(
  deps: DockerSocketProbeDeps = nodeDockerSocketProbeDeps,
): Promise<DockerSocketAccess> {
  const host = deps.env.DOCKER_HOST;
  // A client pointed elsewhere does not use the mounted socket at all.
  if (host && host !== `unix://${CONTAINER_DOCKER_SOCKET}`) return { kind: "unknown" };
  const code = await deps.connect(CONTAINER_DOCKER_SOCKET);
  if (code === null) return { kind: "ok" };
  if (code !== "EACCES" && code !== "EPERM") return { kind: "unknown" };
  return {
    kind: "denied",
    socketGid: deps.socketGid(CONTAINER_DOCKER_SOCKET),
    groups: deps.groups(),
    inContainer: deps.inContainer(),
  };
}

/**
 * The compose text with the updater service's `group_add` set to `gid`, or
 * null when that is no change or the text is not in the dialect the installer
 * writes. Only the updater's block is touched.
 */
export function withUpdaterGroup(composeText: string, gid: number): string | null {
  const lines = composeText.split("\n");
  const start = lines.findIndex((line) => line.replace(/\s+$/u, "") === "  updater:");
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^ {3,}\S/u.test(lines[end]!))) {
    end += 1;
  }
  const block = lines.slice(start + 1, end);
  const wanted = `      - "${gid}"`;
  const groupAt = block.findIndex((line) => line.replace(/\s+$/u, "") === "    group_add:");
  if (groupAt >= 0) {
    let itemsEnd = groupAt + 1;
    while (itemsEnd < block.length && /^ {6}- /u.test(block[itemsEnd]!)) itemsEnd += 1;
    const items = block.slice(groupAt + 1, itemsEnd);
    if (items.length === 1 && items[0]!.replace(/\s+$/u, "") === wanted) return null;
    block.splice(groupAt + 1, itemsEnd - groupAt - 1, wanted);
  } else {
    const userAt = block.findIndex((line) => /^ {4}user: /u.test(line));
    if (userAt < 0) return null;
    block.splice(userAt + 1, 0, "    group_add:", wanted);
  }
  return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join("\n");
}

/**
 * The installer line that rewrites this install, with the role and network it
 * was made with, read back from the compose file the installer wrote.
 */
export function dockerReinstallCommand(composeText: string): string {
  const flags = ["--docker"];
  const services = new Set(
    [...composeText.matchAll(/^ {2}([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/gmu)].map((m) => m[1]),
  );
  if (!services.has("gateway")) {
    flags.push("--collector");
    const url = composeText.match(/^ {6}- OMNESIS_GATEWAY_URL=(\S+)\s*$/mu)?.[1];
    if (url) flags.push("--gateway-url", url);
  } else if (/\/omnesis-combined:/u.test(composeText)) {
    flags.push("--combined");
  } else if (!services.has("collector")) {
    flags.push("--gateway-only");
  }
  if (/^ {4}network_mode: host\s*$/mu.test(composeText)) {
    flags.push("--docker-network", "host");
    const port = composeText.match(/^ {6}- OMNESIS_GATEWAY_PORT=(\d+)\s*$/mu)?.[1];
    if (port && port !== "7600") flags.push("--port", port);
  } else {
    const port = composeText.match(/^ {6}- "(\d+):7600"\s*$/mu)?.[1];
    if (port && port !== "7600") flags.push("--port", port);
  }
  return `curl -fsSL https://omnesis.dev/install.sh | sh -s -- ${flags.join(" ")}`;
}

/**
 * What an update says, and does, when its container cannot reach the daemon:
 * nothing has changed yet, so it says so. In the updater container, with the
 * socket's group readable and not one this process has, the compose file's
 * updater is given that group, and the next `omnesis update` runs with it.
 * Otherwise the installer, which asks a container the same question, is the
 * way to rewrite it.
 */
export function explainDeniedSocket(
  access: Extract<DockerSocketAccess, { kind: "denied" }>,
  install: { composeFile: string; composeText: string; previous: string },
  writeCompose: (text: string) => void,
): string {
  const { composeFile, composeText, previous } = install;
  const gid = access.socketGid;
  const lines = [
    `This update's container cannot reach the Docker daemon: ${CONTAINER_DOCKER_SOCKET} ` +
      `refused it (permission denied)` +
      (gid === null ? "." : `. Inside a container the socket belongs to group ${gid}.`),
    `Nothing was changed: this install still runs ${previous}.`,
  ];
  const fixable = access.inContainer && gid !== null && !access.groups.includes(gid);
  const corrected = fixable ? withUpdaterGroup(composeText, gid) : null;
  if (corrected !== null) {
    try {
      writeCompose(corrected);
      lines.push(
        `The updater in ${composeFile} now joins group ${gid}. Run \`omnesis update\` again.`,
      );
      return lines.join("\n");
    } catch {
      // Not writable from here: the installer rewrites it.
    }
  }
  lines.push(
    "Re-run the installer once, which gives the updater the group containers see the socket " +
      "as, then run `omnesis update`:",
    `  ${dockerReinstallCommand(composeText)}`,
  );
  return lines.join("\n");
}
