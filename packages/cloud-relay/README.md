# Omnesis encrypted cloud relay (experimental)

This package implements Omnesis's outbound reverse tunnel, separately from the
push-notification relay. It uses native WebSocket/TCP streams with no cloudflared
or Tailscale dependency. Gateway integration and Google pairing require
`OMNESIS_EXPERIMENTAL=1`.

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
2. The relay returns that account's registered gateway. Its directory response
   proposes a TLS certificate; it is not an encryption trust anchor.
3. The requesting device computes an 80-bit comparison code from the certificate
   and its private challenge. The actual gateway computes its code locally.
4. Compare the complete code on the requesting device and the gateway's **local,
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
omnesis cloud approve REQUEST_UUID --code AAAA-BBBB-CCCC-DDDD-EEEE
# Or: omnesis cloud deny REQUEST_UUID
```

Google identity never creates a device, grants scopes, approves an MCP connection,
or substitutes for gateway consent. Historical Google gateway proofs expire;
initial trust uses the independent comparison, not an expired login token.

## Google configuration

All identifiers and credential files are configuration. No real identifier or
secret is bundled. Native/public applications do not contain web client secrets.

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
  accepts only IDs from its independently trusted public deployment registry;
  discovery cannot expand that registry.
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

The public deployment registry is separate from OAuth secrets. Until deployment
client IDs are shipped, managed Google sign-in remains unavailable by default.
Operators can supply public IDs through
`OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID`,
`OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID`,
`OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS` (comma-separated
native audiences), and
`OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES` (comma-separated
presenters). The owner client must be distinct from every device audience and
presenter. These are installation configuration, not user-facing portal settings.
A relay can advertise a subset of those IDs; an unexpected audience or presenter
fails closed. Google JWT verification checks the independently trusted audience
again when redeeming a pending operation.

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

For hosted names, set `OMNESIS_CLOUD_RELAY_DOMAIN`; gateway UUIDs map to
`g-UUID_WITHOUT_DASHES.RELAY_DOMAIN`. For a user-owned hostname, publish
`_omnesis-gateway.HOSTNAME` TXT containing
`omnesis-relay-v2:ACCOUNT_ID:GATEWAY_UUID`. The gateway's public leaf certificate
must cover its hostname. Keep the UUID stable: one account has one durable UUID.

The relay's `OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN` must identify its externally
reachable control origin. Owner proofs bind that origin independently of the
request's Host header.

On the gateway, configure its normal isolated/local state and TLS plus:

```sh
export OMNESIS_EXPERIMENTAL=1
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
Existing owners renew without another invitation. Migrating an existing
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

The relay discovery page is `/_relay/web`; enable it with the web OAuth
configuration and `OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN`.

On a CLI or collector machine, enable the experimental features and pair the
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
ACME account locally. Hosted names use the full UUID, so replacing the relay's
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

Set `OMNESIS_EXPERIMENTAL=1`. Offline signing uses
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

Recovery mode does not restore Google aliases from database claims. A fresh
owner-authorized Google link restores discovery; existing paired devices and
MCP grants continue using their unchanged gateway identity without Google.
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
With experimental mode enabled, the CLI and collector automatically start their
own private loopback adapter when no explicit `OMNESIS_GATEWAY_URL` is set. Their
existing device-token files remain authoritative. Each connection tries the saved
LAN hints first, with a bounded attempt budget, then uses the public gateway
hostname if the local network is unreachable. HTTP and WebSocket traffic retain
the canonical gateway Host/SNI and gateway TLS identity when dialing a LAN IP.

New Google pairings save a separate `tlsSpkiFingerprint` for the independently
approved leaf public key. This allows automatic certificate renewal using the
same key while still checking the current leaf's hostname and validity on every
TLS handshake. Existing device files without this field continue to require the
exact saved certificate. A new key requires another independent pairing.

A certificate, pin, hostname, or gateway authorization failure does not trigger a
relay retry. The adapter chooses a verified TLS connection before sending an HTTP
body or device credential, so it never replays application writes across routes.
Gateway discovery hints are refreshed at adapter startup; temporary network loss
retains validated saved hints, while invalid identity or authorization fails
closed. Paired adapters check for route changes every 15 seconds with bounded,
single-flight probes. A direct probe verifies the saved gateway TLS identity and
authenticates the same approved device through `/whoami` before replacing an
existing relay WebSocket. Lost local routes reconnect through the ordinary client
reconnect path. The adapter never retries an HTTP body; existing application
cursors and idempotency rules own interrupted upload retries. CLI help and local
repair commands do not initialize the saved remote adapter.

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

ACME is optional and requires `OMNESIS_EXPERIMENTAL=1`. With no
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
would break this privacy property. The listener does not automatically accept or
strip PROXY protocol preambles. Any future explicit client-address metadata must
remain separate from gateway authorization and require its own trusted ingress
configuration. No DNS, VPS or proxy configuration is changed by this package.

To add relay-based MCP access alongside an existing public or Funnel address,
keep `OMNESIS_PUBLIC_BASE_URL` pointing at that existing address and set
`OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN` to the new gateway hostname reached through
the opaque relay. The gateway explicitly allows both OAuth issuers. Each address
advertises its own authorization and token endpoints; a direct client can start
and refresh OAuth sessions while the relay is offline. Authorization codes and
refresh credentials retain their original MCP resource audience, and completing
approval from another portal address cannot change the selected issuer.

### Manage an optional gateway relay identity

With experimental features enabled, **Settings → Relay** and `omnesis cloud`
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
```

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
