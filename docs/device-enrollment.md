# Sign-in device enrollment

A new device joins a gateway when its owner signs in. The gateway verifies the
sign-in itself; the relay only carries bytes. `packages/cloud-relay/src/device-enrollment.ts`
is the wire contract and its test file holds the cross-platform vectors.

Rules that must survive every change:

- A compromised relay must not be able to connect a device of its own. Nothing the
  relay serves, lists, signs or relays can make a sign-in trusted, change the
  enrollment policy or approve a device. The relay can make a gateway stricter,
  never looser.
- Only a sign-in the owner **confirmed on this gateway** (`confirmedSignIns`) joins
  without a person, and only when it was made where no relay page could have made
  it: a `gateway-passkey` assertion on the gateway's own origin, a passkey assertion
  from the official Android app (its compiled `android:apk-key-hash:` origin), or a
  Google token an official app client presented (`azp`). A confirmation comes only
  from such a ceremony: confirming a passkey on the gateway's page, or a person
  approving a held request made that way.
- Every sign-in made on a page the relay serves (the account page, the desktop and
  CLI sign-in, the portal handoff, linking and signup), and every Google token a web
  client requested, is held for a person with a comparison code, whoever's sign-in
  it is and whatever pins the gateway holds. Approving it confirms nothing.
- What the relay's evidence pins (`trustedSignIns`: the link page's sign-in,
  endorsed and countersigned sign-ins) is only a suggestion the owner sees; it never
  makes a sign-in trusted.
- A linked gateway joins confirmed sign-ins automatically unless its owner switched
  to `ask`. Only a local owner action writes that choice.
- Anything unverifiable falls back to a held request with a comparison code. It
  never dead-ends.
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

- `proof` verifies: Google signature, issuer, audience from the gateway's own registry (the official relay's public Google client IDs, compiled into the gateway, never taken from the relay or the environment), expiry and nonce; or the passkey signature against the pinned public key with this `nonce`-bound challenge, the relay's RP ID and a trusted origin.
- The proof is at most 10 minutes old.
- The sign-in is confirmed on this gateway and was made where no relay page could
  make it (see the rules above): a confirmed passkey's `gateway-passkey` assertion or
  Android-app assertion, or an official app's Google token for a confirmed Google
  account.
- Policy is `automatic` (the default once linked) and `requireApproval` is not set.

If not, a valid attestation holds the request for approval. Approving a held
request can also confirm its sign-in (`canTrustSignIn`), but only one made where no
relay page could have made it (a passkey on the gateway's page or in the Android
app, or an official app's Google token), and only when the relay's credential
list for the linked account names it: that Google account, or that credential id
with that public key. If the list can't be read, nothing is offered.

### Each sign-in is for one purpose

A sign-in on the relay's page is made for one thing, and the gateway accepts it
only for that thing (`SignInPurpose` in `device-enrollment.ts`):

- **Joining a device** commits to the enrollment nonce as it is, the value the
  device computed from its own key. `/devices/account/request` checks only this.
- **Linking a gateway**, by connecting a new one (`/_relay/v3/signup/start`) or
  from its account page (the account browser's `owner-link`), commits to
  `signInProofNonce("gateway-link", nonce)`: the gateway's nonce hashed under
  its own label. The link callback and the signup's completion check only this.

Whoever starts a link chooses its nonce, and anyone with an owner key can start a
signup, so without the label a sign-in made to link a gateway could be accepted
as a device's enrollment sign-in. With it, a link sign-in commits to a hash no
enrollment nonce can equal, and an enrollment sign-in never pins a link. Endorsements and countersignatures commit to their own labelled
nonces (`passkeyEndorsementNonce`, `passkeyCountersignatureNonce`) and are
verified only as such. The native apps sign enrollment nonces only, so they are
unaffected.

### Passkeys on the gateway's own page

A sign-in made on a relay page is only as trustworthy as the page: script the
relay serves chooses the WebAuthn challenge (and the iOS app presents the same
`https://relay…` origin). A `gateway-passkey` assertion is made on the gateway's
own page instead, which the relay can't serve without a certificate for the
gateway's name:

```json
{ "type": "gateway-passkey", "challenge": "…", "credential": { "…": "WebAuthn assertion" } }
```

- `challenge` is a one-use value the gateway issued (`GatewayPasskeyCeremonies`,
  three minutes) and spends on first use. The proof carries no salt and no time.
- The WebAuthn challenge is `gatewayPasskeyChallenge(purpose, origin, challenge,
binding)`. Purposes: `device-enrollment` (the request's `/devices/account/challenge`
  value, bound to its `enrollmentNonce`), `approve-request`
  (`gatewayPasskeyApprovalBinding`), `pin-passkey` (`gatewayPasskeyPinBinding`) and
  `step-up` (`gatewayPasskeyStepUpBinding`). The test file holds the vectors.
- The RP ID is the relay's host, as for every account passkey. The expected
  origin is the gateway's own: `https://` and its hosted name
  (`hostedGatewayHostname(gatewayId, relay host)`), which the gateway derives
  itself. If the public origin the gateway saved is anything else (a custom
  domain, or a name the relay returned), the gateway has no origin to vouch for
  and only the official Android app can make one. The Android app's
  `android:apk-key-hash:` origins are compiled into the gateway
  (`OFFICIAL_ANDROID_PASSKEY_ORIGINS`), like the Google clients.
- A response made in a cross-site frame (`crossOrigin` or `topOrigin` in its
  client data) is refused, for every passkey proof.
- The public key is one the gateway chose: never one that arrives with the proof.
  The signature counter is kept with the key and must move forward when it is
  not zero.

A sign-in the owner confirmed in such a ceremony is a confirmed sign-in
(`confirmedSignIns` in `account-link.json`, `ConfirmedSignIn`), recorded with
how it was confirmed (`via`). The field is top-level so that a gateway version
that predates it drops it on save, which leaves nothing confirmed; an entry the
running version can't read is dropped the same way. A new link starts with none.

The owner confirms a passkey on the account page of the gateway's own origin
(Settings → Omnesis account, where linking returns to). The card appears while
the gateway has an origin of its own and no confirmed passkey:

1. `POST /admin/cloud-relay/passkeys/confirm/options` (admin) issues a
   `pin-passkey` ceremony: `{ purpose, rpId, origin, challenge, binding,
webauthnChallenge, expiresAt }`. The binding is `gatewayPasskeyPinBinding(gatewayId,
accountId)`.
2. The page asks for any of the account's passkeys (discoverable credentials).
3. `POST /admin/cloud-relay/passkeys/confirm` (`{ proof }`) verifies the assertion
   against the public key the relay lists for that credential id on the linked
   account. A wrong key in the listing only makes the check fail: the private key
   never leaves the owner's authenticator. Confirming lifts the owner's own decline
   or a withdrawal of that passkey.

A confirmation goes away when the account stops listing the sign-in, or when the
owner removes it. `GET /admin/cloud-relay/trusted-sign-ins` lists each pin with
its source and whether it is confirmed (and how); the portal's New devices section
and `omnesis cloud trusted-sign-ins` show the same.

A device joins with a passkey on the gateway's own page the same way, without
the relay's account page:

1. `POST /devices/account/passkey/options` (public, rate-limited like
   `/challenge`) takes `{ requestId, kind, name, secret, devicePublicKey }` and
   returns a `device-enrollment` ceremony: a fresh `/devices/account/challenge`
   value and the WebAuthn challenge bound to the request's `enrollmentNonce`.
   `/devices/account/config` advertises `gatewayPasskey: { rpId, origin }` when
   the gateway has an origin of its own.
2. The device signs `enrollmentSignatureTranscript` for that same challenge and
   sends `/devices/account/request` with `proof: { type: "gateway-passkey", … }`.
   The proof's `challenge` must be the one its `deviceKey` answers.
3. The gateway checks the assertion against the key the owner confirmed here,
   else the key pinned here, else the key the account lists. The first two are
   trusted; a listed key only lets the request wait for a person, with no relay
   attestation needed, since the passkey itself signed on the gateway's page. An
   assertion that does not verify is refused outright.

The portal offers this as "Sign in with Passkey" when it is on the gateway's own
origin; "Sign in on the Omnesis account page" keeps the relay's handoff.

A held request can be approved with the owner's passkey on the gateway's page:

- `GET /devices/account/approval/:requestId` (public) returns the request's name,
  kind, comparison code, creation and expiry time, and whether the requesting
  browser's own key is required (`deviceKeyRequired`, for a portal's request).
  The portal renders it at `/portal/approve#<requestId>` with no login.
- `POST /devices/account/approval/options` (`{ requestId }`) issues an
  `approve-request` ceremony bound to `gatewayPasskeyApprovalBinding(requestId,
device key, code)`.
- `POST /devices/account/approval` (`{ requestId, proof, trustSignIn?,
deviceSignature? }`) approves it as a person would. Only a passkey the owner
  confirmed on this gateway counts; a key the relay lists is never enough. A
  portal's request also needs `deviceSignature`, the requesting browser's
  signature over `approvalDeviceTranscript(requestId, challenge)`, so only that
  browser can approve it this way.

These routes share a limit of ten calls a minute per address, and at most eight
requests wait at once. A link to the approval page can be sent by anyone who
holds a request, including a relay: the page shows the code and the time, and
says to approve only a request one made oneself. The portal's held screen offers
"Approve with your passkey" for its own request, and the devices page offers
"Approve with passkey" for an app's request.

The iOS app sends its own held request there. A passkey sign-in in the app
presents the relay's origin, so it is always held. While it waits, the app reads
`gatewayPasskey` from `/devices/account/config` over the connection pinned to
the gateway's key and opens `${origin}/portal/approve#<requestId>` in the system
sign-in browser, next to the comparison code, then polls `/devices/account/poll`
as before. It uses that origin only when it is the pinned gateway's own origin,
under the RP ID host and never that host itself; otherwise, and on a gateway that
names none, the request waits for a trusted device. After a Google sign-in the
app offers the page without opening it, since the account may have no passkey.
The app also refuses relay passkey options whose `issuedAt` is more than 60
seconds from the device's clock.

A Google token counts as made in an official app (`native-google`) only when an
official native client presented it: the Android release or test client as
`azp` of a token for the web client, or the iOS client as both `aud` and `azp`.
A token without `azp`, or from a client of unknown type, never does.

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
key, method (`automatic` or `approved`), sign-in kind, the id of the sign-in it
joined with (`enrollment.signInId`: the id `omnesis cloud trusted-sign-ins` shows,
so a passkey id or a Google account's digest) and join time. The portal shows the
sign-in in the device's details.

### Revocation sticks

Revoking or forgetting a device that joined by signing in records its device key
in `revoked_device_keys`. A request signed by that key never joins automatically,
whatever the sign-in and the policy: it is held with a comparison code and
`revokedDevice: true` in `GET /admin/cloud-pairing/requests`, so whoever holds the
lost device cannot bring it back by signing in again. One approval restores it:
the redemption adopts the revoked row (same id, sources and cursors), clears
`revoked_at` and releases the key. Only an approval does; an automatic redemption
that meets a revoked row or key is refused, so joining automatically never clears
`revoked_at`. Installing the app again makes a new key, and that request is judged
on its sign-in like any other device; removing the sign-in (below) covers that.

`omnesis cloud remove-sign-in <id> --revoke-devices` (the route's
`?revokeDevices=true`) also revokes every paired device that joined with that
sign-in, after the sign-in is removed. Without the flag those devices stay paired.
The portal's revoke dialog for a device that joined by signing in offers to stop
trusting that sign-in as well, unticked by default.

## Trusted sign-ins

`<config>/cloud-relay/account-link.json` holds the link, `enrollmentPolicy`
(`automatic`, `ask`; absent means `automatic`), `confirmedSignIns` (what joins
without a person) and `trustedSignIns` (suggestions, below). Link and signup
flows deliver one proof, verified and pinned locally. Gateways poll
`GET /_relay/v3/account-browser/credentials`, which lists Google subject digests
and passkeys as `{id, publicKey, endorsement?}`; a pin missing from that list, or a
passkey pin whose key differs from the listed one, is dropped.

A link with no stored policy behaves as `automatic`: linking is the owner's
consent, and there is no separate first choice. Only an explicit `ask` holds
every request. Until the owner confirms a sign-in on the gateway, the status says
`confirmationNeeded` and every request is held anyway: linking pins the link page's
sign-in only as a suggestion, and the portal's account page asks the owner to
confirm their passkey on the gateway's own page right after linking. A gateway
upgraded from a version without confirmations starts the same way: its pins become
suggestions, its policy and refusals are kept, and devices that already joined stay
(they are marked "Joined with Omnesis account" in Devices, for review). The file is written only by local owner actions (the Omnesis
account settings in the portal or the iOS and Android apps, `PUT /admin/cloud-relay/enrollment`,
`omnesis cloud connect --ask-first`), so the relay can neither set nor clear the policy. A gateway that
is not linked joins nothing by sign-in, and a linked gateway with no trusted
sign-ins still holds every request for approval.

The policy and the owner's refusals (declined and withdrawn sign-ins) outlast the
link. Linking again keeps the policy, for any account, and keeps the refusals
when it is the same account. Disconnecting the gateway and a deleted account drop
the link and its pins but leave these in the file, marked `dormant`, which reads
as a gateway with no account until the next link. Nothing is kept when there is
nothing to keep: then the file is removed.

### Passkeys added later

A passkey added to an existing account must be usable at once, without an
approval, and without the gateway believing the relay's list. And one account
should behave as one: a gateway linked with the new passkey should trust the
sign-ins the account already had, as a gateway linked with one of those trusts
the new passkey. So the new passkey and a sign-in the account already has each
sign for the other:

1. The account page creates the passkey. The relay verifies it and holds it in
   memory for five minutes; nothing is stored.
2. The person uses the new passkey once ("Use new passkey"). Its assertion
   commits to `passkeyCountersignatureNonce(accountId, signIns)`, where
   `signIns` are the `signInDigest` of each of the account's other sign-ins as
   they stood when the passkey was created: a Google subject digest, or a
   passkey's id with its public key, hashed to a fixed size so the listing
   grows linearly with the account. This is the passkey's countersignature.
   Only that passkey is offered, and the relay checks the signature against the
   key it was just registered with.
3. The person confirms with Google or another of the account's passkeys. That
   sign-in commits to `passkeyEndorsementNonce(credentialId, publicKey)` the way
   an enrollment sign-in commits to its nonce (`googleProofNonce`,
   `passkeyProofChallenge`). This is the endorsement, and also the proof of
   presence, so adding asks for no earlier confirmation.
4. The relay stores the passkey with both and lists them at
   `GET /_relay/v3/account-browser/credentials` (`passkeys[].endorsement`, and
   `passkeys[].countersignature` with its `proof` and `signIns`). The
   countersignature is listed only to a gateway that sends the header
   `omnesis-credential-evidence: countersignature-v2`: a gateway from before it
   parses the listing strictly and would refuse the whole of it. Gateways now
   drop fields they do not know instead, drop an endorsement or countersignature
   they can't read (which only means trusting less), and read up to 256 KiB.
5. A gateway pins, repeating until nothing changes:
   - (`endorsed`) a listed passkey whose endorsement verifies against that id and
     key, when the endorsement's signer is already pinned: a Google subject by
     Google's signature, a passkey against its pinned key. A passkey can't vouch
     for itself.
   - (`countersigned`) every listed sign-in a pinned passkey countersigned, when
     the countersignature verifies against that passkey's pinned key for this
     gateway's own account id.

   Each proof is verified at most once per sync, and only once its claimed
   signer is pinned.

So trust runs both ways. Linked with Google, a gateway learns the passkey from
Google's endorsement; linked with the passkey, it learns Google from the
passkey's countersignature, and from there every passkey Google or that passkey
later vouched for.

An endorsement can't be read backwards. A Google token whose nonce names passkey
P shows only that the holder of that Google account named P, and P's id and key
are listed to every gateway of the account: anyone holding any Google account (or
any passkey) can make such a proof for P through a page that computes that nonce.
A gateway that trusts P must not trust whoever did. Only P's own signature says
that P's holder stands behind another sign-in, which is why step 2 exists.

What a gateway accepts, and why a relay can't use it to add a sign-in:

- The signature is checked against a key the gateway pinned itself, never one
  the relay offers. A list, a key, or a proof by a passkey or Google account the
  gateway does not trust adds nothing.
- The signed list is in the nonce. A relay that adds, drops or swaps a sign-in in
  it, moves the countersignature to another passkey, or replays one from another
  account (the account id is in the nonce) has a signature that no longer
  verifies, and the gateway pins nothing from it.
- It can't stand in for anything else: the nonces of a countersignature, an
  endorsement and an enrollment are hashes under different labels.
- A relay that withholds a countersignature or an endorsement only leaves a
  sign-in held for approval.

Both are checked as of when they were made, not against the 10-minute limit:
each names fixed sign-ins and can do nothing else, and a gateway that was offline,
or linked months later, must still be able to accept them. A passkey's key never
expires and nobody can retire it, so a countersignature verifies for as long as
the gateway pins that passkey. A Google endorsement stops verifying once Google
retires its signing key (its `kid` is no longer published): the gateway can no
longer tell a genuine old token from a forged one, so that passkey falls back to
approval. A future-dated proof never verifies.

Gateways sync hourly, and when a verified sign-in they do not trust arrives,
Google or passkey, so a device that signs in with a sign-in the account confirmed
joins at once. A sign-in starts at most one fetch every two seconds, and callers
share a fetch that is already running.

#### Removal is durable

A sign-in removed from the account must not come back if the relay is compromised
later, so removal is recorded on both sides:

- The relay deletes every countersignature that names a removed Google account or
  passkey, along with the passkey's own. A signature can't be edited, so the
  passkey that made it keeps its other trust but no longer vouches for anyone.
- A gateway withdraws (`withdrawnSignIns`, by `signInDigest`) every sign-in it had
  pinned that the account stops listing, a passkey listed under another key, and
  every sign-in a verified countersignature names that the account no longer
  lists. No endorsement or countersignature pins a withdrawn sign-in again,
  whatever a relay lists later, and neither do they pin one the owner removed on
  the gateway (`declinedPasskeys`, `declinedGoogle`). Only approving a device that
  signed in with it does, which lifts both. Linking the gateway to the same account
  again keeps both lists, except for the sign-in it links with; linking it to
  another account starts without them.
- A countersignature that names a sign-in the account no longer has by the time
  the new passkey is stored (removed while the passkey was being added) is not
  stored; the passkey keeps its endorsement only.

A gateway learns of a removal only from the listing. One that did not sync
between the removal and a later compromise of the relay can't tell a sign-in the
account removed from one it still has, and a compromised relay can list it again
with the evidence it kept. When a sign-in is removed because it may be in the
wrong hands, also remove it on each gateway (`omnesis cloud remove-sign-in <id>`,
with the id `omnesis cloud trusted-sign-ins` shows on a gateway that trusts it,
and `--revoke-devices` to revoke the devices that joined with it) so
that gateway declines it whatever it is told later. A gateway that never trusted
it declines it in advance. The same applies to Google
pins removed on a gateway before `declinedGoogle` existed: that removal was not
recorded, so remove them again.

### When a sign-in still waits for approval

Under `automatic`, a verified sign-in is held for approval with a comparison code
whenever it is not a confirmed sign-in made where no relay page could make it.
Before confirmations existed, the cases below were the only ones held; they still
are, and are now joined by every relay-page sign-in:

1. The gateway's owner chose `ask`, the request set `requireApproval`, or the
   gateway is on a certificate incident hold (below).
2. The sign-in is new to the account, and nothing the gateway trusts vouched for it.
3. The gateway was linked with a passkey that was added before passkeys
   countersigned, or that was the account's first one, and the sign-in is one the
   account had before that passkey: for example the Google account the account
   was created with. The only evidence tying the two is Google's endorsement of
   the passkey, which proves nothing in that direction (above). Approving one such
   device pins the sign-in for good, and a passkey added from now on countersigns
   the account's sign-ins, so a gateway linked with it trusts them at once.
4. A Google account linked to the account later ("Link Google"): nothing signs for
   it in either direction, so each gateway learns it by one approval.
5. A passkey vouched for by Google with a signing key Google has since retired,
   or a sign-in the gateway's owner removed there.
6. The device key belongs to a device the owner revoked or forgot (Revocation
   sticks, above).

Each pin records its `source`: `link-page` (the relay's link or signup page),
`approval` (approving a request signed in on a relay page: desktop or portal),
`endorsed` (a passkey added later that a pinned sign-in vouched for), `countersigned`
(a sign-in the account already had, which a pinned passkey signed for on the account
page) or
`native-app` (approving a request signed in in the iOS or Android app).
`omnesis cloud trusted-sign-ins`, `GET /admin/cloud-relay/trusted-sign-ins` and
the portal's New devices section list each pin with its source and whether it is
confirmed, and `omnesis cloud remove-sign-in <id>` drops and declines one (and its
confirmation), or declines in advance one the gateway does not trust, and with
`--revoke-devices` revokes the devices that joined with it. Since only
confirmations make a sign-in trusted, the sections on pinning (Passkeys added
later, Removal is durable) describe how suggestions are kept, not what joins.

### Certificate incident hold

The gateway's certificate monitor watches Certificate Transparency for
certificates issued for its public name. One whose key is not the key the
gateway serves means someone else may be able to pose as the gateway, so the
gateway goes on an incident hold:

- every new device waits for approval, whatever the owner chose;
- the owner's administrator phones get a generic notification;
- the portal's Omnesis account page and `omnesis cloud status` say so;
- a sign-in made on a page served under the gateway's own name proves nothing
  while it lasts (`gatewayOriginAssertionsRefused`).

The hold is saved with the owner's other local choices before the monitor
records the incident, so it survives restarts, unlinking and linking again, and
the account being deleted. Nothing the relay sends lifts it. The owner lifts it,
after looking into the certificate, with `omnesis cloud incidents ack` on the
gateway host (`omnesis cloud incidents list` shows what is held). The gateway
refuses the acknowledgement when it arrives through its relay, however it is
authenticated. A certificate already acknowledged does not put the hold back;
another one does.

## Relay surfaces

- `POST /_relay/v3/native/start` also returns `salt`; `googleNonce = googleProofNonce(salt, nonce)`.
- `POST /_relay/v3/native/passkeys/options` also returns `salt` and `issuedAt`, with the bound challenge.
- `POST /_relay/v3/native/passkeys/complete` also returns `credentialPublicKey`.
- Browser and desktop operations need a fresh sign-in on that operation, even with a session cookie. Browser redemption returns `signInProof`; desktop redemption only as below.
- `POST /_relay/account/api/passkeys/countersign/options?endorse=<id>` and `…/countersign/complete?endorse=<id>` run the new passkey's countersignature (Passkeys added later, step 2), bound to the browser that created it. They sign nobody in.
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
for approval with a comparison code, as for any unverified sign-in. With one, it
holds the request too: the sign-in was made on a relay page (see the rules at the
top), so the loopback only keeps a phished link from producing a proof at all.

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

From there the gateway decides as for any request. The sign-in was made on the
relay's page, so it is held with a comparison code; on the gateway's own origin
the portal's held screen offers "Approve with your passkey", which approves this
browser's request with a passkey confirmed on the gateway. If any step is
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

On the relay's page, signing in (or creating the account) does not connect the
gateway by itself, for a signup or an owner link alike: the page shows the
gateway's name and code and connects it only when the person presses "Connect
this gateway". Whoever started the request chose that name, so the press is the
person's confirmation that it is theirs. Pairing a browser from a gateway's own
portal still goes on by itself after sign-in.

Under `allowlist`, the relay may also take invitations from a Google Group
(`OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP`, its service account key in
`OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_CREDENTIALS_FILE`, and an optional
`https` link to ask to join in `OMNESIS_CLOUD_RELAY_SIGNUP_GOOGLE_GROUP_JOIN_URL`;
`packages/cloud-relay/README.md` lists the Google-side setup). It applies only
to a Google sign-in that the allowlist does not already admit and that either
would create an account or is for an existing account with no linked gateway.
On such a relay, the sign-in for connecting a gateway also asks Google for the
`email` scope,
and the address Google marked `email_verified` is checked once against the group
through the Cloud Identity Groups API. The address is never stored, logged or
returned, and the account is keyed by Google's subject as always. A member
creates the account or connects the gateway to it; anyone else is refused with "Omnesis accounts are
invite-only for now." and the join link, and the gateway's poll sees the usual
`not-allowed`. If Google cannot answer, the sign-up is refused for now ("We
couldn't check your invitation right now. Try again in a few minutes."),
nothing is recorded, and the person can sign in again on the same request.
An account that already has a linked gateway, or that the allowlist names, is
never checked against the group. A passkey sign-in the allowlist refuses stays
refused, since it carries no email; the page asks the person to start again
from the gateway and sign in with Google.

With a join link configured, the relay also says so before anyone signs in:
`GET /_relay/v3/signup/access` (public, no parameters) answers
`{"signup":{"inviteOnly":true,"requestAccessUrl":"…"}}` under `allowlist`, and
`{}` under any other policy or without a link. It is a separate path because
gateways parse `/_relay/v2/config` strictly. A gateway with
`OMNESIS_CLOUD_RELAY_ENABLED=1` that is not linked to an account reads it when
its owner opens Settings → Omnesis account (or runs `omnesis cloud status` or
`connect`), at most every ten minutes, and keeps it only if the link is an
`https` URL without credentials of at most 2048 characters; unknown fields are
ignored. The management status then carries `signup`, and the portal shows
"Omnesis accounts are invite-only for now." with a Request access link and its
host above the two choices, and again when a sign-in is refused as
`not-allowed`; the CLI prints the link once while waiting.

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

On the gateway, remote access goes off and the account link, trusted sign-ins,
relay session, invitation and recovery receipt are removed (the enrollment policy
and refused sign-ins stay for the next link, see Trusted sign-ins), so
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

Automatic is the default: a gateway linked to an account joins confirmed sign-ins
without asking until its owner switches to `ask`. A device that joins this way has
the same access as one paired by hand, from the first moment: there is no waiting
period. Whoever takes over a confirmed sign-in (the owner's passkey, or the Google
account in an official app) can therefore join and act as the owner until removed;
the join notification sent to the owner's other devices is what brings it to their
attention.

What a compromised relay can no longer do:

- Steer an owner's sign-in on a page it serves (account page, desktop or portal
  handoff, link, signup) to a device key of its choosing and have it join: such a
  sign-in is held, even for a confirmed passkey and under `automatic`.
- Pin its own sign-in at link time, or have a hostile page mint an endorsement or a
  countersignature: those become suggestions, never trusted. Confirming a passkey
  checks the assertion against the key the relay lists, so a substituted key only
  makes confirmation fail.
- Choose the gateway's origin: the gateway derives its hosted name from its id and
  the relay host, and refuses `gateway-passkey` trust when the saved public origin
  is anything else.
- Stockpile assertions: a `gateway-passkey` challenge is one-use, issued by the
  gateway, and lives three minutes; the confirmed passkey's signature counter is
  kept.

What remains:

- The gateway's own page is only as trustworthy as its certificate. While only the
  gateway can obtain a certificate for its hosted name, the relay cannot serve that
  page. Whoever can get one (a party that can write the DNS zone or pass another
  validation method for the name) can impersonate it. When the certificate monitor
  sees such a certificate, the incident hold also refuses every assertion made on
  the gateway's page (no confirmation, join or approval there) until the owner
  acknowledges it; certificate isolation addresses the rest separately.
- Any script running on the gateway's origin (for example a third-party widget
  origin the portal allows) can ask the owner's passkey for an assertion.
- A link to the public approval page can be sent by anyone who holds a request,
  including a relay: it shows the request's code and time and asks the owner to
  approve only what they started. A portal's request also needs that browser's own
  device key, so a link cannot get another browser's request approved there.
- A gateway on a custom domain has no shared passkey origin (the RP ID is the
  relay's host): only Android-app passkeys and an official app's Google sign-ins
  can be confirmed there, by approving a held request.
- An owner with several gateways confirms once on each.
- The relay can deny service, for example by refusing to list a passkey, which
  only makes confirmation or approval fail.

A sign-in in the iOS app presents the relay's own origin, so it is held like a
relay page's until the owner approves it on the gateway's page, which the app
opens for its held request. A compromised relay
can also show one brand-new device a fake gateway. That fake cannot reach the real
gateway; first contact requires a publicly trusted, logged certificate, which the
gateway's certificate monitor reports when it is for the gateway's own name (and
holds new devices, above); and `ask` mode blocks it.

Operators who want a person to approve every device switch to `ask`, in the
Omnesis account settings of the portal or the iOS and Android apps, or with
`omnesis cloud policy ask` (or `omnesis cloud connect --ask-first`).
