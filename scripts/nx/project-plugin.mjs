// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Add portable unit and typecheck targets to every npm workspace project.
 * Nx still owns project discovery, dependency edges, affected calculation,
 * hashing, caching and task scheduling; the commands delegate physical work
 * to Omnesis' existing queue-aware runner.
 */
export const createNodesV2 = [
  "{extension,packages/*,packages/providers/*,packages/providers-synth/*}/package.json",
  async (configFiles) =>
    configFiles.map((configFile) => {
      const projectRoot = configFile.slice(0, -"/package.json".length);
      return [
        configFile,
        {
          projects: {
            [projectRoot]: {
              root: projectRoot,
              targets: {
                "nx-unit": {
                  command: `node scripts/nx/run-project-task.mjs unit ${JSON.stringify(projectRoot)}`,
                  options: { cwd: "." },
                },
                "nx-typecheck": {
                  command: `node scripts/nx/run-project-task.mjs typecheck ${JSON.stringify(projectRoot)}`,
                  options: { cwd: "." },
                  parallelism: false,
                },
              },
            },
          },
        },
      ];
    }),
];
