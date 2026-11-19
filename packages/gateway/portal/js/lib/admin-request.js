// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { apiFetch } from "../api.js";

/**
 * A caller for one family of JSON admin routes under `base`. Each call rejects
 * with an Error whose `serverMessage` is the gateway's own sentence — for a
 * refused field, the field's message rather than the generic "Validation
 * failed" — and whose `status` and `code` are the response's. `subject` names
 * the family in the generic message.
 */
export function adminJsonRequest(base, subject) {
  return async function request(method, path, { body, signal } = {}) {
    const response = await apiFetch(`${base}${path}`, {
      method,
      cache: "no-store",
      ...(signal ? { signal } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let envelope = null;
      try {
        envelope = await response.json();
      } catch {
        // A body that is not JSON keeps the generic message.
      }
      const error = new Error(`${subject} request failed (${response.status}).`);
      error.status = response.status;
      if (typeof envelope?.code === "string") error.code = envelope.code;
      const field = Array.isArray(envelope?.detail) ? envelope.detail.find((d) => typeof d?.message === "string") : null;
      const message = field?.message ?? (typeof envelope?.error === "string" ? envelope.error : null);
      if (message) error.serverMessage = message;
      throw error;
    }
    return response.json();
  };
}
