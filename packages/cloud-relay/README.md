# Omnesis encrypted cloud relay (experimental)

This package implements Omnesis's outbound reverse tunnel, separately from the
push-notification relay. It uses native WebSocket/TCP streams with no cloudflared
or Tailscale dependency. Gateway integration and Google pairing require
`OMNESIS_CLOUD_RELAY_ENABLED=1`. This is independent of `OMNESIS_EXPERIMENTAL`;
experimental or synthetic mode alone never enables cloud relay features.

## Encryption and trust

The data listener forwards the client's original TLS handshake and encrypted
bytes. TLS terminates at the gateway. The relay does not parse application HTTP,
terminate application TLS, or receive gateway TLS private keys. Paths, device
tokens, OAuth grants, cookies, documents and WebSocket payloads remain encrypted.
The relay sees routing hostnames, account identifiers, timing, sizes and
availability. Google sign-in sends an identity token to the relay, including any account
claims Google includes. Only the immutable subject identifies the account.
Omnesis requests the `openid` scope, without email or profile scopes.

The control listener authenticates outbound gateways and allocates one-use data
tickets. The data listener routes bounded TLS ClientHello messages by SNI. A
native gateway tunnel can dial only its configured loopback HTTPS gateway. Old
plaintext tunnel clients are refused. Application HTTP on the control listener
is refused instead of falling back to hop-by-hop encryption.

Native clients and the CLI/collector adapter retain an independently verified
gateway key. New `pinned-key-strict` pairings hash the leaf certificate's complete
DER SubjectPublicKeyInfo with SHA-256; the separate `spkiFingerprint` field never
reinterprets a certificate fingerprint. The TLS handshake must prove possession
of that key, and the presented certificate must be current and cover the original
gateway hostname. Renewing the certificate with the same key preserves trust.

Existing `pinned-leaf-strict` pairings retain their exact certificate pin and need
an independently verified re-pair after certificate replacement. Neither strict
mode falls back to certificate-authority trust. Routing identity refresh cannot
replace a pin. Changing a pinned key requires another independent pairing.

Standard external MCP clients and browsers use ordinary HTTPS trust. They connect
to a per-gateway hostname without relay credentials, using the gateway's existing
OAuth discovery, PKCE, consent and access grants. An operator controlling that
hostname can obtain a replacement certificate: standard WebPKI alone does not
protect against that operator impersonating the gateway.

Both relay-owned and user-owned hostnames work. A user-owned domain pointing at
the relay still needs independent certificate issuance controls to resist that
attack, such as a supporting CA's account-bound DNS-01 policy, CAA `accounturi`
and `validationmethods`, and protected DNS administration. A DNS ownership TXT
record alone does not provide that protection. See [RFC 8657](https://www.rfc-editor.org/rfc/rfc8657.html)
and [Let's Encrypt's CAA guidance](https://letsencrypt.org/docs/caa/). This package
does not configure CAA records, DNS delegation, or a CA's account-bound issuance policy.
Keep the effective issuance policy under the user's control for every authorized
CA. A user-owned A/AAAA record avoids delegating CAA lookup to a relay-owned
CNAME target; using DNS-01 at the gateway alone does not prevent another party
from attempting HTTP-01 or TLS-ALPN-01 issuance.

## Initial pairing

QR/manual pairing remains available without Google. A QR carrying a strict pin
must come through an independently trusted channel.

Optional Google pairing follows these steps:

1. The device creates a private random challenge and signs in directly with
   Google. PKCE/state/nonce protect code flows; native clients independently
   verify Google's signature, issuer, audience, subject, expiry and nonce.
2. The relay lists that account's registered gateways. The user selects which
   gateway to pair with; a legacy singular lookup refuses ambiguous accounts.
   The selected binding proposes a TLS certificate; it is not an encryption trust anchor.
3. The requesting device asks the gateway for a challenge, which commits the
   gateway to a random nonce, then sends its request. Both compute a six-digit
   comparison code from the certificate, the device's private secret and that
   nonce; the gateway uses its own certificate
   ([why six digits are enough](../../docs/device-enrollment.md#comparison-code)).
4. Compare the code on the requesting device and the gateway's **local,
   directly opened portal or trusted terminal**. A browser reached through a
   relay-operated hostname is not an independent channel against that operator.
   The owner approves, and the requesting device separately confirms the match.
   A remote status cannot bypass local confirmation.
5. The device redeems the short-lived approval code over pinned TLS using normal
   device pairing, then saves the public-key pin derived from that same verified
   certificate and its scoped credential.

On the trusted gateway terminal:

```sh
omnesis cloud requests
omnesis cloud approve REQUEST_UUID --code "465 774"
# Or: omnesis cloud deny REQUEST_UUID
```

Google identity never creates a device, grants scopes, approves an MCP connection,
or substitutes for gateway consent. Historical Google gateway proofs expire;
initial trust uses the independent comparison, not an expired login token.

## Optional Omnesis account sign-in

An Omnesis account has its own permanent identifier. Google sign-in and synced
passkeys are credentials for that account; neither grants access to gateway data.
An account may have multiple linked gateways and multiple passkeys. Removing the
last usable sign-in method is refused. Link an additional method while signed in;
matching email addresses never merge accounts.

With `OMNESIS_CLOUD_RELAY_ENABLED=1`, gateway settings offer account linking and
unlinking. Native clients and `omnesis cloud pair --kind cli` or `--kind collector`
let the user sign in, explicitly choose a gateway, and request enrollment. By
default a trusted gateway device must approve the request, and the requesting
device must confirm the comparison code. A gateway whose owner chose
automatic enrollment lets a device-bound sign-in it has pinned join without that
step ([docs/device-enrollment.md](../../docs/device-enrollment.md)). The resulting
pinned device credential is independent of Google, passkeys, and the chosen LAN
or relay connection path. QR/manual pairing and independently configured direct
access remain available.

Desktop account sign-in uses the system browser, a launch capability that stops
working once somebody has signed in, and a private PKCE verifier. Only a short-lived, nonce-bound discovery credential
returns to the desktop; account management cookies stay in the browser. Native
Android Google sign-in uses Credential Manager with a server-issued nonce.

The desktop also listens once on `127.0.0.1` (RFC 8252 loopback redirect). After
the browser confirms, the relay sends it there with a one-use completion secret,
and only a desktop presenting that secret receives the sign-in proof that can
join automatically. A link phished to someone else ends on their own machine. A
connect code typed on another device never yields a proof, so the CLI says that
signing in elsewhere needs approval on the owner's phone or another paired
device; over SSH it prints the comparison code and waits for that approval.

### Deleting an account

The account page (`/_relay/account`) has "Delete account" in its "more options"
menu, beside "Sign out". After a
fresh sign-in and a separate final press, the relay deletes the account with its
sign-in methods and sessions, and the registration of every gateway connected to
it, in one transaction, and closes those gateways' tunnels. What each table keeps:

| Table                                                      | After deletion                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `omnesis_accounts`, `omnesis_account_consents`             | The account's row is deleted                                    |
| `omnesis_account_sessions`                                 | Every session of the account is deleted                         |
| `omnesis_federated_credentials`, `omnesis_google_aliases`  | Its Google sign-in and that sign-in's aliases are deleted       |
| `omnesis_passkeys`, `omnesis_passkey_endorsements`         | Its passkeys and the sign-ins that vouched for them are deleted |
| `omnesis_passkey_countersignatures`                        | Each passkey's countersignature of the account is deleted       |
| `omnesis_gateway_links`, `omnesis_account_admissions`      | Rows of the account and of each of its gateways are deleted     |
| `relay_accounts`, `relay_gateway_bindings`                 | Each gateway's owner row and binding are deleted                |
| `relay_gateway_recovery`                                   | Each gateway's recovery receipt is deleted                      |
| `relay_identity_aliases`                                   | Links from or to its sign-ins and gateways are deleted          |
| `relay_hosted_names`                                       | The row keeps a digest of the gateway id in place of the id     |
| DNS challenge journal (`OMNESIS_CLOUD_RELAY_ACME_JOURNAL`) | Leases of its gateways are removed, with their TXT records      |

A hosted name stays held for the gateway it was granted to, by a digest of that
gateway's id: its label can be ground and paired devices still know the address,
so no other gateway is given it, and the same gateway gets it back when it
registers again. Operator files are not touched: remove the person from
`OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE` yourself if they should not be able
to create an account again, and remove them from the sign-up Google Group if
the relay uses one. Request logs and metrics hold no account
identifiers.

Disconnecting one gateway from its settings removes that gateway's rows from the
same routing tables and its link, closes its tunnel, and leaves the account and
its other gateways alone. `omnesis_account_admissions` keeps which account that
gateway created, so an account no gateway uses is still removed when the gateway
creates another.

A removed gateway's session is refused with 401 and its next key registration
gets `410`. Either way the gateway turns remote access off and drops its account
link, session and invitation, and keeps its id, certificate and key, so its
paired devices keep working on the home network and it can be connected again at
the same address ([docs/device-enrollment.md](../../docs/device-enrollment.md)).

### What the relay is trusted with

Sign-ins on pages the relay hosts (portal enrollment, desktop sign-in, the owner
link, signup and the account page) are only as trustworthy as the relay: their
script computes the WebAuthn challenge and Google nonce, so a compromised relay
could bind the owner's sign-in to a device key of its own, and at link time could
have the gateway pin its own Google account or passkey and keep listing it.
Sign-ins in the iOS and Android apps compute the nonce on the device from its own
key and are not exposed to that. The gateway records each trusted sign-in's
origin and its portal shows "Signed in on the Omnesis account page" or "Signed in in the
app". A passkey's public key arrives with the request, so the gateway trusts a
passkey on approval only when the relay's credential list for the linked account
holds that id with that key, and drops a pin whose listed key changes. A passkey
added to an account later is stored only once a sign-in the account already has
vouches for it, and the new passkey itself countersigns the sign-ins the account
already had; gateways verify both themselves, so a gateway that trusts either
side comes to trust the other without an approval
(`docs/device-enrollment.md`, Passkeys added later). Gateways
that do not trust the relay with joining devices keep the default `ask` policy.

Account services require `OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN` to name the public
HTTPS control origin. A routing-only relay may omit it and does not initialize
account services. Explicit account key or app association configuration without
that origin is rejected.

The relay keeps a separate persistent account enrollment signing key. Operators
may set `OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE`; otherwise it resides beside the
relay database. Native passkey associations are configured through
`OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE`. iOS builds offering native passkeys
also enable `OMNESIS_CLOUD_RELAY_PASSKEYS_ENABLED=1`, use the matching cloud
entitlements file, and configure the associated domain in their signing profile.
These public app associations contain no private credentials.

## Google configuration

Credential files and the relay's own OAuth clients are configuration. The only
bundled identifiers are the official relay's public client IDs that gateways
trust (below); no secret is bundled. Native/public applications do not contain
web client secrets.

- **Managed browser sign-in:** the relay operator configures the shared web client
  with `OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID` and
  `OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE`. A separate owner-link web client
  uses `OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID` and
  `OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE`. Store both downloaded
  credential JSON files privately outside the source checkout, on the relay only.
  Register `${OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN}/_relay/v2/google/browser/callback`
  for both clients, and `/_relay/web/callback` at that origin for the discovery
  client. Gateways discover public client IDs; normal users configure neither
  OAuth secrets nor individual Google callback registrations. Native audiences
  and Android authorized parties are advertised by the same service. The gateway
  accepts only IDs from its compiled-in public deployment registry; discovery
  cannot expand that registry.
- **Gateway:** reserve a separate installed-application OAuth client in
  `OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID` for certificate registration.
  It must not be a web/mobile/ordinary desktop audience.
- **CLI/collector:** set `OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID`.
  If required, set `OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_SECRET_FILE` to Google's
  downloaded installed-client JSON, stored privately.
- **Accepted audiences:** configure `OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID` as
  comma-separated ordinary desktop, iOS and Android/web IDs on relay and gateway.
  The separately configured web ID is also accepted. Account keys use Google's
  immutable subject, never email.
- **Android presenters:** set `OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID` on
  relay and gateway to the trusted Android OAuth client IDs. Hybrid Google tokens
  can name the web client as audience and the Android client as authorized party;
  those are checked separately from gateway certificate attestation.
- **iOS:** configure `OMNESIS_GOOGLE_CLIENT_ID`, `OMNESIS_GOOGLE_CALLBACK_SCHEME`
  and `OMNESIS_CLOUD_RELAY_URL` in ignored `ios/Local.xcconfig`. Register the
  correct bundle identifier with Google.
- **Android:** configure `OMNESIS_GOOGLE_WEB_CLIENT_ID`, `OMNESIS_GOOGLE_ANDROID_CLIENT_ID` and
  `OMNESIS_CLOUD_RELAY_URL` using local build configuration. Register the correct
  application identifier and signing certificate with Google.

The public deployment registry is separate from OAuth secrets. The official
relay's public Google client IDs (owner-link client, device-enrollment client,
native device audiences and Android presenters) are compiled into the gateway
in `src/google-browser-trust.ts`, so a gateway with only
`OMNESIS_CLOUD_RELAY_ENABLED=1` offers managed Google sign-in. They are not
configuration: no environment variable or portal setting changes them, and the
relay's discovery response never adds to them. They only name which Google apps
may present a token; the gateway still checks Google's signature, issuer,
audience, presenter and nonce itself. The owner client is distinct from every
device audience and presenter. A relay can advertise a subset of those IDs; an
unexpected audience or presenter fails closed, so a relay running its own Google
clients leaves managed Google sign-in unavailable. Google JWT verification
checks the trusted audience again when redeeming a pending operation.

Isolated tests use synthetic credentials. Live Google sign-in additionally needs
native/desktop registrations and the web redirects. These commands do not change
DNS or deploy infrastructure.

## Relay and gateway setup

The relay requires `OMNESIS_CLOUD_RELAY_DB` and a private
`OMNESIS_CLOUD_RELAY_KEY_FILE` containing at least 32 random bytes. The control
listener defaults to loopback port 8787. Non-loopback control listeners need their
own `OMNESIS_CLOUD_RELAY_TLS_CERT_FILE` and `OMNESIS_CLOUD_RELAY_TLS_KEY_FILE`.

The separate opaque data listener defaults to port 8789. Set
`OMNESIS_CLOUD_RELAY_DATA_PORT` and arrange ordinary TCP forwarding from each
gateway hostname's HTTPS port, preserving TLS bytes. Control TLS credentials are
separate from gateway TLS credentials. Start with `npm run cloud-relay -- serve`.

Sign-in and account routes (logins, account pages, connect-code claims, native,
desktop and gateway-signup operations) share global bounds,
`OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS` (default 8) and
`OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE` (default 60), and each client address
has smaller ones, `OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS_PER_CLIENT` (default
half the global concurrency) and `OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT`
(default a third of the global rate), so one client cannot use up the global
bounds for everyone. The client address is the TCP peer, or the address a
trusted front layer reports (see [TCP front layers](#tcp-front-layers)), an IPv6
client counted by its /64. Polling or cancelling an operation already started holds a concurrency
slot but is not a new attempt.

For hosted names, set `OMNESIS_CLOUD_RELAY_DOMAIN`; a gateway gets
`g-XXXXXXXX.RELAY_DOMAIN`, where the eight characters are the start of the
lowercase base32 SHA-256 of its UUID. Such a short name can collide, so the
relay grants each name to the first gateway bound to it and never to another,
even after that gateway moves to its own hostname; a new gateway that draws a
taken name picks another UUID. For a user-owned hostname, publish
`_omnesis-gateway.HOSTNAME` TXT containing
`omnesis-relay-v2:ACCOUNT_ID:GATEWAY_UUID`. The gateway's public leaf certificate
must cover its hostname. Each gateway keeps its own stable UUID and hostname;
an account can link several independent gateways.

The relay's `OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN` must identify its externally
reachable control origin. Owner proofs bind that origin independently of the
request's Host header.

On the gateway, configure its normal isolated/local state and TLS plus:

```sh
export OMNESIS_CLOUD_RELAY_ENABLED=1
export OMNESIS_CLOUD_RELAY_URL=https://control.relay.example.test
export OMNESIS_PUBLIC_BASE_URL=https://gateway.example.test
export OMNESIS_CLOUD_RELAY_GATEWAY_ID=00000000-0000-4000-8000-000000000001
export OMNESIS_CLOUD_RELAY_SESSION_FILE=/srv/omnesis/keys/relay-session.json
export OMNESIS_TLS_CERT=/srv/omnesis/keys/gateway.pem
export OMNESIS_TLS_KEY=/srv/omnesis/keys/gateway-key.pem
omnesis cloud prepare-owner
```

`prepare-owner` creates a private Ed25519 owner key and prints only public
registration metadata, including the account ID and custom-domain TXT value.
Its default key path is `${OMNESIS_CLOUD_RELAY_SESSION_FILE}.owner-key`;
`OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE` overrides it. Back up this key privately.
It is separate from the TLS key and preserves gateway ownership across TLS
certificate and key renewal. Losing an established owner key fails closed;
a Google login or TLS key alone cannot replace it.

For a new public enrollment, the relay operator runs `omnesis cloud issue-invite`
with the relay's private `OMNESIS_CLOUD_RELAY_KEY_FILE`, its trusted
`OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN`, the intended gateway UUID, and a private
`OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE` output path. Transfer that invitation
file privately to the gateway and set the same enrollment-token-file variable
there. Invitations expire within one hour and authorize only the named UUID and
relay. Publish the public TXT metadata for a custom domain, then run:

```sh
omnesis cloud register-key
```

Start the gateway normally with the same configuration. Its outgoing tunnel
renews routing sessions using its owner and TLS keys; Google is optional.
Existing owners renew without another invitation.

A relay can instead connect a new gateway from its owner's sign-in.
`OMNESIS_CLOUD_RELAY_SIGNUP_POLICY` chooses who may: `invitation` (the default)
keeps the signup routes closed and answers them with 403; `allowlist` admits the
accounts and Google subjects listed in the private JSON file named by
`OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE`, read again on every check, as
`{"accounts":["<account ID>"],"googleSubjects":["<digest>"]}`, plus any account
that already has a linked gateway; `open` admits everyone the account capacity
allows. A refused sign-in shows the person the value to send the operator. The
public configuration advertises `signup` when the policy is not `invitation`.
Machines without a browser print a short code instead; the person enters it at
`/_relay/connect`, which continues to the same sign-in page.
`OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL` names a shorter address for that page
that the operator serves elsewhere as a redirect to it: an absolute `https` URL
of at most 200 characters without credentials, query or fragment, or the relay
refuses to start. The start responses then add it as `connectShortUrl`, and the
CLI and the gateway show it in place of `connectUrl`. It is display text only:
the relay serves nothing at it and nothing fetches it.
`/_relay/account?open=portal` opens the signed-in account's gateway portal when
the account has exactly one gateway, and is the account page otherwise.
A sign-in on the plain account page is also made for the gateway's portal, so
opening a gateway from the page does not ask for a second sign-in: the page
creates the browser's device key, binds the sign-in to it
(`POST /_relay/account/api/portal/start`), and when a gateway is opened fetches
the proof once (`POST /_relay/account/api/portal/handoff`) and passes it to the
portal in the URL fragment. The gateway verifies that proof itself and applies
its own enrollment policy. `docs/device-enrollment.md` describes the exchange.

An `allowlist` relay can also accept invitations through a Google Group: a
Google sign-in the allowlist does not admit is admitted when the email Google
verified for it is a member of the group, directly or through a nested group.
That covers a sign-in that creates an account and one for an existing account
that has no linked gateway, such as an invited person connecting a new gateway
after removing their last one. The allowlist and a linked gateway are checked
first, so they keep working without the group and never ask it, and approving
the sign-in that was just checked does not ask again. A passkey carries no
email, so a passkey sign-in the allowlist refuses stays refused, and the page
tells the person to start again and sign in with Google. Passkey account
creation still needs `open`. All three settings are optional, and with none of
them set nothing changes:

| Setting                                                    | Value                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP`                  | The group's email address, such as `testers@example.com`. Requires the `allowlist` policy, which then needs no allowlist file. |
| `OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE` | A Google service account's JSON key, mounted read-only (for example under `/run/secrets`). Required with the group.            |
| `OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL`         | Optional public `https` link where a refused person can ask to join, such as the group's page.                                 |

The relay refuses to start when the group is set without a readable service
account key (the file Google downloads: `type` `service_account`,
`client_email`, `private_key`, and the other fields it carries), when the join
link is not `https`, or when either file setting is present without the group.

The relay mints its own OAuth token for the service account (a JWT bearer grant
for the `cloud-identity.groups.readonly` scope, renewed a minute before it
expires), resolves the group's resource name once with `groups:lookup`, then
looks the address up with `memberships:lookup`. An address that is not a direct
member is checked with `memberships:checkTransitiveMembership`; Google answers
that method only for premium Cloud Identity and Workspace editions, so on
Cloud Identity Free the relay logs once an hour that nested groups are not
followed and admits direct members only. Every request has a ten-second timeout
and a bounded response. When Google cannot answer (a network error, an error
status or a credential Google refuses), the sign-up is refused with "We couldn't
check your invitation right now. Try again in a few minutes.", nothing is
recorded, and the same request can be retried. A person outside the group sees
"Omnesis accounts are invite-only for now." with the join link; the gateway sees
the ordinary `not-allowed` refusal.

For this check only, the relay's Google sign-in for connecting a gateway asks
for the `email` scope as well as `openid`, and only on a relay with a group. The address is used only if the ID token says `email_verified`,
compared lower-cased, and sent to Google once for the check. It is never stored,
logged or returned, and accounts stay keyed by Google's subject.

Setting it up on Google's side:

1. Add Cloud Identity Free to the domain that owns the group, if it has neither
   Cloud Identity nor Google Workspace.
2. Create the group, allow members from outside the organization, and let people
   ask to join (its page is the join link).
3. In a Google Cloud project, enable the Cloud Identity API, create a service
   account and download a JSON key for it.
4. In the Admin console, assign that service account the Groups Reader admin
   role. No domain-wide delegation is needed.

Migrating an existing
Google-only gateway requires proof of its exact current TLS key and certificate;
for a custom domain, first update its TXT value to the new owner account ID.

To enable optional Google discovery, configure the dedicated gateway OAuth
client, a private `OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE`, and the ordinary
accepted client audiences, then run `omnesis cloud link-google`. Google links
only discovery; control of the tunnel remains with the owner key. The pairing
owner defaults to the Google credential file's account;
`OMNESIS_CLOUD_RELAY_OWNER_ACCOUNT` overrides it explicitly.

`omnesis cloud unlink-google` removes directory discovery without needing a
Google login. To disable Google pairing on the gateway as well, remove its
Google pairing configuration and restart it. Neither action revokes existing
device grants; manage those through the gateway's device controls.

The relay account page is `/_relay/account`; `/_relay/web` redirects to it. Google
sign-in there needs the web OAuth configuration and
`OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN`.

On a CLI or collector machine, enable cloud relay and pair the
selected component:

```sh
omnesis cloud pair --kind cli --name "Personal CLI"
omnesis cloud pair --kind collector --name "Travel collector"
```

The installation supplies its relay service and independently trusted public
desktop OAuth client ID. Normal users do not create a Google client or supply a
web secret. The deployment ID is intentionally absent until provider setup is
complete; an unavailable installation offers QR/manual pairing instead.
Credentials and sessions default to private files under the selected
`OMNESIS_CONFIG_DIR`, with separate CLI and collector device bundles. Explicit
local environment overrides remain available for advanced installations.

Pairing saves the verified certificate/key pin and gateway-issued device
credential with mode `0600`. It installs that credential in the CLI token store
or the collector-specific token store. Existing CLI credentials are preserved:
use a separate configuration directory when creating a new cloud-paired CLI
identity. Inherited `OMNESIS_TOKEN` overrides retain their explicit
priority.

An opted-in component can discover its existing default bundle when no direct
route was selected and its active token still matches that bundle. A new manual
pairing or explicit direct configuration takes precedence. Help/version commands
do not start the adapter or contact a relay.

`npm run cloud-relay -- client` reads the device file and starts a loopback
adapter (port 8788 by default). It provides encrypted transport only; it does not
inject device credentials. Point the normal CLI/collector gateway URL at the
printed loopback URL before using that client configuration. Stop any older manual
adapter that occupies the selected port. A device-file adapter refuses a different device credential,
so an old client token cannot be sent to a newly paired gateway accidentally.
Manual `OMNESIS_CLOUD_RELAY_GATEWAY_URL`, `OMNESIS_CLOUD_RELAY_GATEWAY_FINGERPRINT`
and optional `OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE` also work without Google or a
relay session.

For isolated tests only, a loopback relay can use
`OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE`. Mock identity refuses public binds and cannot
be combined with real Google clients. Tests need no production gateway state.

## Recovering registrations after relay data loss

A gateway keeps its UUID, public hostname, owner identity key, public TLS key and
ACME account locally. Hosted names derive from the UUID, so replacing the relay's
IP address does not change an existing MCP URL. The relay's routing sessions are
temporary credentials; they are not gateway identities or device credentials.

Optional recovery receipts allow a clean relay to reconstruct registrations
without trusting a lost or modified database. An independent Ed25519 authority
signs a receipt binding the gateway UUID, owner public key, derived account,
public origin and logical relay origin. The gateway retains that receipt next
to its session file as `<session-file>.recovery.json`, or at
`OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE`. No private identity key is included.
Every registration still requires fresh proofs of possession of both the owner
key and the gateway TLS key.

The receipt endorses the owner identity, rather than freezing a historical TLS
key. An owner-endorsed TLS key change does not update existing client pins.
Compromise of the gateway's owner private key requires independent revocation
and re-enrollment; proving possession of a newly submitted TLS key is not a
second independently anchored recovery identity.

Keep the authority's private key on an independent operator system. The relay
receives only its public key and a signed current policy. Configure all of:

```text
OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE
OMNESIS_CLOUD_RELAY_RECOVERY_KEY_ID
OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_FILE
OMNESIS_CLOUD_RELAY_RECOVERY_POLICY_SHA256
OMNESIS_CLOUD_RELAY_RECOVERY_MIN_POLICY_EPOCH
OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN
OMNESIS_CLOUD_RELAY_DOMAIN
```

The policy digest and minimum epoch must come from the independent authority,
not from the relay being restored. Retain the authoritative revocation ledger
and those anchors outside the relay. A signature alone cannot distinguish an
older, still-valid policy from the current policy after total database loss.
If the independent authority and its current policy are also lost, recovery
cannot safely infer historical ownership.

The policy lists revoked gateway UUIDs and owner key fingerprints, and sets a
minimum receipt epoch/version. Receipts last at most ten years; policies last
at most thirty days. Publish a fresh independently signed policy before its
expiry. Expired policies fail closed, including existing relay authentication.
Long outages require a fresh policy. Old receipts cannot revive a revoked
gateway, and a stolen relay invitation cannot replace a receipt. Restored
database bindings are checked against the receipt before routing traffic.

These experimental CLI operations use explicit local file paths and do not
contact Google, DNS, a certificate authority or a relay:

| Command                                     | Purpose                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `omnesis cloud recovery-create-authority`   | Create a separate offline signing key and public key; never overwrite an existing authority.                 |
| `omnesis cloud recovery-request`            | Export the gateway's existing public owner identity without creating a replacement key.                      |
| `omnesis cloud recovery-sign-receipt`       | Sign a complete receipt payload on the independent authority system.                                         |
| `omnesis cloud recovery-sign-policy`        | Sign the current revocation policy and print its configuration digest.                                       |
| `omnesis cloud recovery-policy-digest`      | Print the canonical digest of a signed policy.                                                               |
| `omnesis cloud recovery-rotate-session-key` | Replace only the relay session-signing secret; restart the relay to invalidate old sessions and invitations. |

Set `OMNESIS_CLOUD_RELAY_ENABLED=1`. Offline signing uses
`OMNESIS_CLOUD_RELAY_RECOVERY_AUTHORITY_KEY_FILE`, with public output at
`OMNESIS_CLOUD_RELAY_RECOVERY_PUBLIC_KEY_FILE` for authority creation. Signing
and digest commands read `OMNESIS_CLOUD_RELAY_RECOVERY_INPUT_FILE`; signed
artifacts and public gateway requests use
`OMNESIS_CLOUD_RELAY_RECOVERY_OUTPUT_FILE`. Payload fields are defined by
`recovery-contract.ts`; public request fields come from the existing gateway
owner, and authority context, epoch and validity are chosen independently by
the operator. The authority private-key setting is explicitly refused by the
relay daemon. Session-key rotation uses `OMNESIS_CLOUD_RELAY_KEY_FILE` and
never rotates gateway TLS keys, owner keys, ACME credentials or device grants.

After a suspected compromise, rebuild from trusted code, provision the current
independent policy and anchors, replace the relay session key, and revoke and
replace any exposed DNS/OAuth credentials at their providers. Use a fresh relay
database if the integrity of the retained registrations cannot be established;
gateways can rebuild their authorized registrations from their receipts. Repoint the
existing DNS name to the replacement relay. Gateways automatically obtain new
routing sessions using their original keys and receipts after an HTTP 401;
ordinary network failures retry without changing identity. Heartbeat and
session-acquisition deadlines detect stalled connections. A deliberate stop,
revoked identity or invalid TLS peer is not bypassed to restore connectivity.

Recovery mode accepts persisted Google associations only with a valid,
domain-separated integrity seal under the current relay session secret. Normal
restarts preserve discovery; unsealed rows or session-key rotation require fresh
owner-authorized linking. These seals authenticate relay metadata; they do not
protect against an active attacker holding the relay secret. Existing paired
devices and MCP grants continue using their unchanged gateway identity.
Automated backups and provider deployment are outside this implementation.

## Independent DNS broker

The optional independent broker keeps Cloudflare mutation credentials outside
the exposed relay. Run `cloud-relay serve-dns-broker` on an independent host or
credential boundary that a compromised relay VPS cannot read. A second port on
the same compromised host does not provide that isolation. The broker needs
the current independent recovery policy and public trust anchors described
above, but no relay session-signing key, account database or Google credential.

Its operator configuration is:

```text
OMNESIS_ACME_DNS_BROKER_URL
OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND
OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT
OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE
OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE
OMNESIS_CLOUD_RELAY_ACME_ZONE_ID
OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME
OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE
OMNESIS_CLOUD_RELAY_ACME_JOURNAL
```

Non-loopback listeners require TLS. The private token file contains a JSON
`token` field. Limit its Cloudflare permissions to DNS editing in the intended
zone. The provider only publishes leased TXT records for the exact authorized
hostname, and abandoned leases are cleaned up from the durable journal.

The gateway selects this path with:

```sh
OMNESIS_ACME_DNS_PROVIDER=independent
OMNESIS_ACME_DNS_BROKER_URL=https://dns.example.test
```

It requires its existing signed recovery receipt. Each create/remove operation
obtains a fresh, bounded, one-use broker challenge and signs the exact operation
with both local private keys. The signature binds the broker recipient, gateway
identity, receipt and TXT value or lease ID. The broker verifies the independent
authority and current revocations before performing an operation. A stolen
relay HMAC, modified routing database or forwarded request cannot authorize a
different operation. The gateway receives no Cloudflare token.

Remove Cloudflare credentials and the DNS journal settings from the exposed
relay process in independent mode. Its startup rejects those credentials when
an independent broker is selected. Shared frontends may forward signed broker
requests, but must preserve the configured recipient and the independent
credential boundary. Existing inline DNS brokering remains available for
isolated testing and deployments choosing that trust model.

Selecting DNS-01 in the legitimate client does not stop an attacker from asking
a CA to use HTTP-01. Production issuance restrictions must therefore cover all
allowed CAs and validation methods. Keep CAA administration outside the relay's
write permissions; where supported, bind issuance to the gateway's ACME account
and DNS-01. Do not rely on CAA that the compromised component can rewrite.
The DNS records and provider credentials are operator deployment configuration;
this implementation does not apply them to a live zone.

## Optional certificate issuance monitoring

Gateway-owned monitoring can observe the gateway's public hostname through
[SSLMate's Cert Spotter API](https://sslmate.com/help/reference/ct_search_api_v1).
It is disabled by default. To enable it, set
`OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_ENABLED=1`; optional settings are
`OMNESIS_CLOUD_RELAY_CERTIFICATE_MONITOR_INTERVAL_MS` and
`OMNESIS_CLOUD_RELAY_CERTSPOTTER_API_KEY_FILE`. The private API-key file contains
an `apiKey` field and is sent only to the fixed provider HTTPS origin. Provider
access, quotas and credentials are operator configuration.

The observer sends the public hostname to that provider and compares certificate
public keys with the gateway's own stable TLS key. It parses certificate DER
itself and verifies hostname coverage. Same-key renewals are expected; another
key produces a local incident containing public certificate metadata. It never
changes pins, routing credentials or device grants. A bounded durable journal
retains incidents and pagination progress; failed or incomplete checks are
reported as unavailable or stale, rather than as successful observation.

The portal and CLI expose monitoring status, last completed observation and
incidents. An observing status describes the provider results checked so far;
it is not proof that every issuance has been observed. Monitoring detects
evidence and does not prevent fraudulent issuance. Requests contain no gateway
application bearer, Google token, DNS credential or private key.

When investigating an unexpected certificate, retain the public incident
metadata, compare the observed key with the local gateway key, and request
revocation through the issuing CA where appropriate. Rotate exposed cloud
credentials and review issuance authority and DNS configuration. If external
MCP credentials may have been intercepted, revoke the affected authorizations
at the gateway through a trusted device; replacing the relay alone does not
revoke gateway-issued grants. Re-pair pinned clients only after independently
verifying an intentional gateway key change.

## Validation

`npm run test:cloud-relay` enforces 100% statements, branches, functions and lines
for relay logic and new gateway/portal/CLI pairing logic. Real process tests cover
collector sync, CLI access, reconnects and standard MCP OAuth/SDK access through
opaque TLS, including revocation and ciphertext checks. Native logic, UI render
and end-to-end lanes run separately through the native build/test dispatcher.
Coverage reports describe measured source; rendering alone is not logic coverage.

### Prefer direct connections on the same LAN

After Google pairing has passed gateway-owner approval and the independent code
comparison, the CLI and collector obtain local connection hints from the gateway
inside its authenticated, pinned HTTPS session. These hints contain at most eight
private IPv4 or IPv6 ULA addresses and ports. The relay directory never receives
these addresses. Docker gateways use their locally recorded published host port.

Set `OMNESIS_CLOUD_RELAY_DEVICE_FILE` to the private device file saved by pairing.
With cloud relay enabled, the CLI and collector automatically start their
own private loopback adapter when no explicit `OMNESIS_GATEWAY_URL` is set. Their
existing device-token files remain authoritative. HTTP and WebSocket traffic retain
the canonical gateway Host/SNI and gateway TLS identity when dialing a LAN IP.

The adapter remembers whether it is on the gateway's network. It looks once
before it accepts its first connection, asking every saved LAN hint at the same
time, and again every 15 seconds. At home a connection tries the hints first,
the one that last answered before the others, and falls back to the public
gateway hostname. Away from home a connection goes straight to the public
hostname: it never waits on addresses that cannot answer. A check that reaches
the gateway on a hint moves an existing relay WebSocket home; requests already
running on the relay finish there.

Leaving home is decided by evidence. An address the network refuses or cannot
route, or one that answers with another TLS identity, ends the home route in one
check. An address that only fails to answer in 750 ms is checked again three
seconds later and the route is released if that is also unanswered, so one late
reply from a busy gateway changes nothing; a `429` or `5xx` from the gateway
counts the same way. A connection that finds the hints unanswered, or the relay
unreachable while away, triggers a check at once instead of waiting for the next
interval. When the home route is released, the adapter closes every connection
that used it, requests and uploads included, so clients retry over the relay
instead of waiting on a network that is gone.

Upstream sockets use TCP keepalive after 15 idle seconds, which finds a peer
that vanished while a request waits or a WebSocket is quiet. Keepalive cannot
see a route that dies under an upload, because unacknowledged data suppresses
its probes, so the adapter also gives up a connection that has held unsent bytes
for two minutes without the route accepting any. It applies no plain idle
timeout: a transcription request or a quiet event stream can be silent for much
longer and is left alone. A collector on this adapter reconnects its device
WebSocket after 45 seconds without a gateway frame instead of 90.

New Google pairings save a separate `tlsSpkiFingerprint` for the independently
approved leaf public key. This allows automatic certificate renewal using the
same key while still checking the current leaf's hostname and validity on every
TLS handshake. Existing device files without this field continue to require the
exact saved certificate. A new key requires another independent pairing.

A LAN hint is a route, not an authority. On another network the same private
address can belong to an unrelated machine, which is ordinary for a laptop. A
hint whose peer fails the saved TLS identity is skipped like an unreachable one,
reported once, and the connection continues over the public gateway hostname,
which must present the identical saved identity. Nothing is sent to the refused
peer: the adapter chooses a verified TLS connection before sending an HTTP body
or device credential, so it never replays application writes across routes. A
certificate, pin or hostname failure on the public gateway hostname itself, or a
gateway authorization failure on any route, is not retried elsewhere and stops
application traffic. Hints are refreshed from the gateway at startup and with
each check, over the home route when at home and over the public hostname
otherwise; a changed list is written back to the device file so a later start
away from home begins with current addresses. Temporary network loss retains
validated saved hints, while invalid identity or authorization fails closed. A
direct probe verifies the saved gateway TLS identity and authenticates the same
approved device through `/whoami`. The adapter never retries an HTTP body;
existing application cursors and idempotency rules own interrupted upload
retries. CLI help and local repair commands do not initialize the saved remote
adapter.

The Devices page can show Local, Relay, or Reconnecting pills. These are bounded,
ephemeral device-reported observations, separate from permissions and TLS trust.
Existing clients that do not report a route keep their ordinary presence display.
QR/manual pairing remains available without Google.

### Mixed direct and relay deployments

Cloud pairing is optional per component. A gateway can simultaneously serve
existing QR/manual clients, a direct collector on its LAN, and a Google-paired
collector through the relay. Existing direct HTTPS, Tailscale/Funnel, and public
MCP configurations keep their own routes and credentials. No Google registration
or relay is required for those configurations. An explicit component gateway URL
continues to win over automatic cloud-device routing; public-key pinning is
enabled only by a new pairing that explicitly selects that trust mode.

## Optional gateway-owned ACME certificates

ACME is optional and requires `OMNESIS_CLOUD_RELAY_ENABLED=1`. With no
`OMNESIS_ACME_DIRECTORY_URL`, it creates no files, certificate contexts, renewal
jobs, DNS requests or account keys. Existing direct/QR/Tailscale/Funnel paths
continue independently of Google and the relay.

The default hosted flow separates certificate issuance from DNS cooperation:

1. The gateway creates and retains its public TLS private key and ACME account key.
2. It sends its CSR and signed ACME requests directly to the configured CA.
3. An authenticated owner session asks the relay DNS broker to publish a DNS-01
   digest for that gateway's assigned hostname; the relay holds the scoped DNS-edit token.
4. The CA checks public DNS and returns the certificate directly to the gateway.
5. The gateway removes the challenge through the broker and serves TLS locally.

The broker receives no CSR, ACME account JWS or private keys. The gateway does not
receive the relay's Cloudflare token and needs no inbound Internet listener.

The gateway keeps its existing direct TLS certificate and private key. Public
TLS uses its own stable private key, independent of direct certificate renewal. Configure
a **separate** `OMNESIS_ACME_CERT_FILE` for the public hostname's certificate:

```sh
export OMNESIS_ACME_DIRECTORY_URL=https://acme-staging-v02.api.letsencrypt.org/directory
export OMNESIS_ACME_TERMS_ACCEPTED=1
export OMNESIS_ACME_CERT_FILE=/srv/omnesis/keys/public-mcp.pem
export OMNESIS_ACME_DNS_PROVIDER=relay
```

Agree to the configured CA's terms before enabling the flag. Use staging to exercise DNS/issuance during
setup, then configure the production directory. Staging certificates are not
publicly trusted and the production gateway deliberately refuses to activate
them; local CA tests use explicitly injected test trust roots. The public TLS key defaults to `${OMNESIS_ACME_CERT_FILE}.key`; set
`OMNESIS_ACME_KEY_FILE` to choose its private path. It is generated once with
exclusive publication and is never automatically rotated. A missing established
key fails closed until the original is restored. The ACME account key defaults
to `${OMNESIS_ACME_CERT_FILE}.acme-account`; set `OMNESIS_ACME_ACCOUNT_KEY_FILE`
to choose a different private path. No shared wildcard private key is created.

`omnesis cloud register-key` first creates a short-lived, separate bootstrap leaf
covering `OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN` (or `OMNESIS_PUBLIC_BASE_URL`
when the separate origin is absent) using a gateway-local public TLS key,
then proves owner/TLS key possession to enroll. The normal gateway startup also
prepares this bootstrap when necessary. Complete the invitation and hostname
ownership steps above before public issuance. An expired public leaf is replaced
by a fresh same-key bootstrap so renewal can recover; an unrelated hostname or
private key is rejected. Neither bootstrap nor renewal overwrites the direct
certificate.

The public hostname uses its own HTTPS SNI context on the gateway. Direct clients
continue seeing the existing default certificate. The hourly task renews inside
30 days of expiry and activates the validated public chain without restarting
listeners. Failed issuance retains the prior public certificate. Optional ACME
provider/configuration failures leave direct TLS available and retry through the
renewal task. The gateway retains the TLS key and ACME account key; the relay
receives only the public registration, DNS-01 digest and bounded challenge lease.
A replacement of the public TLS key remains an identity change that
strict clients must independently re-pair.

For relay-managed hosted names, the relay operator configures:

- `OMNESIS_CLOUD_RELAY_ACME_ZONE_ID` and `OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME`;
- `OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE`, a private JSON file containing
  `{ "token": "YOUR_SCOPED_CLOUDFLARE_DNS_TOKEN" }`;
- `OMNESIS_CLOUD_RELAY_ACME_JOURNAL`, a private durable challenge journal;
- `OMNESIS_CLOUD_RELAY_DOMAIN`, the managed hostname suffix.

The token needs DNS record edit access only to the intended zone. The relay
accepts only a raw gateway-owner session and derives the hostname from its stored
binding. Google discovery sessions cannot publish DNS records. TXT leases expire
within ten minutes, are limited per owner/globally, and are cleaned on completion,
failure, expiry and restart. Persist the journal across restarts. Provider outages
retain cleanup intents for retry.

A user-controlled domain outside the relay's zone uses gateway-local DNS
cooperation instead:

```sh
export OMNESIS_ACME_DNS_PROVIDER=cloudflare
export OMNESIS_ACME_DNS_ZONE_ID=YOUR_ZONE_ID
export OMNESIS_ACME_DNS_ZONE_NAME=example.test
export OMNESIS_ACME_DNS_TOKEN_FILE=/srv/omnesis/keys/domain-dns-token.json
```

Here the scoped token remains on the gateway; it is never sent to the relay.
Both the configured zone apex and its descendants work. The provider creates only
`_acme-challenge.<gateway-hostname>` TXT records and removes only its own exact,
tagged records. It does not change A/AAAA records, proxy settings or CAA policy.
Cloudflare must use DNS-only routing for the MCP hostname: HTTP proxying would
terminate client TLS at Cloudflare. Real DNS/Cloudflare/VPS operations are separate
from this locally testable implementation.

## TCP front layers

The data listener accepts plain TCP, reads a bounded TLS ClientHello to find its
SNI hostname, selects the enrolled gateway and forwards the original bytes in
both directions. Routing and authorization do not depend on Cloudflare headers,
edge IP ranges or a particular front-layer vendor. OAuth credentials and MCP
content remain inside the gateway-terminated TLS session.

The initial deployment uses Cloudflare DNS-only routing. A future Spectrum or
other TCP front layer is an operational choice only when it preserves TLS
passthrough, including the original ClientHello; TLS termination at that layer
would break this privacy property.

The relay names the client address of each data stream in the stream-open frame
on the gateway's authenticated control socket. The gateway's tunnel client, in the
gateway's own process, records it against the loopback socket it dials for that
stream, and the gateway's rate limits and audit lines then count each relayed
client separately (as `relay:ADDRESS`) instead of as one loopback peer. The relay's
own sign-in limits count the same address on the control listener. The address is
never used for authorization, and a relayed client's own forwarded headers are
never trusted.

By default that address is the TCP peer, so a front layer that forwards raw TCP
makes every client behind it share its one address. To keep clients apart, have
the front layer send a PROXY protocol header (HAProxy `send-proxy-v2`; v1 also
works) on its connections to both listeners, and name the front layer's own
addresses:

```sh
OMNESIS_CLOUD_RELAY_PROXY_PROTOCOL_FROM=192.0.2.0/28
```

The value is a comma-separated list of exact IPv4/IPv6 addresses or CIDR ranges;
a malformed entry or a `/0` range stops the relay at startup. Only on a
connection whose TCP peer is in the list does the relay read a header, before
the control TLS handshake or the data ClientHello, and there it is required: a
missing, malformed or oversized (over 512 bytes) header, or none within five
seconds, closes the connection. The header's source address becomes the client
address. A `LOCAL` header (a front layer's health check) and an unspecified or
`UNKNOWN` family keep the front layer's own address. No other peer's bytes are
ever parsed as a header: a forged header from a client that reaches the relay
directly stays part of its stream and fails the TLS handshake or ClientHello as
any other junk would, and that client is still counted by its own address. Name
only addresses that nothing but the front layer can connect from, since the
relay believes whatever address those peers report. The relay and the front
layer must change together: a listed front layer that sends no header is refused,
and a relay without the setting cannot read one. Unset, nothing changes. No DNS,
VPS or proxy configuration is changed by this package.

## Running behind a CDN

The control origin (the sign-in and account pages, the account and app APIs,
gateway registration) may sit behind a TLS-terminating reverse proxy such as a
CDN. The gateways' own hostnames must not: they are TLS passthrough, and a proxy
that terminates TLS there would read gateway traffic. Keep the control origin's
hostname when you do this. Passkeys, sign-in redirects, the app association files
and the signed gateway registrations are all bound to it.

The proxy sees what the control origin serves, which was never end-to-end
encrypted: sign-in exchanges, account sessions and gateway registration requests.
It does not see the content of gateway traffic. That content is encrypted to the
gateway's own key on every path, including inside the tunnel.

```sh
# The proxy's own address ranges: a list, or a file with one per line (# comments).
OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES=198.51.100.0/24,2001:db8:c::/48
OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES_FILE=/etc/omnesis-cloud-relay/proxies
# The header in which the proxy names the client. Default: cf-connecting-ip.
OMNESIS_CLOUD_RELAY_CLIENT_ADDRESS_HEADER=cf-connecting-ip
# A hostname for the same control listener that does not go through the proxy.
OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN=https://tunnel.example.test
# What a connection that bypasses the proxy may use: all (default) or tunnel.
OMNESIS_CLOUD_RELAY_DIRECT_ROUTES=tunnel
```

- **Client addresses.** The header is read only on a request whose connection
  comes from a listed range, where the connection's address is the one a PROXY
  protocol front layer reported, otherwise the TCP peer. From anyone else the
  header is ignored and the caller is counted by its own address. A missing,
  repeated or malformed header from the proxy names nobody, and the proxy's own
  address is counted. The address feeds the sign-in limits only, never
  authorization. Use one of the two range settings, not both. The file is read
  again every five minutes, so a timer that rewrites it from the proxy's
  published ranges needs no relay restart; an unreadable or invalid rewrite keeps
  the previous list. Also allow the control hostname only from those ranges at
  the TCP front layer, so the proxy cannot be bypassed.
- **The tunnel stays off the proxy.** A gateway's tunnel is two kinds of WebSocket
  on the control listener, and one of them carries the gateway's encrypted
  streams. With `OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN` set, a gateway whose tunnel
  handshake arrives through the proxy is answered with a redirect to that origin
  and opens its tunnel and data channels there. The origin must reach this same
  listener directly and be named in its certificate. A gateway that predates this
  keeps its tunnel through the proxy and still works; the relay pings every data
  channel at the heartbeat interval so a proxy's idle timeout does not cut a
  quiet stream. If a gateway cannot reach the named origin it falls back to the
  control origin and offers to move again five minutes later.
- **Direct connections.** `OMNESIS_CLOUD_RELAY_DIRECT_ROUTES=tunnel` refuses, with
  status 421, every request that did not come through the proxy except
  `GET /healthz`; tunnel upgrades stay available, since that is what the direct
  hostname is for. Set it only after the control hostname resolves to the proxy.
- **Caching.** Every response says `cache-control: no-store` except the two app
  association files, which are public and cacheable for five minutes.
- **Timeouts and sizes.** No route is a long poll (clients poll with short
  requests) and no request body exceeds 64 KB, so a proxy's idle timeout and body
  limit are not reached. With a proxy
  configured the relay keeps idle connections for 120 seconds, so the proxy does
  not reuse one the relay just closed.

Unset, none of this applies: no request header names a client and every route is
served to every caller, as before.

To add relay-based MCP access alongside an existing public or Funnel address,
keep `OMNESIS_PUBLIC_BASE_URL` pointing at that existing address and set
`OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN` to the new gateway hostname reached through
the opaque relay. The gateway explicitly allows both OAuth issuers. Each address
advertises its own authorization and token endpoints; a direct client can start
and refresh OAuth sessions while the relay is offline. Authorization codes and
refresh credentials retain their original MCP resource audience, and completing
approval from another portal address cannot change the selected issuer.

### Manage an optional gateway relay identity

With cloud relay enabled, **Settings → Omnesis account** and `omnesis cloud`
use the same authenticated gateway management API. Direct access, existing
manual QR devices, and the default TLS identity continue operating independently.
Opening status on an unconfigured gateway does not generate keys or contact a relay.

```sh
omnesis cloud configure --accept-terms
omnesis cloud status
omnesis cloud enable --invitation-file /private/gateway-invitation.json
omnesis cloud reconnect
omnesis cloud renew
omnesis cloud disable
omnesis cloud policy ask
omnesis cloud trusted-sign-ins
omnesis cloud remove-sign-in <id>
omnesis cloud disconnect
```

The portal page shows the account link, the address, the on/off control and the
new-device choice, plus one box when something is wrong. `omnesis cloud status`
prints the full record in plain text (address, registration, tunnel, both
certificates, the certificate monitor, the account link, the new-device policy,
trusted sign-ins and every reported error code); `--json` prints the gateway's
status as sent. `disconnect` removes the gateway from the account and leaves
remote access and paired devices as they are.

Preparation obtains the hosted hostname from the relay's bounded public
configuration endpoint and creates a stable gateway UUID and owner identity
locally. A custom domain can be selected with `--origin`; the relay still
requires its existing DNS ownership proof. A new public SNI identity must use a
hostname the current default certificate does not cover, including its SAN aliases
and wildcards; a collision returns `hostname-conflict` before key preparation or
activation. Existing non-ACME environment configurations retain their original
TLS identity. Adding a distinct ACME identity to a colliding name is refused.
Malformed saved management settings fail closed for optional relay startup while
direct gateway access remains available. `--acme-directory` chooses the CA;
`--accept-terms` records explicit consent before issuance. Public relay
operators issue the UUID-bound invitation with `issue-invite`; its private JSON
file is passed to `enable`, and its contents never belong in command arguments,
status output, or browser storage.

Enable performs key enrollment, starts the authenticated outbound tunnel, issues
the separate public SNI certificate, and probes public MCP metadata. Status
reports enrollment, actual tunnel readiness, certificate expiry, and separate
direct/public network identities. Failures use fixed error codes. Reconnect
retains the UUID and keys. Disable stops optional outbound connections and
renewal activity while retaining keys, device permissions, and the existing
public SNI context for already-paired LAN clients until certificate expiry.
An explicitly saved disabled identity restores that context after restart
without starting issuance or a tunnel. Disable does not revoke device grants.

Managed browser Google discovery linking uses the relay operator's separate
owner-link web client. The gateway signs each operation with its local owner key,
keeps a backend redemption secret, and independently verifies Google's original
ID token. The relay owns the shared Google callback and exchanges the code;
it returns only an opaque result reference through the browser. The gateway's
own state cookie and exact trusted callback origin preserve the initiating
portal session, including direct and LAN access. Device enrollment still needs
the independent comparison code and gateway approval; Google identity alone
never grants archive access.

Advanced self-hosted deployments can retain a gateway-local web client by setting
`OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID`,
`OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE`, and
`OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CALLBACK_URL` on the gateway. Its downloaded
JSON must list that exact gateway callback URI, and its dedicated client ID must
be accepted by the relay. This mode requires opening the portal at the configured
callback origin. Neither mode is required for key enrollment or tunnel operation.
Unlink removes discovery without revoking existing device permissions.

The portal uses the installation's relay service implicitly; it has no endpoint
field. New installations default to `https://relay.omnesis.app`. Operators may
select a different service with `OMNESIS_CLOUD_RELAY_URL`; existing saved
installations retain their selected service when that variable is absent.
Request bodies cannot override it: the legacy CLI `--relay` option only asserts
that the requested URL matches the installation selection. A conflicting
operator override on an already configured installation disables setup with
`relay-service-mismatch`; it does not migrate an identity or send its credentials
to another operator. Plan such a migration separately. The custom public gateway
origin remains independent of the relay service selection.

## Aggregate operator metrics

Set `OMNESIS_CLOUD_RELAY_METRICS_PORT` to enable a separate plain-HTTP
`GET /metrics` listener bound only to `127.0.0.1`. It is disabled by default;
port zero selects an ephemeral private port for tests. The public HTTPS control
and opaque TLS data listeners never expose this endpoint. Put any remote scraper
behind an authenticated private monitoring path; do not publish the metrics port.

The `cloud_relay_` Prometheus families describe active and registered gateways,
routing-account records and Google links, stream and login admission capacity,
tunnel lifecycle events, stream admission failures, data-plane connection events,
ingress/egress encrypted bytes, DNS publication and cleanup outcomes, active DNS
leases and queued operations, recovery-policy epoch/expiry, and process resources.
HTTP completion counts include exact status codes and duration histograms; route
and method labels come from fixed allowlists. Upgrade observations include the
101 response. Account, gateway, hostname, token, URL query and application payload
values never become metric labels.

Traffic counters include bytes received/sent on admitted data sockets, including
TLS handshakes; they do not represent decrypted HTTP or application payload sizes.
Live sockets contribute immediately. Counters reset on process restart, so use
Prometheus rates/increases rather than adding raw values across restarts. Tunnel
establishments and disconnections include intentional renewals and shutdowns;
heartbeat timeouts are reported separately. Registered-account counts describe
routing records, not unique people. DNS proof publication is not confirmation
that a certificate authority issued a certificate. A zero recovery expiry means
that independent recovery policy is not configured.

Native apps opt in separately at build time with `OMNESIS_CLOUD_RELAY_ENABLED=1`.
This controls Google sign-in before pairing without consulting a gateway. iOS
uses the corresponding build setting; Android reads the environment variable
or Gradle property. Valid platform OAuth configuration is also required. Direct
and QR pairing remain available with the cloud relay flag disabled.
