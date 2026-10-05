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

Dictionary reads apply the same high-frequency filter to retained terms, even
when evidence refresh no longer extracts those terms. This avoids preserving
obsolete lexical artifacts without clearing learned evidence. Filtering stays
within the bounded admitted candidates; it does not refill through an unbounded
scan. Frequent excluded terms can therefore leave a shorter dictionary.

Exact spellings also retain distinct-document support. An isolated mixed-case
variant cannot permanently replace a corroborated spelling. Corroborated
context-specific spelling can override the global spelling when its context
contributes more relevance. Identity priors retain their trusted spelling.

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
