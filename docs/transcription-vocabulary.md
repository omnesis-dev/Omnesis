# Contextual transcription vocabulary

Vocabulary is opt-in through `inference.transcriptionVocabulary.enabled`; its
default is off. Selection runs in bounded background work. Transcription reads
indexed summaries and never searches source documents or invokes another model
to build a hint list.

## Evidence and context

The context distinguishes the transcription purpose, speaker, participants,
conversation and recording time. Global evidence provides a fallback; person and
conversation profiles supply narrower context. Identity names come from the
people registry as a separate trusted prior, rather than fabricated document
occurrences.

Providers can supply bounded `selfAuthoredText` segments with original dates.
Native sender ownership establishes authorship for message sources. Sent-mail
evidence additionally requires sender/account agreement and excludes quoted
history. Notes distinguish operator entries from agent captures and retained page
content. A document's participant list never establishes ownership of all its
words. Missing ownership evidence remains unknown.

Self evidence must also identify its origin as `written`. Marked transcription
output and legacy segments with unknown origin receive no authored bonus. This
prevents a recognizer's earlier mistakes from becoming independent written
corroboration. Rendered transcript spans and transcribed attachment documents
are excluded from ordinary vocabulary evidence too. Mixed notes supply a
source-owned `vocabularyText` projection of their written entries, without
changing the displayed document. A manual edit after transcription can supply
written evidence; an untouched transcript cannot. Unmarked legacy rendered
prose remains ordinary evidence when its medium cannot be established.

Recent authored support is a sum of independently dated document contributions,
with a 90-day half-life. Each document contributes at most once to each term; a
later occurrence in that document replaces its earlier contribution. One new use
therefore does not rejuvenate all historical occurrences. A fixed-epoch logarithm
indexes this decayed support without periodically rewriting every term. The
`authoredWeight` setting controls the additional relevance weight, defaulting to
4; zero disables the bonus.

## Reliable terms and spellings

Free-text terms require two distinct supporting documents. Repetition inside one
document can choose its spelling but cannot corroborate it. High-frequency words
are filtered using the bundled multilingual frequency lists; membership is not a
prediction of recognizer accuracy. Accents remain significant.

Standard weekday and month names and abbreviations are common lexical forms,
derived from the runtime's Gregorian calendar data for the supported languages.
Frequent hyphenated compounds require frequent components in one supported
language. Structural laughter, stretched common words and word-shaped chat
emoticons are omitted. Uncommon short nicknames and grounded names retain
protection. A bounded, lazily built deletion index supplies a soft confidence
penalty for ASCII words one edit away from frequent words, rather than correcting
them or assuming that every unfamiliar word is a typo. Names grounded in the
document's people, deliberate mixed-case terms and acronyms bypass this penalty.
The index runs during background extraction; persisted benefits already include
confidence, so dictionary lookup does not build or query it. Short and non-ASCII
spellings are outside this conservative typo heuristic.

Dictionary reads apply the same high-frequency filter to retained terms, even
when evidence refresh no longer extracts those terms. This avoids preserving
obsolete lexical artifacts without clearing learned evidence. Filtering stays
within the bounded admitted candidates; it does not refill through an unbounded
scan. Frequent excluded terms can therefore leave a shorter dictionary.

Exact spellings also retain distinct-document support. An isolated mixed-case
variant cannot permanently replace a corroborated spelling. Corroborated
context-specific spelling can override the global spelling when its context
contributes more relevance. Identity priors retain their trusted spelling.
Term keys canonicalize equivalent apostrophe and hyphen glyphs while preserving
the observed output spelling. Accents are not folded and similar-sounding names
are not merged.

Source-declared `bulkMail` and `automatedSender` evidence receives a smaller
weight until ordinary evidence independently corroborates it. Unmarked evidence
does not assert human authorship. Verified authored segments retain their own
weight. `machineEvidenceWeight` defaults to 0.15 and accepts zero to exclude
uncorroborated machine evidence. Legacy terms remain usable while their provenance is
refreshed.

## Context concentration

Context relevance compares a term's document frequency within a profile against
its background frequency. Both rates use the same refreshed cohort. Separate
cohort counts prevent dividing complete legacy frequencies by partially rebuilt
denominators. Common-only prose counts as an opportunity; empty or identifier-only
content does not. Retaining both term and opportunity ledgers keeps replay
idempotent and their populations consistent.

The contextual rate is smoothed toward the background rate using
`contextPriorDocuments`, default 10. A bounded positive log lift rewards terms
concentrated in the current context without making a tiny profile arbitrarily
confident. Missing or inconsistent cohort evidence uses the fallback ranking.
This is a document-frequency approximation, not a recognizer language-model
probability.

Ordinary global, person and conversation evidence retains full inverse-log rarity
and contextual lift. Its logarithmic frequency support then saturates rather
than allowing broadly repeated corpus terms to crowd out relationship anchors.
Verified self-authored evidence uses a separate blend: `authoredRarityWeight`
defaults to 0.5, blending inverse-log global rarity with a neutral baseline;
`authoredContextLiftWeight` defaults to 0.25, compressing its contextual lift to
1–1.5. These settings apply only to the self-authored profile and accept 0–1:
zero ignores the discriminator and one applies its full strength. Authored
confidence uses decayed independent support and the existing document prior.
It supplies no additive lifetime-score floor, so dormant words continue fading
even when they had substantial historical support.

Candidate admission combines bounded indexed streams for rank, recent usage and
independently corroborated ordinary evidence. Applying a discount only after a
rank limit would let frequent machine templates hide useful terms. The ordinary
stream protects those terms before final scoring. Authored rank uses decayed
support rather than lifetime count for the same reason.

## Budgets, availability and cost

The recognizer adapter packs complete terms and phrases, removes redundant
components, and respects its declared runtime budget. Budget is a ceiling, not a
target that must be filled. The local Whisper binding uses UTF-8 bytes as a
conservative token-count bound because it does not expose its tokenizer. Dictionary
recall and packed-prompt recall are therefore separate measurements.

Writer work commits at most 32 term contributions per transaction and can yield
between transactions. Profile opportunities are bounded by the document's capped
scope list. Background evidence refresh enrolls 128 documents at a time and keeps
existing dictionaries available. Historical WhatsApp normalization uses a
provider-owned durable cursor; it does not clear media outcomes. Enrollment is
complete after its final enabled page is acknowledged. Disabling during an
unfinished enrollment allows ordinary sync to continue; enabling again retries
that unfinished archive without repeating a completed enrollment. Historical
Gmail and iMessage authored replay is not provided by this mechanism.
Existing notes missing their written projection are reconciled when the gateway
starts with vocabulary enabled. Enabling it during a running session repairs
changed days immediately and unchanged historical days at the next restart.
An extraction-version change clears previously learned terms through the
bounded rebuild before serving new hints; ranking changes alone do not require
this reset.

V1 retains learned evidence after source document deletion. This policy also
applies to opportunity counts so numerator and denominator populations remain
consistent. The vocabulary is not a replacement for source deletion semantics.

## Research and evaluation

[Kuhn's recent-word cache](https://aclanthology.org/C88-1071.pdf) motivates a
separate recent-use signal. It does not establish a calendar half-life for personal
communications. The 90-day half-life and relevance weights are initial operating
choices, not published optimal values.

[Michaely et al.'s contextual selection](https://storage.googleapis.com/gweb-research2023-media/pubtools/pdf/45759.pdf)
selects informative n-grams using differences between contextual and general
language-model probabilities. The transferable principle is reliable contextual
concentration with a compact list; hosted transcription APIs generally do not
expose the probabilities needed to implement that objective directly.

[Selective contextual biasing](https://www.isca-archive.org/interspeech_2023/harding23_interspeech.pdf)
demonstrates the risk of harming ordinary speech with excessive bias. Its trained
decoder adapters are outside this vocabulary service's scope. Application-level
evaluation must measure added substitutions and unrelated-word errors as well as
target-word recognition.

Deterministic quality tests use fictional historical corpora and independently
chosen future utterance targets. They measure selection and actual prompt
packing, including crowded machine evidence, language changes, spelling noise,
speaker switches and old versus recent usage. These tests establish selection
behavior; they do not establish recognition accuracy. Audio evaluation uses
paired transcriptions of the same recordings, ordinary-speech controls and
intentionally irrelevant hints. Recordings that informed development are
regression data, not a fresh blind holdout. Performance validation measures
lookup, extraction, writer transactions and background refresh separately.
