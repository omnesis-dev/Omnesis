// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useEffect, useState } from "preact/hooks";
import { listPrivacySubscriptionFirings } from "../../api.js";
import { privacyCollection } from "../shared/privacy-vocabulary.js";
import { subscriptionFiringHref, watchDisclosure } from "../watches/vocabulary.js";

/**
 * The summary wire identifies a journal event, not its individual firings.
 * Only a single runtime firing and a unique egress record are safe to join.
 * An older event absent from this bounded ledger gets no speculative link.
 */
export function watchFiringAuditHref(watchId, subscriptionId, path, firings) {
  if (!subscriptionId || !watchId || path?.firings?.length !== 1 || !Number.isFinite(path.seq)) {
    return null;
  }
  const matches = firings.filter((firing) => firing.watchId === watchId && firing.seq === path.seq);
  const match = matches.length === 1 ? matches[0] : null;
  return typeof match?.id === "string" && match.id.length > 0
    ? subscriptionFiringHref(subscriptionId, match.id)
    : null;
}

/** Optional audit navigation; a failed read leaves the existing debug view usable. */
export function useWatchFiringAuditHref(watch, path) {
  const watchId = watch?.id ?? null;
  const subscriptionId = watchDisclosure(watch)?.subscriptionId ?? null;
  const [ledger, setLedger] = useState(null);

  useEffect(() => {
    if (!watchId || !subscriptionId) return undefined;
    let current = true;
    setLedger(null);
    listPrivacySubscriptionFirings(subscriptionId)
      .then((payload) => {
        if (!current) return;
        const firings = privacyCollection(payload, "firings");
        if (firings) setLedger({ watchId, subscriptionId, firings });
      })
      .catch(() => { /* The audit link is optional. */ });
    return () => { current = false; };
  }, [watchId, subscriptionId]);

  if (ledger?.watchId !== watchId || ledger?.subscriptionId !== subscriptionId) return null;
  return watchFiringAuditHref(watchId, subscriptionId, path, ledger.firings);
}
