---
"omnesis": minor
---

Capture a note about the current page from the Chrome extension using Tell Omnesis in the popup, the page or selection context menu, or Alt+Shift+N (Control+Command+T on a Mac). The side panel keeps the page and optional quotation with the draft, and unsent notes retry after an outage. Notes use their own create-only credential, which the gateway issues to the paired extension automatically; page capture keeps working with existing permissions. Page notes are experimental and need a gateway started with `OMNESIS_EXPERIMENTAL=1`; gateways without the notes capability hide the feature, and existing extensions continue to capture pages.
