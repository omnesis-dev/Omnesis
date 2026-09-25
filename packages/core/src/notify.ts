// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a notification may say.
 *
 * APNs caps an alert payload, and a banner renders on a locked screen — so
 * these are the bounds on the two strings a watch's asker may choose, checked
 * where the watch is stored rather than where it is delivered. A watch whose
 * copy was too long to send would otherwise be a watch that matches and
 * silently never arrives.
 */

export const NOTIFY_IOS_TITLE_MAX = 256;
export const NOTIFY_IOS_BODY_MAX = 1024;
