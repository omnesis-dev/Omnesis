// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const icon = (geometry: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${geometry}</svg>`;

/** Original monochrome artwork shared by every Lab client. */
export const LAB_FEATURES = [
  {
    id: "brain",
    name: "Brain",
    description:
      "Processes your data in the background to connect information, keep knowledge up to date, and surface useful insights. Chat and Tell Omnesis work independently.",
    iconSvg: icon(
      '<path d="M12 5a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 3 8a4 4 0 0 0-1 7 3.5 3.5 0 0 0 4 5 3 3 0 0 0 6-1V5Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 21 8a4 4 0 0 1 1 7 3.5 3.5 0 0 1-4 5 3 3 0 0 1-6-1"/><path d="M6 8c2 0 3 1 3 3m-6 4c2-1 4 0 4 2m11-9c-2 0-3 1-3 3m6 4c-2-1-4 0-4 2"/>',
    ),
  },
  {
    id: "tasks",
    name: "Tasks",
    description:
      "Keep a personal task journal. Add, schedule, and complete tasks yourself or ask Omnesis to help. Enable the Brain as well for background suggestions and updates.",
    iconSvg: icon(
      '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m7 8 1.5 1.5L11 7m2 2h4m-10 6 1.5 1.5L11 14m2 2h4"/>',
    ),
  },
  {
    id: "watches",
    name: "Watches",
    description:
      "Watch for changes in your data and receive a notification when your conditions are met. Watches run independently of the Brain.",
    iconSvg: icon(
      '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2"/>',
    ),
  },
] as const;

export type LabFeatureId = (typeof LAB_FEATURES)[number]["id"];
