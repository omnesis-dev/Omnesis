// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { useEffect, useRef, useState } from "preact/hooks";
import { getKnowledgeConnections } from "../api.js";

export function claimUsageGroups(edges, claimId) {
  const claim = new Map();
  const page = new Map();
  for (const edge of edges) {
    if (edge.direction !== "incoming" || !edge.claimId || !edge.ref)
      continue;
    if (claimId && edge.targetClaimId === claimId) claim.set(edge.node.id, edge);
    else if (!edge.targetClaimId && typeof edge.ref === "string" && edge.ref && !edge.ref.includes("#"))
      page.set(edge.node.id, edge);
  }
  return { claim: [...claim.values()], page: [...page.values()] };
}

const emptyUsage = () => ({ items: [], nextCursor: null, loading: false, error: null });

export function useClaimUsage(node, enabled) {
  const key = JSON.stringify([node.id, node.revision]);
  const cached = useRef(null);
  const [state, setState] = useState(() => ({ key, ...emptyUsage() }));
  useEffect(() => {
    if (!enabled) return;
    if (cached.current?.key !== key)
      cached.current = { key, promise: getKnowledgeConnections(node.id) };
    let active = true;
    setState({ key, ...emptyUsage(), loading: true });
    cached.current.promise.then(
      (result) => {
        if (active)
          setState({
            key,
            items: result.items,
            nextCursor: result.nextCursor,
            loading: false,
            error: null,
          });
      },
      () => {
        if (active)
          setState({ key, ...emptyUsage(), error: "Claim usage could not be loaded." });
      },
    );
    return () => {
      active = false;
    };
  }, [key, node.id, enabled]);
  if (state.key !== key) return emptyUsage();
  const { items, nextCursor, loading, error } = state;
  return { items, nextCursor, loading, error };
}
