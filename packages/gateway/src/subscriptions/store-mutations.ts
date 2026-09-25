// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Compatibility façade for subscription mutations.
 *
 * Keep imports stable while the implementation stays partitioned by durable
 * responsibility: lifecycle/policy, delivery leases, and firing-bound Answer
 * authority.
 */
export * from "./store-lifecycle-mutations.js";
export * from "./store-firing-mutations.js";
export * from "./store-delivery-mutations.js";
export * from "./store-answer-authority-mutations.js";
