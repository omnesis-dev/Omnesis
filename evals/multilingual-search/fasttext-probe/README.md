# Compact language-identification diagnostic

This probe compares `fasttext-pure-rs` 0.1.0 with the Whatlang detections cached
by the multilingual retrieval experiment. Fixture labels are used only for
scoring; they are never sent to either detector. Mixed-language and mixed-script
fixtures have separate summaries because their target query language need not
be the only language in a document. Query detection is diagnostic, not a proposal
to restrict retrieval to one inferred query language.

The inference crate is MIT-licensed. The official `lid.176.ftz` model is separately
licensed under **CC-BY-SA-3.0**. Obtain the model from
<https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz> and keep it
outside Git. The evaluated model has 938,013 bytes and SHA-256
`8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83`.
See <https://fasttext.cc/docs/en/language-identification> for attribution and
license information.

Build the Rust CLI with the checked-in lockfile, directing `CARGO_TARGET_DIR`
outside the checkout. Feed JSON lines containing `{"text":"..."}` to the binary
and supply the model file as its first argument. Each response contains the
highest-scoring detection and three language predictions. No reliability
threshold is invented and scores are not treated as calibrated probabilities.

Run `compare.py --probe BINARY --model MODEL --baseline RESULTS_JSON --output
OUTPUT_JSON`. The baseline must be a `run.py` report for the exact same
`cases.json`; its hash is checked. Reports include per-input predictions, model
hash and size, accuracy counts and timing including process startup/model load.
Keep report files outside Git. Norwegian `no` is accepted as Bokmål `nb`; Mandarin
`cmn` is compared as `zh`.

An optional `--official FASTTEXT_BINARY` compares predictions against the upstream
C++ `fasttext predict-prob` CLI on every unique input. The reference used here is
Facebook fastText v0.9.2, built from the official source archive. On newer C++
compilers that release needs `-include cstdint` in its build flags. The comparison
records top-one disagreements, top-three label-set disagreements, confidence
differences and the full official output. Matching top-one labels does not prove
equivalent lower-ranked predictions or general implementation parity.
