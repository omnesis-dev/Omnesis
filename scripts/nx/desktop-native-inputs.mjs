// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Exact wire/authority producers exercised by the desktop's Darwin fixtures. */
export function isDesktopNativeContract(path) {
  if (/\.test\.[cm]?[jt]sx?$/.test(path)) return false;
  return (
    /^packages\/core\/src\/(?:source-permissions|sync-remediation|node-command|managed-runtime-bootstrap|worker-entry|managed-data-authority|managed-key-recovery|managed-background|managed-background-rebind|managed-background-nearby|codex-paths)\.ts$/.test(
      path,
    ) ||
    /^packages\/agent\/src\/codex-[^/]+\.ts$/.test(path) ||
    /^packages\/cli\/src\/desktop\/(?:protocol|desktop-state|codex-keyring)\.ts$/.test(path) ||
    path === "packages/gateway/src/http/services/SourcePermissionsService.ts" ||
    path === "packages/gateway/src/http/routes/admin/sources.ts"
  );
}
