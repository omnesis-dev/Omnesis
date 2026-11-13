# Sign-in device enrollment

A new device joins a gateway when its owner signs in. The gateway verifies the
sign-in itself; the relay only carries bytes. `packages/cloud-relay/src/device-enrollment.ts`
is the wire contract and its test file holds the cross-platform vectors.

Rules that must survive every change:

- The relay can make a gateway stricter, never looser. Nothing the relay says can
  add a trusted sign-in, change the enrollment policy or approve a device. A
  trusted sign-in added at link time is the one accepted trust-on-first-use window.
  A passkey added to the account later is trusted only on a vouching sign-in the
  gateway verifies itself (see Passkeys added later).
- A linked gateway joins trusted sign-ins automatically unless its owner switched
  to `ask`. Only a local owner action writes that choice.
- Anything unverifiable falls back to today's held request with a comparison
  code. It never dead-ends.
- A relay-signed attestation (`account-enrollment-proof.ts`) can only admit a held
  request. It can never join a device.

## Device key

Each install keeps one P-256 key `K`. Public keys travel as base64url DER SPKI;
signatures as base64url DER, or IEEE P1363 from WebCrypto.

| Client         | Storage                                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| iOS            | Secure Enclave when available, this-device-only Keychain otherwise             |
| Android        | Android Keystore, StrongBox when present                                       |
| Portal         | Non-extractable WebCrypto key in IndexedDB; see the account page handoff below |
| CLI, collector | Mode `0600` file beside the device bundle                                      |

## Enrollment

1. The device loads `K`, then computes `nonce = enrollmentNonce(requestId, kind, name, secret, K.public)`.
2. Sign-in commits to `nonce`:
   - Google: the token's `nonce` claim is `googleProofNonce(salt, nonce)`.
   - Passkey: the WebAuthn challenge is `passkeyProofChallenge(salt, issuedAt, nonce)`.
   - The relay chooses `salt` and `issuedAt`; the device recomputes the value and refuses a mismatch before prompting.
3. The relay lists gateways and proposes a certificate. With one gateway the device skips the chooser.
4. The device opens TLS pinned to the proposed certificate and calls `POST /devices/account/challenge`, receiving a one-use `challenge` (two minutes). The challenge is also the gateway's commitment to its part of the comparison code (see Comparison code).
5. The device signs `enrollmentSignatureTranscript(requestId, kind, name, SPKI hash of the proposed cert, challenge, K.public)`.
6. The device calls `POST /devices/account/request`:

```json
{
  "requestId": "…",
  "kind": "ios",
  "name": "iPhone",
  "secret": "…",
  "identityToken": "relay attestation",
  "deviceKey": { "publicKey": "…", "challenge": "…", "signature": "…" },
  "proof": { "type": "google", "idToken": "…", "salt": "…" },
  "requireApproval": false
}
```

The response is `{ status, verificationCode, codeNonce, expiresAt, pairingCode? }`:
`status` is `approved` with a `pairingCode` when the device joined, or `pending`
for a held request. `POST /devices/account/poll` (`{ requestId, secret }`)
returns the same shape. The rest of the flow, including `POST /devices/pair`, is
unchanged.

A device sets `requireApproval` when the proposed certificate failed its public
checks, so the human comparison replaces them.

### What the gateway checks

A `deviceKey` whose signature, challenge or SPKI hash fails is refused with 403,
because it means the request was not meant for this gateway. Otherwise the
request joins only when all of these hold:

- `proof` verifies: Google signature, issuer, audience from the gateway's own registry, expiry and nonce; or the passkey signature against the pinned public key with this `nonce`-bound challenge, the relay's RP ID and a trusted origin.
- The proof is at most 10 minutes old.
- The Google subject digest or passkey credential is in Trusted sign-ins.
- Policy is `automatic` (the default once linked) and `requireApproval` is not set.

If not, a valid attestation holds the request for approval. Approving a held
request with a verified proof can add that sign-in to Trusted sign-ins, but only
when the gateway can check it: a Google subject is named by Google's signature,
while a passkey's public key travels with the request, so anyone can make one
that verifies. A passkey is offered for trust (`canTrustSignIn`) only when the
relay's credential list for the linked account holds that credential id with
that public key; if the list can't be read, it is not offered.

## Comparison code

A held request shows a code on the new device and on the device that approves
it: six digits in two groups, `465 774`. The person approves only when both show
the same code. That comparison is what stands between the owner and a substitute
gateway (a certificate the relay proposed that is not the gateway's), and it is
how they tell their own request from someone else's.

### Why six digits are enough

The code used to be 80 bits of a hash over the certificate fingerprint, the
request id and the device's secret. Whoever sends a request chooses all three, so
the only thing that stopped a forger from making a second request with the same
code was the cost of 2^80 hashes. Cut to six digits, that derivation would be
broken in about a million hashes, under a second: a substitute gateway reads the
victim's code, grinds a request of its own until the real gateway shows the same
six digits, and the owner approves the forger's device.

A short code is safe only if nobody can pick their input after seeing the other
side's. So the gateway now contributes a random nonce, and commits to it first:

1. `POST /devices/{account,google}/challenge` returns `challenge`. The gateway
   has drawn a random 32-byte `codeNonce` and
   `challenge = pairingCodeCommitment(codeNonce)`, a hash that fixes the nonce
   without revealing it.
2. The device sends its request, which reveals `secret` (32 random bytes it has
   shown to nobody) and names the challenge: in `deviceKey.challenge`, or as a
   top-level `challenge` when the request has no device key. Never both.
3. The gateway spends the challenge and answers with `codeNonce`. The device
   checks `pairingCodeCommitment(codeNonce) == challenge` and refuses to show
   any code otherwise.
4. Both sides compute `pairingComparisonCode` over the request id, the secret,
   a certificate fingerprint and `codeNonce`. The device uses the certificate
   it connected to, the gateway its own. The device also refuses a reply whose
   `verificationCode` differs from what it computed, or a later poll whose
   `codeNonce` changed.

A substitute gateway in the middle has to send the device a challenge before it
learns the device's secret, and has to send the real gateway a request before it
learns the real nonce. Whichever it does first, one side's code is already fixed
by a value it could not see, so the two codes agree only by chance: one in a
million per code. Nothing can be ground offline, because the nonce is revealed
only once the request is fixed, a challenge is spent by its first use (also when
the request is refused), and a repeated request is answered with its first nonce.

This relies on the device's `secret` being unknown to everyone until the request
is sent: it is generated on the device, sent only to the gateway's `request` and
`poll` routes over the pinned connection, and reaches the relay only inside the
enrollment nonce's hash.

### What the code is

```
digest = SHA-256(UTF-8 of JSON array, no spaces:
  ["omnesis-pairing-code-v3", gatewayFingerprint, requestId, secretHash, codeNonce])
code   = (first 6 bytes of digest as a big-endian unsigned integer) mod 1,000,000
```

`gatewayFingerprint` is the lowercase hex SHA-256 of the certificate's DER,
`secretHash` the lowercase hex SHA-256 of `secret` as sent (its 64 hex
characters as UTF-8), `codeNonce` and `challenge` 43-character unpadded
base64url. The code is the six decimal digits, zero-padded, with one space after
the third: that string is what travels as `verificationCode`, what every screen
shows, and what is compared. `formatPairingCode` turns typed input into it
(spaces and hyphens are ignored). Forty-eight bits reduced modulo a million
leave each code within four parts in a billion of equally likely.
`pairingCodeCommitment(codeNonce)` is the unpadded base64url SHA-256 of the JSON
array `["omnesis-pairing-code-commitment-v1", codeNonce]`.

### How many tries a forger gets

Only someone who can get a request admitted can put a code in front of the
owner: the relay, with its attestation, or someone the owner signed in for.
Each admitted request shows one independent code, and:

- at most 8 requests wait for approval at once; a further one is refused with
  429 before its nonce is revealed, and only the owner's decision or expiry
  frees a place;
- a request lives ten minutes and its code never changes;
- challenges last two minutes, and `challenge`, `request` and `authorize` share
  one limit of 10 calls a minute and 100 an hour per address.

So while the owner compares, a forger has at most 8 codes in the list, and at
most 16 over the ten minutes a request lives: a chance of 8 to 16 in a million
per pairing the owner attempts, with a list full of requests the owner did not
make. A failed attempt cannot be retried without the owner starting over.

### Where it is shown

| Flow                                                             | New device                                              | Why the code matters                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| App, CLI or collector signs in (`/devices/account`, device key)  | Computes it; shows it while held                        | The signature already binds the gateway key; the code covers an unlogged certificate |
| CLI over SSH or a typed connect code                             | Prints it and waits; types it if the cert is not logged | Same, and nothing was proved about the machine                                       |
| Google pairing without a device key (`/devices/google`)          | Computes it; the CLI always asks for it to be typed     | The code is the only check on the proposed certificate                               |
| Portal signs in itself (device key, or the account page handoff) | Computes it after its own challenge and request         | Tells requests apart                                                                 |
| Portal returning from a sign-in redirect (no device key)         | Computes it from `poll`; there is no challenge          | Tells requests apart                                                                 |

In the last flow the gateway starts the request itself when the browser returns,
so there is no challenge and the nonce is simply drawn. Nothing is lost: a
browser runs the page its server sent over a connection the browser verified, so
no code shown by that page can detect a substitute server, here or before.

Approving devices show `verificationCode` as listed by
`GET /admin/cloud-pairing/requests`: the portal's pairing requests, the iOS and
Android approval sheets, and `omnesis cloud requests`. `omnesis cloud approve
<id> --code` takes the code typed from the new device.

## Device rows

A sign-in enrollment creates a new row. It adopts an existing row only when that
row's stored device key equals `K`, which the signature has just proved; install
IDs, previous IDs and names never select a row for these pairings. The row records
key, method (`automatic` or `approved`), sign-in kind and join time.

## Trusted sign-ins

`<config>/cloud-relay/account-link.json` holds the link, `enrollmentPolicy`
(`automatic`, `ask`; absent means `automatic`) and `trustedSignIns`. Link and signup
flows deliver one proof, verified and pinned locally. Gateways poll
`GET /_relay/v3/account-browser/credentials`, which lists Google subject digests
and passkeys as `{id, publicKey, endorsement?}`; a pin missing from that list, or a
passkey pin whose key differs from the listed one, is dropped.

A link with no stored policy behaves as `automatic`: linking is the owner's
consent, and there is no separate first choice. Only an explicit `ask` holds
every request. The file is written only by local owner actions (the Omnesis
account settings in the portal or the iOS and Android apps, `PUT /admin/cloud-relay/enrollment`,
`omnesis cloud connect --ask-first`), so the relay can neither set nor clear the policy. A gateway that
is not linked joins nothing by sign-in, and a linked gateway with no trusted
sign-ins still holds every request for approval.

### Passkeys added later

A passkey added to an existing account must be usable at once, without an
approval, and without the gateway believing the relay's list. So a sign-in the
account already has vouches for it:

1. The account page creates the passkey. The relay verifies it and holds it in
   memory for five minutes; nothing is stored.
2. The person confirms with Google or another of the account's passkeys. That
   sign-in commits to `passkeyEndorsementNonce(credentialId, publicKey)` the way
   an enrollment sign-in commits to its nonce (`googleProofNonce`,
   `passkeyProofChallenge`). This is also the proof of presence, so adding asks
   for no earlier confirmation.
3. The relay stores the passkey with that sign-in proof and lists both at
   `GET /_relay/v3/account-browser/credentials` (`passkeys[].endorsement`).
4. A gateway pins a listed passkey (source `endorsed`) only when the proof
   verifies against that id and key and its signer is already pinned: a Google
   subject by Google's signature, a passkey against its pinned key. A passkey
   can't vouch for itself, and one pinned this way can vouch for the next.

The proof is checked as of when it was made, not against the 10-minute limit: it
names one passkey and can do nothing else, and a gateway that was offline must
still be able to accept it. A Google proof stops verifying once Google retires
the signing key, after which that passkey falls back to approval. Gateways sync
hourly and whenever an unknown passkey signs in. Removing a passkey pin on
the gateway is the owner's decision (`declinedPasskeys`): no vouching pins that
passkey again, only approving a device that signed in with it.

Each pin records its `source`: `link-page` (the relay's link or signup page),
`approval` (approving a request signed in on a relay page: desktop or portal),
`endorsed` (above) or
`native-app` (approving a request signed in in the iOS or Android app).
`omnesis cloud trusted-sign-ins` lists each pin with its source, and
`omnesis cloud remove-sign-in <id>` drops one; the portal does not list them. See
Limits of automatic mode for why the source matters.

## Relay surfaces

- `POST /_relay/v3/native/start` also returns `salt`; `googleNonce = googleProofNonce(salt, nonce)`.
- `POST /_relay/v3/native/passkeys/options` also returns `salt` and `issuedAt`, with the bound challenge.
- `POST /_relay/v3/native/passkeys/complete` also returns `credentialPublicKey`.
- Browser and desktop operations need a fresh sign-in on that operation, even with a session cookie. Browser redemption returns `signInProof`; desktop redemption only as below.
- `POST /_relay/account/api/portal/start` and `POST /_relay/account/api/portal/handoff` let the plain account page's sign-in serve a gateway's portal; see the handoff section below.

## Desktop sign-in proves the same machine

A CLI or collector's sign-in happens in a browser, so the proof could be phished:
someone starts `POST /_relay/v3/desktop/start` with their own device key and
sends the owner the link or code. The proof leaves the relay only to a desktop
that shows the sign-in finished on its own machine (RFC 8252 §7.3):

1. The client listens on `127.0.0.1` on a random port, single-use, for the life
   of the operation, and sends `loopbackPort` in `desktop/start`.
2. After the browser confirms, the relay redirects it to
   `http://127.0.0.1:<port>/omnesis/callback?operationId=…&completion=…`, with a
   fresh 32-byte `completion` whose hash it keeps on the operation. The listener
   accepts only that path, its own `Host` and the operation it started, and its
   page says the sign-in finished and can be closed.
3. `POST /_relay/v3/desktop/redeem` returns `signInProof` only with the matching
   `completion`. For 15 seconds after confirmation a redemption without it stays
   `pending`, so the browser can arrive; after that it returns discovery
   without a proof.

A phished link sends the owner's browser to the owner's own loopback, so the
attacker never learns `completion`. Without a proof the gateway holds the request
for approval with a comparison code, as for any unverified sign-in.

## The account page hands its sign-in to the portal

Someone who signs in on the relay's account page and then opens a gateway from
its list would otherwise sign in twice: the gateway wants a proof bound to a
device key, and a plain account session carries none. So on the plain account
page the sign-in itself is made for the portal, the way a native app makes it:

1. Before "Sign in with Passkey" or "Sign in with Google", the page generates
   a P-256 key, a `requestId`, a `secret` and a `Portal xxxxxxxx` name, computes
   `enrollmentNonce` for kind `portal`, and calls
   `POST /_relay/account/api/portal/start` with that nonce. The relay keeps an
   operation for ten minutes, bound to the page's browser cookie. The material
   waits in `sessionStorage`, so it survives the Google redirect.
2. The sign-in carries `?portal=<operationId>`, which binds the WebAuthn
   challenge or the Google nonce exactly as in Enrollment step 2. Creating an
   account and changing sign-in methods never carry it.
3. When the person opens a gateway, the page calls
   `POST /_relay/account/api/portal/handoff?portal=<operationId>` with that
   `gatewayId`. The relay requires the same browser cookie, a session for the
   account that made the proof, and a gateway bound to that account. It answers
   once with the relay attestation for that gateway, the `signInProof` and the
   gateway's `publicOrigin`, and forgets the operation.
4. The page navigates to `<publicOrigin>/portal/#account-signin=<base64url JSON>`:
   `{ v: 1, requestId, name, secret, privateKey (JWK), devicePublicKey, identityToken, proof }`.
   A fragment is never sent to a server. The portal takes it out of the address
   bar before anything else runs, imports the key as this origin's
   non-extractable device key (replacing any earlier one), and continues at
   Enrollment step 4 with `identityToken` and `proof` inline.

From there the gateway decides as for any request: a trusted sign-in joins under
`automatic`, anything else is held with a comparison code. If any step is
unavailable (no WebCrypto, blocked storage, a refused start or handoff, a gateway
without automatic enrollment), the portal asks for its own sign-in as before.

The handoff is single use and the proof is at most ten minutes old, the same
limit the gateway applies. The private key does cross from the relay's origin to
the gateway's in the fragment, so for those few seconds it is extractable where
the portal's own key never is. That adds nothing to what the relay page can
already do: as Limits of automatic mode says, the page computes the nonce, so a
compromised relay could bind the sign-in to any key it likes without this flow.
Whoever reads the fragment could join as that browser, which is why it leaves
the address bar at once, is never logged or stored, and is sent only to the
gateway's `/devices/account/*` routes. Everything in it names one request, and
the proof expires with the ten-minute window.

## Connecting without a browser

`POST /_relay/v3/desktop/start` returns `connectUrl` and a short `code`. A machine
that cannot open a browser prints both. A relay with
`OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL` set also returns it as `connectShortUrl`,
which is printed in place of `connectUrl` and never fetched. `/_relay/connect` takes the code, shows the
machine's name, and continues to the normal sign-in page. A code can be typed on
any machine, so an operation reached through it never returns `signInProof` and
never redirects to a loopback: the device always waits for approval on the
owner's phone or another paired device, which the CLI, the relay page and its
completion page say. Over SSH the CLI prints the six-digit comparison code to check on the
approving device, then waits and continues once the request is approved; nothing
is typed. If the gateway certificate is not publicly logged, the CLI instead asks
for the code shown on the approving device before it waits.

## Connecting a gateway

`POST /_relay/v3/signup/start` is signed by the gateway's owner key and returns
`authorizeUrl`, `connectUrl`, `code`. After sign-in, subject to the relay's
`OMNESIS_CLOUD_RELAY_SIGNUP_POLICY` (`invitation`, `allowlist`, `open`),
`POST /_relay/v3/signup/poll` returns an enrollment invitation and sign-in proof.
The gateway registers with the invitation, then `POST /_relay/v3/signup/link`
binds the account using its new owner session.

Under `allowlist`, the relay may also take invitations from a Google Group
(`OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP`, its service account key in
`OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE`, and an optional
`https` link to ask to join in `OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL`;
`packages/cloud-relay/README.md` lists the Google-side setup). It applies only
to a Google sign-in that would create an account and that the allowlist does not
already admit: the relay's sign-in then also asks Google for the `email` scope,
and the address Google marked `email_verified` is checked once against the group
through the Cloud Identity Groups API. The address is never stored, logged or
returned, and the account is keyed by Google's subject as always. A member
creates the account; anyone else is refused with "Omnesis accounts are
invite-only for now." and the join link, and the gateway's poll sees the usual
`not-allowed`. If Google cannot answer, the sign-up is refused for now ("We
couldn't check your invitation right now. Try again in a few minutes."),
nothing is recorded, and the person can sign in again on the same request.
Existing accounts are never checked against the group.

### Accounts are created on purpose

Signing in never creates an Omnesis account. One is created only while connecting a
gateway, and only when the person chose to create it:

- The portal and the apps offer "Create an Omnesis account" and "I already have
  one". `POST /admin/cloud-relay/connect` carries that as `intent` (`create`,
  `existing`), and `signup/start` passes it on unsigned: it only picks the page's
  first view, and the person can switch there (`POST /_relay/account/api/intent`).
- In `existing` mode, and on every other sign-in (the account page, device and
  browser pairing, desktop sign-in), a verified sign-in that no account uses ends
  with "There's no Omnesis account for this sign-in" and creates nothing.
- Creation records when it happened and the terms version in force
  (`omnesis_account_consents`; `none` until account terms exist).
- After a successful sign-in the page goes on by itself. There is no separate
  "connect" step to press.

A gateway holds one account it created. It may create another once it is no
longer connected to that one. The earlier account is then deleted if no gateway
uses it, and kept if another still does.

Disconnecting a gateway (`POST /admin/cloud-relay/account/unlink`, the portal's and
apps' "Unlink this gateway") is complete. The gateway leaves its account and
can no longer be reached through the relay: the relay removes its link, owner
row, binding, recovery receipt and DNS challenge leases and closes its tunnel
(`POST /_relay/v3/account-browser/unlink`, signed in as the gateway's owner key).
The account stays, with its other gateways, even if it has none left.

On the gateway, remote access goes off and the account link, enrollment policy,
trusted sign-ins, relay session, invitation and recovery receipt are removed, so
its status is that of a gateway with no account and no registration and the
portal offers "Enroll this gateway in your Omnesis Account". What it keeps is its
own: the gateway id, the owner key, the public certificate and that
certificate's key. Devices that joined by signing in pinned that key and reach
the gateway at home under its public name, so the listener keeps answering for
that name with that certificate, across restarts and after the certificate
expires; nothing renews it while the gateway is not connected. Devices already
paired therefore stay paired and keep working on the home network. Connecting
again, to the same account or another, registers the same id and key, so the
gateway gets its address back and those devices work through the relay again
without pairing anew.

The local disconnect never waits for the relay. The gateway records the request
in `<config>/cloud-relay/release.json`, keeps its session to prove itself once
more, and asks the relay to drop it: at once, then every fifteen minutes and at
each start, until the relay has (or answers that it no longer knows the gateway),
and for at most thirty days. Until then the account page may still list the
gateway, which routes nowhere, and the gateway cannot be turned on again: it
must be out of its old account before it registers under the same id.

On the relay a hosted name whose registration was removed stops routing and
stays held for the gateway it was granted to, by a digest of that gateway's id
in place of the id. The label is forty bits of a hash and can be ground, and
that gateway's devices still know the address, so no other gateway is given it;
the same gateway, presenting the same id, gets it back.

### Deleting an account

A person deletes their account on the relay's account page (`/_relay/account`,
"Delete account" in its "more options" menu). The page says what will happen and asks for the
same fresh sign-in that removing a sign-in method needs, so a session cookie
alone deletes nothing; the confirmation itself deletes nothing either, and the
deletion is a last, separate press. `POST /_relay/account/api/delete` names the
account the page showed and is refused for any other.

One transaction removes the account, its sign-in methods, sessions, consent and
gateway links, and for every gateway connected to it what a disconnect removes.
The live tunnels of those gateways are closed and their DNS challenge leases
ended. Nothing remembers that the account existed, so the same person creates a
new one only as anyone would: from a gateway, if the relay's signup policy still
admits them.

A gateway learns it from the relay's answer to its own proven keys. Its session
is refused with 401, so it registers again; the relay finds no registration for
its id and no invitation and answers `410` to `/_relay/v2/key/complete`. A
gateway that was registered before (`GatewayUnregistered`) then does locally
what a disconnect does, with nothing left to ask the relay, and its status
carries `notice: "account-deleted"` until it connects again or restarts. A
gateway that was offline gets the same answer at its next start or hourly
registration. Only that answer does this: an unreachable relay, a timeout, a
5xx, or any other refusal leaves the link and the registration in place and is
retried, and the answer arrives over the relay's TLS, so nobody between the
gateway and the relay can forge it. It is the relay making a gateway stricter,
which the first rule allows.

A relay run with a recovery policy (`OMNESIS_CLOUD_RELAY_RECOVERY_*`) admits a
new gateway only with an operator-signed receipt, which this flow cannot obtain,
so every signup ends in `enrollment-refused`. Run a self-serve relay without
one. The relay logs the reason for each refused registration.

## Limits of automatic mode

Automatic is the default: a gateway linked to an account joins trusted sign-ins
without asking until its owner switches to `ask`. A device that joins this way has the
same access as one paired by hand, from the first moment: there is no waiting
period. Whoever takes over a trusted sign-in can therefore join and act as the
owner until removed; the join notification sent to the owner's other devices is
what brings it to their attention.

A sign-in on a page the relay hosts is only as trustworthy as the relay. That
covers portal enrollment, desktop sign-in, the owner link, signup and the account
page. The page's script computes the WebAuthn challenge and the Google nonce, so
a compromised relay can serve a page that binds the owner's sign-in to a device
key of its choosing; that request then joins automatically wherever the sign-in
is trusted. At link and signup time it can also hand the gateway a proof for its
own Google account or passkey, which the gateway pins as the one trust-on-first-use
window, and keep that pin alive by listing it at
`GET /_relay/v3/account-browser/credentials`. The confirmation that vouches for an
added passkey is made on the account page too, so a compromised relay can bind it to
a passkey of its own; it cannot produce one without the owner confirming. The `source` of each pin shows which
pins came from such a page.

A sign-in in the iOS or Android app is not exposed to this: the app computes the
nonce itself from its own device key, so the relay can't redirect that proof to
another key.

A compromised relay can also show one brand-new device a fake gateway. That fake
cannot reach the real gateway; first contact requires a publicly trusted, logged
certificate, which the gateway's certificate monitor reports; and `ask` mode
blocks it.

Operators who do not trust the relay with joining devices switch to `ask`, in
the Omnesis account settings of the portal or the iOS and Android apps, or with
`omnesis cloud policy ask` (or `omnesis cloud connect --ask-first`). Until
they do, the limits above apply from the moment the gateway is linked.
