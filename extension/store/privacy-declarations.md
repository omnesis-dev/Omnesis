# Chrome Web Store privacy declarations

These answers describe the packaged extension. Re-check them against the Chrome Web Store dashboard wording when submitting.

## Single purpose

Help users capture, annotate and return to browser-openable content through their paired Omnesis gateway. Automatic capture and submitted notes go directly to that gateway; optional Find searches its index and opens source links.

## Permission justifications

- `storage`: stores the gateway pairing, a copy of the gateway's capture settings (pause, excluded domains, pages deleted for good), bounded retry queues, note drafts, Find queries and result state, and delivery status locally in the extension profile.
- `unlimitedStorage`: lets the bounded retry queue and staged page handoffs survive a temporary gateway outage when their combined content exceeds Chrome's normal local-storage quota. The extension still applies fixed byte and item limits.
- `alarms`: wakes the Manifest V3 service worker to retry queued delivery and refresh health while Chrome is running.
- `scripting`: registers and repairs the capture content script after the user grants optional HTTPS page access. The popup uses that same optional host grant to explain whether the current HTTPS page is being watched.
- `activeTab`: reads the current page context and selected passage after the user explicitly invokes Tell Omnesis.
- `contextMenus`: offers Tell Omnesis for the current page or selected text after the gateway supports notes and its owner grants access.
- `sidePanel`: hosts the note composer and Find results alongside the current page.
- Optional `tabs`: lets Find compare source links against the URLs of open tabs across the profile, after the user chooses **Match all open tabs**. Matching happens locally; the tab list is not sent to the gateway. Existing page-access grants allow matching those sites without this permission.
- Optional `favicon`: displays site icons using Chrome’s favicon service. Find works without it and falls back when an icon is unavailable.
- Optional `https://*/*` host access: reads rendered HTTPS pages after an explicit Chrome permission prompt. It is optional at installation, requested during pairing, and removed on unpair. Incognito is disabled.

Why the capture script is registered dynamically rather than declared in a static `content_scripts` block: a static block matching `https://*/*` would force Chrome to grant host access at installation time. Registering it through `chrome.scripting` only after the user grants the optional permission keeps host access opt-in, and the registration is removed again on unpair.

## Remote code

No. Every script the extension runs is bundled into the package at build time. The extension loads no remote scripts, evaluates no fetched code, and includes no `eval`-style execution.

## Data handled

- Website content: readable page text converted to Markdown; raw HTML, scripts, images and page pixels are not sent.
- Web history: normalized URL, domain, title, visit time, focused dwell duration, stable paired-browser device ID, and the user-entered Chrome profile name for captured pages.
- User-written notes: note text, optional selected passage, page URL/title and capture time/time zone. Drafts and up to 100 unsent notes stay locally until sent; a full queue refuses a new save and preserves the draft. Manual notes are sent only after an explicit action, separately from automatic capture.
- Authentication information: the gateway URL, one-time pairing code, pairing device identity, user-entered Chrome profile name and `write:web` bearer token. Notes activation stores an additional device-bound `notes:create` token after gateway-owner approval; it allows creating notes only. Optional Find stores a separate `read` token after gateway-owner approval; the approval discloses search across Omnesis data. Chrome does not expose its local profile name to extensions. The pairing code is sent to the selected gateway for redemption; if that request times out it is sent again with the same request identifier so the gateway returns the credential it already issued. The extension keeps only a hash of the code and that identifier, for at most fifteen minutes, never the code itself.
- Search: queries sent to the paired gateway and returned titles, snippets and source links. A separately owner-approved `read` token allows ordinary search across the index; browser-openable filtering occurs in the extension. The current query, results and bounded agent explanation are retained locally for reopening the panel; tool cards remain transient. The gateway’s configured decision model can route a query to a read-only agent search. The panel displays its decision, streamed text, transient tool activity and structured results. Without an enabled decision model, Find uses ordinary index search. There is no follow-up conversation.
- User activity: delivery status stored locally, and the capture settings (pause, excluded domains) the user edits on the paired gateway through the extension.

Because capture can be enabled on signed-in HTTPS pages, select every Chrome Web Store data-type category that page text may contain: personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, web history, user activity, and website content. Omnesis does not target or infer those sensitive categories; they may be present in a page the user chose to make capturable. The prominent pairing disclosure and optional host-permission prompt occur before capture starts.

## Data use and transfer

Data is used only to provide browser capture, page notes, Find, delivery retries, status and user controls. Search queries go to the paired gateway; tab matching stays local. Favicon URLs are not sent to a third-party icon service. Captured data goes directly to the gateway the user chooses. It is not sold, used for advertising, or used for credit or lending. If the selected gateway is operated by the developer, the developer receives the data as its operator. The extension contains no analytics, advertising or crash-reporting SDK.

The paired gateway's operator controls data received by that gateway. Optional inference configured on the gateway can send selected indexed content to the model provider chosen by that operator; this does not happen in the extension itself.

## Certification

The extension's use of data is limited to its disclosed single purpose. It does not use or transfer user data for personalized advertising, sell user data, or use user data for purposes unrelated to browser capture, user-written page notes, and returning to browser-openable indexed content.

The packaged extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is transmitted over HTTPS, is not transferred to the developer merely by installing the extension, and is used or transferred only to provide or improve the extension's single disclosed capture, annotation and browser-retrieval purpose. Re-confirm each certification against the current dashboard wording before submission.

The developer does not permit humans to read extension user data. Any exceptional access would be limited to the cases allowed by the Limited Use requirements: the user's affirmative consent for specific data, security or abuse investigation, legal compliance, or internal processing of aggregated and anonymized data. For gateways not operated by the developer, the extension does not provide the developer with a data-access channel.
