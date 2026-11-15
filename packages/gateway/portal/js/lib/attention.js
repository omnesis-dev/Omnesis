// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// What waits for the owner's decision, in words and links: the sentences the
// attention marks carry, which nav item and tab wears a mark, and where a
// marked nav item leads. Pure, so every mark's label and link can be checked
// without rendering the portal. The answer itself comes from `useAttention`.

export const WAITING_DEVICES_PATH = "/portal/settings/devices";
export const WAITING_ACCESS_PATH = "/portal/settings/access";

const SENTENCES = {
  devices: [
    "A device is waiting for your approval to pair to this gateway.",
    (n) => `${n} devices are waiting for your approval to pair to this gateway.`,
  ],
  access: [
    "An agent is waiting for your approval to connect.",
    (n) => `${n} agents are waiting for your approval to connect.`,
  ],
  answers: [
    "An answer is waiting for your review.",
    (n) => `${n} answers are waiting for your review.`,
  ],
  watches: [
    "A watch request is waiting for your approval.",
    (n) => `${n} watch requests are waiting for your approval.`,
  ],
};

/** The sentence for `count` waiting items of `topic`; empty when none wait. */
export function attentionText(topic, count) {
  if (!(count > 0)) return "";
  const [one, several] = SENTENCES[topic];
  return count === 1 ? one : several(count);
}

/** The sentences for every topic of `topics` with something waiting, as one label. */
function labelFor(attention, topics) {
  return topics
    .map((topic) => attentionText(topic, attention?.[topic]?.count ?? 0))
    .filter(Boolean)
    .join(" ");
}

/**
 * Where a person goes to answer waiting devices: one sign-in request opens that request, anything
 * else the list.
 *
 * @param {{ cloud: Array<{ requestId: string }>, count: number }} devices
 */
export function waitingDevicesHref(devices) {
  return devices.count === 1 && devices.cloud.length === 1
    ? `${WAITING_DEVICES_PATH}?request=${encodeURIComponent(devices.cloud[0].requestId)}`
    : WAITING_DEVICES_PATH;
}

/**
 * The mark a sidebar item wears, `{ label, href }`, or null. `href` is where the item leads while
 * marked, or null to keep its own: Settings leads to Devices while devices wait — a sign-in
 * expires within minutes — and otherwise to Access while agents wait.
 */
export function navAttention(view, attention) {
  switch (view) {
    case "settings": {
      const label = labelFor(attention, ["devices", "access"]);
      if (!label) return null;
      return {
        label,
        href: attention.devices.count > 0 ? waitingDevicesHref(attention.devices) : WAITING_ACCESS_PATH,
      };
    }
    case "privacy":
    case "watches": {
      const label = labelFor(attention, [view === "privacy" ? "answers" : "watches"]);
      return label ? { label, href: null } : null;
    }
    default:
      return null;
  }
}

/** The label of the mark a Settings tab wears, or "" for none: Devices and Access. */
export function settingsTabAttention(tab, attention) {
  return tab === "devices" || tab === "access" ? labelFor(attention, [tab]) : "";
}
