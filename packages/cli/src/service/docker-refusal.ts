// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis service` inside a Docker install.
 *
 * The daemons of a Docker install are its containers, and the CLI runs inside
 * one of them: there is no launchd or systemd there to ask, and a container
 * cannot stop, start or read the logs of itself. The host launcher maps every
 * `omnesis service` verb to its compose equivalent before anything reaches
 * the container; a command that arrives here anyway came through a launcher
 * from before that, and is answered with the exact host command instead.
 */

import { CliError, EXIT_USER_ERROR } from "../utils.js";
import { detectDockerContext, type DockerContext } from "../docker-install.js";

export type ServiceVerb =
  "install" | "uninstall" | "start" | "stop" | "restart" | "status" | "logs";

const COMPOSE_VERB: Record<Exclude<ServiceVerb, "install" | "uninstall">, string> = {
  start: "up -d --no-deps",
  stop: "stop",
  restart: "restart",
  status: "ps --all",
  logs: "logs",
};

/** The services a component names in this install, as compose knows them. */
function composeServices(docker: DockerContext, component: unknown): string {
  if (component === "gateway" || component === "collector") {
    // A combined install runs both daemons in the gateway's container.
    return docker.services.includes(component) ? component : "gateway";
  }
  return docker.services.join(" ");
}

/** The refusal for `omnesis service <verb>` when `configDir` is a Docker install's, else null. */
export function dockerServiceRefusal(
  configDir: string,
  verb: ServiceVerb,
  component: unknown,
  detect: (dir: string) => DockerContext | null = detectDockerContext,
): CliError | null {
  const docker = detect(configDir);
  if (!docker) return null;
  const lead =
    "This is a Docker install: its gateway and collector are the containers of " +
    `${docker.composeFile}, which a command inside one of them cannot manage.`;
  if (verb === "install" || verb === "uninstall") {
    return new CliError(
      `${lead} The installer creates them: re-run it with the options you installed with to change them, and remove the install from the host with \`omnesis uninstall\`.`,
      EXIT_USER_ERROR,
    );
  }
  const named = component === "gateway" || component === "collector" ? ` ${component}` : "";
  return new CliError(
    `${lead} On the host, run \`docker compose -f ${docker.composeFile} ${COMPOSE_VERB[verb]} ${composeServices(docker, component)}\`. ` +
      `\`omnesis service ${verb}${named}\` does the same from a host launcher of this release; ` +
      "an older launcher sends it here instead, and `omnesis update` refreshes it.",
    EXIT_USER_ERROR,
  );
}
