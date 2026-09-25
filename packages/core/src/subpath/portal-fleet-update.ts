// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Node-specific durable state for a portal-initiated fleet update. */
export {
  PORTAL_FLEET_UPDATE_DETAIL_MAX_LENGTH,
  PORTAL_FLEET_UPDATE_OPERATION_FILE,
  PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES,
  acquirePortalFleetUpdateRunnerClaim,
  createPortalFleetUpdateOperation,
  portalFleetUpdateOperationPath,
  portalFleetUpdateOutputTail,
  readPortalFleetUpdateOperation,
  updatePortalFleetUpdateOperation,
  writePortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
  type PortalFleetUpdateState,
} from "../portal-fleet-update.js";
