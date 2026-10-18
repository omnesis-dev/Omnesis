---
title: "How Omnesis works out who is who across your sources"
description: "From source-declared aliases to the people graph, automatic merge heuristics and an experimental Brain that can investigate whether two identities belong to the same person."
date: "2026-10-18"
author: "Adrien Conrath"
tags: [Engineering, People, Brain]
draft: false
---

![An illustrative Omnesis graph has one central person and four smaller people connected to source documents. One person shares both iMessage and voicemail links. Every edge is labelled with its role: author, sender, recipient, participant, attendee, mentioned, contact or owner. Source icons include Gmail, Google Calendar, Granola, WhatsApp, iMessage, Apple Contacts and Apple Voicemail.](/blog/images/people-merge/cross-source-graph.png)

One of the things I want from Omnesis is to be able to ask a question about someone without remembering which app we used to discuss it. If I ask “what did Maya say about the project?”, I might need an email she sent me, a WhatsApp conversation, and a document she shared. I don't want to have to say “Maya on Gmail” and then ask the same question about “M R on WhatsApp”.

Let's say Maya Reeves appears as `maya@example.com` in email and as “M R” on WhatsApp, attached to the phone number `+44 7700 900123`. Those are useful identifiers within their respective sources, but nothing about the strings alone establishes that they are the same human.

This matters beyond finding one message. An answer might need to reconstruct a conversation that moved from email to chat. It might need to aggregate interactions across sources, or find a file through the person who sent it. If Omnesis treats each of Maya's identities as an unrelated person, the agent can get a convincing but incomplete picture.

So I want to take some time to explain how Omnesis connects these identities. There are three jobs here: turn the identities sources report into people and document links, clean up compatible records that share identifiers, and investigate identities that have no identifier in common. That last job is where names, token frequencies, review and the experimental Brain come in. “Merge” doesn't mean quite the same thing in all of them.

## First, a source has to tell us who is involved

The starting point is the source contract. I want to write a much larger post about that separately, but the people part is fairly small: a source can attach structured **person mentions** to a document.

A mention says which identifiers the person has, optionally gives a display name, and describes the person's **role** in that document. The identifiers are typed: an email address, a phone number and a platform ID are different kinds of alias. A display name is useful too, but isn't a unique identifier.

For example, the Gmail source can extract the sender from the `From` header and recipients from the `To`, `Cc` and `Bcc` headers. It emits `sender` and `recipient` roles. It can also extract identifiers from the body with the weaker `mentioned` role. Being mentioned in an email is different from having written it.

The WhatsApp source has different information. It produces a document for a conversation on a particular day, rather than a separate document for every message, and attaches the people involved with the `participant` role. Depending on what WhatsApp makes available, a participant can carry a display name, a phone number, a WhatsApp platform identifier, or a combination of those.

There is a slightly annoying detail here: WhatsApp can identify someone with an opaque LID. That value is not a phone number, even if it looks numeric. The source needs a real mapping before it can attach a phone alias to it. Guessing that mapping would give us a very efficient way to connect the wrong people.

Other sources can describe an `author`, `owner`, `attendee` or `contact`. A contact card can declare several identifiers together, which is particularly useful for connecting an email identity to a phone identity. Sources declare the roles they support in their descriptors, and emit the corresponding mentions with their documents.

The division of responsibility is intentional. Gmail knows what its headers mean; WhatsApp knows what its participant IDs mean. The shared gateway consumes the same typed mentions from both. It doesn't need a special case saying “if this is a WhatsApp document, interpret this field as a person”.

One qualification is important: a structured alias is not necessarily a verified identity. Email headers are sender-controlled, and Omnesis doesn't verify DKIM or DMARC as part of extracting these people mentions. The structure makes an identifier usable for linking; it doesn't turn it into proof that the real person wrote something.

## Turning those aliases into people and graph edges

When the gateway resolves a document's mentions, it looks for people carrying the identifiers the source supplied. If it finds an existing match, it can reuse that person and add newly observed aliases. If there is no match and the mention is allowed to create a person, it creates a person entity with its own ID.

This means two sources can converge on the same person before there is any fuzzy matching. If an email identity already exists and a contact card supplies that same email together with a previously unseen phone number, the resolver can attach the phone to the existing entity. Later documents carrying that phone can find it too.

There are limits to what ingestion is allowed to conclude. A name-only mention doesn't create a person. Phone numbers extracted from prose are allowed to link an existing identity but not create a new one on their own. Shared automated sender addresses are filtered so that every receipt or notification doesn't become evidence that unrelated people share an identity.

There is also an important conflict case: suppose the email already belongs to one established person and the phone belongs to another. A new mention carrying both does **not** automatically merge them during ingestion. The resolver chooses an existing match for the document and holds conflicting identifiers back rather than silently welding the people together. Reconciling existing identities is a separate job.

Once a mention resolves, Omnesis records a link between the document and that person, including the role and source. Conceptually, that gives us three things:

- A **person entity** with its own ID and a chosen display name.
- **Aliases** describing how sources identify that person.
- **Document links** describing where they appear and in what role.

![A resolved Maya Reeves person connects to a Gmail email as sender, a WhatsApp day document as participant, and an Apple Contacts card as contact. Her email, phone and display-name aliases appear together.](/blog/images/people-merge/people-graph.png)

This is the state we want once the identities have been connected. The diagram isn't suggesting that the name “M R” alone would establish the connection.

These links are part of the Omnesis Graph. They exist without the Brain and don't require a language model to read every document. A source told us that an identifier was a participant, sender or attendee, and the gateway recorded the relationship. The harder question is whether two person entities refer to the same real-world identity.

## This is also what makes people filters useful

There are already people filters in search. For example:

```text
from:"Maya Reeves" project
to:"Maya Reeves" project
with:"Maya Reeves" project
```

`from:` matches documents where Maya is a sender, author or owner; `by:` is an alias for it. `to:` matches recipients and attendees. `with:` matches any role, including being a participant in a conversation or being mentioned in a document.

That difference matters for WhatsApp. A daily conversation document can contain messages from several people. Its participant relationship tells us Maya was involved, not that every word in the document was written by her. `with:` is the appropriate filter for that relationship; a `participant` edge doesn't qualify as a `sender` edge for `from:`.

These filters resolve through the people graph. Once Maya's identities are connected, the search can include documents attached to her email identity and her chat identity while still respecting their different roles. It doesn't have to find the literal text “Maya Reeves” inside each document.

You can use an exact email or phone reference as well as a name. A name isn't necessarily unambiguous: the current resolver can return up to ten matching people, so a broad `with:Maya` can include several Mayas. Merging identities doesn't remove the ordinary problem of two different people sharing a name.

Filters can also be combined with source restrictions when that is what you want. But the useful default is that `with:"Maya Reeves" project` doesn't require a source. If you leave off the free text entirely, `with:"Maya Reeves"` browses matching documents newest first. The [search syntax reference](/docs/search#query-syntax) covers combining these filters with the rest of a query.

## Cleaning up duplicate identities before making guesses

There are some cases where the problem is closer to database deduplication than reasoning about people.

First, identifiers need normalization. Omnesis trims and lowercases email addresses. For Gmail addresses specifically, it also removes dots from the local part and the `+suffix`. That rule is specific to the supported Gmail domains; it isn't a claim that every mail provider treats dots or plus signs the same way.

Normalization can make two representations resolve to the same stored alias. It cannot tell us that an unrelated email address and phone number belong to Maya. That's a different question.

Omnesis also scans for person records sharing an exact email, phone or platform-ID alias. When the safeguards allow it, it **physically merges** the duplicate records: aliases and document links move to the surviving person, duplicate links are handled, and the redundant person row is deleted. The source assertions behind aliases are retained, so deduplication doesn't discard which sources supplied an identifier.

There is a contact-specific name path too. Two contact-curated person records with the same multi-word canonical name, ignoring case, can be consolidated. This isn't a general rule that two arbitrary email display names reading “Maya Reeves” must be one person. The contact path is deliberately scoped to curated contact records.

Even a shared email or phone needs care. A family can share an address, an organization can have a shared mailbox, and a record can already have accumulated identifiers belonging to different people. The physical merge path checks for incompatible names and refuses suspicious shared-identifier clusters. Equality of one alias isn't an unconditional instruction to delete the other person.

There are protections around the user's own identity too. Getting “self” wrong has consequences for every question phrased as “I” or “me”, so this is not an area where I want an automatic guess to be particularly adventurous.

## Other merges are rules that can be undone

Now consider the more interesting case: `maya@example.com` and a phone identity called “M R” have no exact identifier in common. Deciding they belong together requires additional evidence. When Omnesis makes that kind of connection, it uses a **logical merge** backed by a merge rule.

Instead of deleting a person record, it chooses one person ID to represent the group—the **canonical person**—and marks the other identities as resolving to it. The original aliases and document links stay attached to their original entities. Reads can then collect the documents belonging to the whole merged group.

This is why a search for Maya can find a WhatsApp document still attached to her original chat entity. Search resolves Maya to the canonical person and expands the group when collecting eligible documents. It doesn't depend on rewriting every old document link.

![Physical deduplication consolidates two records with the same email alias. Logical merging preserves a Gmail email identity and a WhatsApp phone identity under one canonical person, with a rule that can be undone.](/blog/images/people-merge/two-kinds-of-merge.png)

The rule describes a connection between aliases, rather than just recording a one-off operation on two database row IDs. That lets the system evaluate the connection as identities are resolved. Rules can also connect identities transitively: if A is linked to B and B to C, reads should see the combined identity.

At the database level, the important field is `people.merged_into`. In the simplified example below, `p1` is the canonical person and `p2` resolves to it. Both rows still have a `canonical_name`; that column's name doesn't mean every row is currently a separate canonical person. Here, the `NULL` in `p1.merged_into` marks the root of the group, while `p2.merged_into = p1` connects the other identity to it.

The phone alias in `person_aliases` and the chat's `participant` edge in `document_people` still point to `p2`. A read for the combined person includes those rows by following the merge relationship. The diagram shows selected columns with shortened, invented IDs, rather than the full schema.

![A simplified logical-merge schema: people p2 resolves to p1 through merged_into. The phone alias and participant document edge retain person_id p2, while the email alias and sender edge retain p1.](/blog/images/people-merge/logical-merge-schema.png)

Crucially, a logical rule can be deactivated. The system reevaluates the group and the original source identities can separate again. The merge-rules UI exposes this as Undo.

I want to be precise about that distinction because “you can undo a merge” would otherwise overpromise. The judgment-based merges use reversible rules. The physical deduplication described above actually removes a redundant record; Undo on a merge rule doesn't reverse that operation.

## Finding candidates when the identifiers don't match

After the straightforward identity matches, we still have people with different addresses, different phone identities, abbreviated names, or old accounts. This is where the fuzzy candidate detector comes in.

It looks at the aliases associated with people and tries to find plausible connections from their names and identifying email handles. It splits names and email handles into name-like words, or **tokens**, handles spelling differences, and can match constrained initials and partial forms. If an unsplit email handle occurs on only one identity, it can try splitting it into name tokens already known to the detector.

The detector concentrates on pairs where at least one identity is in the high-interaction group, based on recent interactions. A quieter historical identity can still connect to someone active; the detector simply doesn't investigate every pair in years of imported mail equally. This bounds the work, rather than providing evidence that two identities are the same.

### Matching a contact to an email address

Take an Apple contact with first name “John”, last name “Smith”, phone `+44 7700 900124`, and no email address (`email: null` in the illustration). Separately, Gmail gives us the alias `john.smith@example.com`. The contact's name and the email handle each give us the tokens `john` and `smith`. There is no shared email identifier connecting these records: that is the gap we are trying to bridge. The email's domain is left out of this fuzzy comparison; the full email remains a separate stored alias. Phone numbers and platform IDs produce no name tokens in this path; exact identifier matching is handled separately.

### A rare name carries more information

But matching two words isn't the whole algorithm. The detector counts how many distinct people's token bags contain each word. Ten thousand messages from one person don't make that person's surname ten thousand times more common. Each person contributes at most once to a token's frequency, and identities with no name tokens are left out of this calculation.

The weight is `ln((N + 1) / (frequency + 1))`, where `N` is the number of token-bearing people considered by the detector and `frequency` is how many of those people carry the token. A token found almost everywhere contributes little; a token found on only a few identities contributes much more. This is inverse document frequency, related to the weighting in [full-text search](/blog/bm25-search-speed), with people taking the place of documents.

Now compare that with Maya Reeves: an Apple contact with first name “Maya”, last name “Reeves”, phone `+44 7700 900123`, and again no email address, alongside the separate Gmail alias `maya.reeves@example.com`. In our deliberately invented corpus of 100 token-bearing people, `john` occurs on 50 people and `smith` on 40. Their weights are about **0.68 and 0.90**. In that same corpus, `maya` occurs on only two people and `reeves` on three, giving weights of about **3.52 and 3.23**. Each name agrees with its corresponding email on two tokens, but the rarer Maya Reeves tokens carry much more evidence. These frequencies describe our example corpus, not how common the names are in the wider world.

![Two Apple Contacts cards each show first name, last name, a fictional phone number, and email: null, beside separate Gmail aliases. In one invented 100-person corpus, John Smith versus john.smith@example.com scores 0.65, below the 0.70 candidate threshold; Maya Reeves versus maya.reeves@example.com scores 0.94, above the candidate threshold, with further checks remaining. The contact cards contain no email identifier to match directly.](/blog/images/people-merge/token-frequency.png)

John Smith is not suggested from this comparison; Maya Reeves proceeds to further checks, rather than being merged immediately.

The scores come from Omnesis's actual scoring function with the invented frequencies, not from measuring a real corpus or estimating identity probabilities. For each pair, the name and email token bags match exactly: `john` and `smith` for one, `maya` and `reeves` for the other. The common-token case scores about **0.65**, below the default **0.70** threshold for considering it further. The rarer-token case scores about **0.94**, high enough to proceed. Other checks can still reject it.

### How agreement becomes a score

Why does complete overlap score below one? The scorer considers both the proportion of the bags that matches and the total weight of that match. When one bag is fully contained in the other, it measures overlap against the contained bag; otherwise, a custom weighted-overlap calculation accounts for the unmatched tokens on both sides. It then reduces the score when the matching words carry little information. Each identity also has a representative alias for this comparison. When those representatives are different types, such as the contact's phone alias and Gmail's email alias, the scorer applies a small **0.95** multiplier. So “everything in these two bags matches” can still be weak evidence if those words are common.

Frequency affects discovery too: tokens carried by more than **50** people are omitted from the index used to generate candidate pairs. Other, more distinctive tokens can still bring a pair forward. This prevents an extremely common token from making the detector compare everyone who carries it with everyone else. It is a separate step from lowering a token's weight during scoring.

### Abbreviations need more than a matching initial

Initials have their own constraints. An initial expands only when exactly one token on the other side starts with that letter, and it contributes half its normal weight. Initials alone don't suffice: the scorer requires a matched token at least three characters long. After scoring, the detector also requires at least two distinct shared name concepts, collapsing redundant forms so that a name and a fragment of that same name don't manufacture two independent clues. A phone identity with only “M R” therefore gives us much less to work with than a full name, even though both have two pieces.

The opposite examples are useful too. “Maya Reeves” and `maya.lopez@example.org` share a first name but not a surname. “Maya Reeves” and `jamie.reeves@example.org` share a surname but not a given name. The selected aliases in each case give us only one shared name concept. Generic mailbox words such as `info` are removed from email tokens entirely, so two unrelated `info@…` addresses don't gain a personal-name match just by sharing that handle.

These examples show selected aliases. The detector considers all the aliases on each record, using the dominant display name for name matching. Other aliases can support a connection that isn't apparent here; later, a person or the Brain can also investigate the attached documents.

### A promising overlap can still be wrong

There are quite a few checks to keep plausible-looking nonsense out. Generic role addresses such as `support@example.org` aren't distinctive personal handles. Conflicting given names or surnames can argue against a match. An organization name overlapping with an employee's address isn't automatically a person match. A record already carrying incompatible people's names shouldn't become a bridge that joins several unrelated groups.

A compound given name is a good illustration of why those checks matter. In a separate example, an Apple contact has first name “Maya-Rose”, last name “Reeves”, a phone number, and no email. A Gmail alias is `maya.rose.bennett@example.org`. The first comparison works on bags of name-like words. It finds two matching parts, `maya` and `rose`. Because those parts are rare in this example, the overlap looks promising enough to investigate. But matching two words is not the same as matching a first name and a surname: both words came from the contact's compound first name. A later check looks for name structure in the names and email handles and catches the remaining disagreement, `reeves` versus `bennett`.

![Two stages compare an Apple contact for Maya-Rose Reeves, with email: null, against Gmail alias maya.rose.bennett@example.org. First, the rare matching words maya and rose make the pair worth checking. Then a whole-name check sees that both matches belong to the contact's first name while the surnames Reeves and Bennett differ, so Omnesis does not suggest a merge.](/blog/images/people-merge/surname-conflict.png)

In this separate 100-person example, each shared token appears on two identities and each surname on one. That is enough for the pair to pass the initial comparison, but the surname check rejects it. This remains a heuristic safeguard, not proof that different surnames always mean different people. The guard considers the aliases on both records; additional compatible aliases can change what it concludes. The point is that a strong overlap score doesn't erase contradictory evidence.

The bridge failure mode is particularly unpleasant. One bad connection can make a large record look as though it knows everyone's email addresses, and then provide apparent evidence for even more bad connections. So the code explicitly checks for internally conflicting name collections before allowing automatic merges to expand them.

A surviving candidate is still only a proposed connection. Its score describes how strongly the aliases agree under these rules; it is not a measured probability, and it has not yet changed who Omnesis treats as the same person.

## Automatically accepting the stronger candidates

I don't want the answer to all of this to be “here are hundreds of suggestions, please review them”. There is a deterministic auto-approval pass for candidates with stronger structural evidence. Its accepted merges become reversible system rules.

One path looks for the same distinctive email handle on different domains. For an invented example, `maya.reeves@example.com` and `mayareeves@example.org` share a handle after removing separators. That's a useful clue for a work address and personal address belonging to the same person. A generic handle like `info` doesn't qualify through this path.

Another recognizes the same structured full name under different spellings: accents, capitalization, name order, or an attached provenance label. “Reeves, Maya” and “Maya Reeves” can therefore be treated as a stronger match than two unrelated records that happen to share a first name.

There is a slightly subtle choice here: a byte-identical full name doesn't qualify through that spelling-variant shortcut alone. People can have exactly the same common name. It can still qualify through other sufficiently distinctive evidence, but “these strings are identical” isn't the whole argument.

A further path uses a high matching score together with a distinctive full-name match. It asks for person-like evidence and checks for organization/domain confusions. These checks apply to candidates that survived discovery; they aren't a separate instruction to merge any two addresses that look vaguely similar.

The auto-approval pass also keeps self-related candidates out and refuses identities with internally conflicting names. The intention is to settle the cases where structured evidence is strong, leaving the cases that need context or a human decision.

![Names and email handles feed candidate detection. High-confidence candidates can create reversible rules; unresolved candidates remain pending for user review or an experimental Brain investigation. Self and conflicting identities stay out of automatic accepts.](/blog/images/people-merge/candidate-decisions.png)

This diagram starts with fuzzy matching, after the exact-identifier cases discussed earlier. The Brain branch is optional and only considers eligible non-self candidates when it is enabled; reviewing a candidate yourself doesn't require the Brain.

## Reviewing what remains

The portal and mobile apps have a merge-candidate review UI. In the portal, candidates are presented as groups, with the identities and their aliases available to inspect. You can uncheck an identity that doesn't belong, merge the selected identities, or dismiss the proposed grouping.

Dismissal is meaningful: denied candidate pairs are retained as vetoes so the detector doesn't keep proposing the same connection. Accepted user merges create rules, and the merge-rules view lets you inspect and undo logical merges. Where the Brain has investigated a candidate, its verdict and reason are shown too.

The distinction between review and rule history is useful. A candidate says “these might be the same person”. An active rule says “we are treating these identities as the same person”. A rejected candidate says “don't keep asking me about this pairing”. Those are different states, and they should have different consequences.

I would still prefer the review queue to be small. It's a necessary escape hatch, but making the user do all the identity resolution would miss much of the point of building a context layer.

## Letting the Brain investigate the ambiguous cases

The experimental part is to give the remaining candidates to an LLM with tools to investigate them. This is already implemented as a dedicated **merge adjudication** run in the Brain.

It [requires `OMNESIS_EXPERIMENTAL=1` and an assigned `background-agent` model](/docs/experimental#brain-turning-on). Merge adjudication is enabled by default within that Brain configuration, and can be disabled with `brain.mergeAdjudication.enabled`. The source linking, people graph, deterministic detection and review UI described above don't require the Brain.

Each run is scoped to one pending candidate. It starts with a bounded evidence pack: the aliases on each side, matching tokens and scores, recent document titles and sources, and people who commonly appear alongside each identity. It also gets information about documents where both identities occur.

That last signal needs interpretation. A contact card listing an email and a phone is evidence that they identify the same person. Two identities appearing as separate participants in an email or chat can instead be evidence that they are different people. Simply counting “shared documents” would lose that distinction.

![An experimental Brain investigation receives a candidate and evidence, can search and read documents, and returns one of three alternatives: merge with a reversible rule, deny the proposal, or leave it for user review.](/blog/images/people-merge/brain-investigation.png)

The initial pack contains document titles, not the full contents of every linked document. When it isn't enough, the model can use the normal read tools to search, fetch documents, look up people and query the data.

For an invented example, an initialled chat identity might be too weak to connect by name, but a conversation could explicitly mention the email address used by the other identity. An email signature could provide a fuller name. Conversely, a thread addressed to two different members of a family could explain why they share a surname and correspondents while still being two people.

Those are examples of evidence a model can look for, not claims that the current system will discover every such connection. The adjudicator starts from candidates the detector found. It isn't an exhaustive search over every possible pair of people in the corpus, so it can miss identities that never become candidates in the first place.

## The model has three possible answers

Once it has weighed the evidence, the adjudicator records one of three verdicts:

- **Merge:** create a reversible system rule, carrying the model's reason so the user can inspect it.
- **Distinct:** deny the proposal permanently. The prompt reserves this for cases where the model is confident they are different identities.
- **Unsure:** leave the candidate for manual review and attach an explanation of what couldn't be settled.

“Unsure” is useful. Thin evidence, family members with similar names, or an already confused identity record shouldn't force the model to choose between merging and permanently rejecting a potentially good connection.

The reason is stored with the decision so that the judgement can be audited.

## What I want to improve

I've spent a lot of time iterating on the heuristics and techniques above. So far, though, they've mostly been tuned against my own corpus, which mainly includes French, American and British people. A useful next step would be to build evaluations with a broader, more representative range of names and aliases, so I can improve the algorithm without overfitting to my own data.
