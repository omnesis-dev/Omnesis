// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chat } from "./shared.mjs";

export function addLoans({ day, add, fact }) {
  add(
    "apple-imessage",
    "messages.json",
    chat("sb-loan-camera", "p_priya", day(-52), [
      "Could I borrow your compact camera for the printmaking trip?",
      "Yes, the silver Lumina compact. Please bring it back after the trip.",
    ]),
    chat("sb-loan-camera-confirmed", "p_priya", day(-3), [
      "Your silver Lumina camera is still with me. I will return it when we meet next Thursday.",
      "Thanks for confirming — I had forgotten where it was.",
    ]),
    chat("sb-loan-book", "p_elliot", day(-42), [
      "Could I borrow your railway photography book?",
      "Of course.",
    ]),
    chat("sb-loan-book-returned", "p_elliot", day(-16), [
      "Left your railway photography book on your kitchen table today.",
      "Found it, thanks.",
    ]),
    chat("sb-loan-bag", "p_jamie", day(-32), ["Can I borrow the green overnight bag?", "Sure."]),
    chat("sb-loan-bag-returned", "p_jamie", day(-11), [
      "Handed your green bag back this morning.",
      "Yes, back in the cupboard.",
    ]),
  );
  fact(
    "A14",
    "Who still has something I lent them? Check later return messages rather than listing every historic loan.",
    {
      outstanding: "silver Lumina compact camera",
      borrower: "Priya Calder",
      returned: ["railway photography book", "green overnight bag"],
    },
    ["sb-loan-camera-confirmed", "sb-loan-book-returned", "sb-loan-bag-returned"],
    ["Explicit acknowledgement establishes current loan; silence alone does not."],
  );
}
