<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (c) 2026 Adrien Conrath -->

# Help me install Omnesis

You are helping me install Omnesis across the devices I choose. Stay with me until the parts I want are working, or explain precisely what is blocking them. Work one step at a time: give me a short recommendation, ask only the questions needed for the next decision, and do the work you can do from this machine. Do not give me a long checklist to execute alone.

## Learn before changing anything

1. Read the current instructions at https://omnesis.dev/docs/install, https://omnesis.dev/docs/setup, and https://omnesis.dev/docs/apps, and inspect https://omnesis.dev/install.sh. Use `--dry-run` to confirm a chosen invocation before installing. Do not guess commands from this prompt. If any of these resources are unavailable, tell me what you could not verify before installing.

2. Inspect this machine read-only: operating system, architecture, available memory, Omnesis installation and services, Tailscale state, and whether it could stay on as a gateway. Do not read personal files or Omnesis indexed data to plan the install. Ask me which other computers, phones, and Chrome profiles I want to include. Do not scan the network or access another device without asking first; discovery may miss devices and does not tell you which ones I own.

3. Ask where I want the always-on gateway, whether other computers should collect data, whether I need access away from home, and whether I want phone apps or browser capture. Explain the simplest workable topology in a few sentences, including which machine gets each role. Confirm the topology with me before making system changes. If I am unsure, suggest a gateway and collector together on an always-on macOS or Linux computer, then add other devices later.

## Install and verify in stages

4. If I want access away from home, help me install and sign in to Tailscale on the gateway and relevant devices, and enable the MagicDNS and HTTPS certificate settings it needs. Let me handle account sign-in and admin-console actions. Explain that a certificate covers the gateway's Tailscale name, not its tailnet IP. Check connectivity before pairing remote devices. If I only need local access, explain the certificate and browser-extension implications before choosing that route. Do not expose the gateway publicly or change firewall/router rules unless I specifically choose that topology.

5. On the chosen gateway machine, use the official Omnesis installer at https://omnesis.dev/install.sh with the appropriate supported options. Show me the role, delivery method, and any privileged or service changes before running it. Let the installer handle its own interactive choices, including encryption at rest and model setup; do not silently pick a weaker security setting. Check the installed version, service status, TLS status, and `omnesis doctor`, and help me open and pair the portal.

6. For each additional computer I choose, explain whether it needs a collector or only the CLI. If you cannot access that computer, guide me to open a terminal or agent there and give me its role-specific installer command. Ask before using SSH or any other remote access. Use the gateway's verified address and certificate fingerprint. Mint a fresh pairing code through the documented gateway or portal flow; enter secrets only in the intended prompt, never in chat, shell history, logs, or an issue. Verify that each collector or client connects before proceeding to the next one.

7. Ask whether I want the iOS or Android app. If yes, use the current app and pairing instructions, guide me through the store installation and phone-side permissions, and verify the app reaches the gateway. For access away from home, test with the phone off Wi-Fi. Do not claim to have completed a phone-side step you cannot observe.

8. Ask whether I want browser capture and on which Chrome profiles. If yes, use the documented Chrome Web Store extension and pair each profile separately. Confirm the browser trusts the gateway certificate before pairing; the default self-signed certificate is insufficient for the extension. Explain what it captures and let me choose capture settings. Verify one deliberately chosen, non-sensitive test page reaches the gateway.

9. Ask if I want to add a first data source, then guide me through only the source I choose. Explain any permission or authentication request before I act. Verify its status without reading or repeating my indexed content.

At every stage, report what you observed, what changed, and the single next action. If a step fails, inspect the actual error and the relevant current docs, try a safe correction, and recheck. Ask before changing security settings, deleting data, overwriting an existing installation, or acting on a different machine. Never paste credentials, pairing codes, tokens, personal data, hostnames, or network addresses into an external service.

When we finish, summarize the topology and verified working parts, plus any unfinished optional steps. If an installer bug or manual workaround should be handled by Omnesis, ask whether I want a GitHub issue. If I do, draft it with reproduction steps, expected and actual behavior, and sanitized diagnostics; remove personal data, secrets, local paths, hostnames, addresses, and corpus details. Show me the exact draft for approval before posting it.
