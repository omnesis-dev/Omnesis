# Chrome Web Store privacy declarations

These answers describe the packaged extension. Re-check them against the Chrome Web Store dashboard wording when submitting.

## Single purpose

Capture readable content and visit metadata from web pages the user views, and send it directly to the Omnesis gateway the user paired with the extension.

## Permission justifications

- `storage`: stores the gateway pairing, a copy of the gateway's capture settings (pause, excluded domains, pages deleted for good), bounded retry queue and delivery status locally in the extension profile.
- `unlimitedStorage`: lets the bounded retry queue and staged page handoffs survive a temporary gateway outage when their combined content exceeds Chrome's normal local-storage quota. The extension still applies fixed byte and item limits.
- `alarms`: wakes the Manifest V3 service worker to retry queued delivery and refresh health while Chrome is running.
- `scripting`: registers and repairs the capture content script after the user grants optional HTTPS page access. The popup uses that same optional host grant to explain whether the current HTTPS page is being watched; no `tabs` or `activeTab` permission is requested.
- Optional `https://*/*` host access: reads rendered HTTPS pages after an explicit Chrome permission prompt. It is optional at installation, requested during pairing, and removed on unpair. Incognito is disabled.

Why the capture script is registered dynamically rather than declared in a static `content_scripts` block: a static block matching `https://*/*` would force Chrome to grant host access at installation time. Registering it through `chrome.scripting` only after the user grants the optional permission keeps host access opt-in, and the registration is removed again on unpair.

## Remote code

No. Every script the extension runs is bundled into the package at build time. The extension loads no remote scripts, evaluates no fetched code, and includes no `eval`-style execution.

## Data handled

- Website content: readable page text converted to Markdown; raw HTML, scripts, images and page pixels are not sent.
- Web history: normalized URL, domain, title, visit time, focused dwell duration, stable paired-browser device ID, and the user-entered Chrome profile name for captured pages.
- Authentication information: the gateway URL, one-time pairing code, pairing device identity, user-entered Chrome profile name and `write:web` bearer token. Chrome does not expose its local profile name to extensions. The pairing code is sent to the selected gateway for redemption; if that request times out it is sent again with the same request identifier so the gateway returns the credential it already issued. The extension keeps only a hash of the code and that identifier, for at most fifteen minutes, never the code itself.
- User activity: delivery status stored locally, and the capture settings (pause, excluded domains) the user edits on the paired gateway through the extension.

Because capture can be enabled on signed-in HTTPS pages, select every Chrome Web Store data-type category that page text may contain: personally identifiable information, health information, financial and payment information, authentication information, personal communications, location, web history, user activity, and website content. Omnesis does not target or infer those sensitive categories; they may be present in a page the user chose to make capturable. The prominent pairing disclosure and optional host-permission prompt occur before capture starts.

## Data use and transfer

Data is used only to provide browser capture, delivery retries, status and user controls. Captured data goes directly to the gateway the user chooses. It is not sold, used for advertising, or used for credit or lending. If the selected gateway is operated by the developer, the developer receives the data as its operator. The extension contains no analytics, advertising or crash-reporting SDK.

The paired gateway's operator controls data received by that gateway. Optional inference configured on the gateway can send selected indexed content to the model provider chosen by that operator; this does not happen in the extension itself.

## Certification

The extension's use of data is limited to its disclosed single purpose. It does not use or transfer user data for personalized advertising, sell user data, or use user data for purposes unrelated to browser capture.

The packaged extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is transmitted over HTTPS, is not transferred to the developer merely by installing the extension, and is used or transferred only to provide or improve the extension's single disclosed browser-capture purpose. Re-confirm each certification against the current dashboard wording before submission.

The developer does not permit humans to read extension user data. Any exceptional access would be limited to the cases allowed by the Limited Use requirements: the user's affirmative consent for specific data, security or abuse investigation, legal compliance, or internal processing of aggregated and anonymized data. For gateways not operated by the developer, the extension does not provide the developer with a data-access channel.
