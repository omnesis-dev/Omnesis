# Decision model agreement set

A reference for judging a candidate decision model against TypeSafe Jev on the
email worth question. The gateway ships the same set as the reference that
calibration fits a decision backend's scores to (`omnesis decision calibrate`),
so re-recording it changes what later calibrations are fitted against; existing
calibrations keep the reference they name.

- `scripts/lib/invented-worth-mail.mts` generates 312 invented emails from 26 templates covering the
  worth rubric's categories, from promotions and verification codes to
  appointments, money owed and work decisions. Everything in them is fictional.
- `packages/gateway/decision-reference/jev-worth.jsonl` is a decision cassette of `jev-1.13.0`'s answers to them,
  recorded by `scripts/record-jev-worth-cassette.mts`. The generator repeats a few emails, so a
  replay asks 302 distinct questions. Jev passes 69% of them at the worth
  gate's threshold of 1.08: the set leans towards mail worth recording, so pass
  rates run higher than on a real inbox.

Compare a candidate:

```sh
npx tsx scripts/eval-decision-cassette.mts --cassette packages/gateway/decision-reference/jev-worth.jsonl \
  --local path/to/model.gguf
npx tsx scripts/eval-decision-cassette.mts --cassette packages/gateway/decision-reference/jev-worth.jsonl \
  --http http://127.0.0.1:11434 --model <model>
```

The eval reports rounded agreement, pass/skip agreement at the threshold,
recall on what Jev passed, and the candidate threshold that would keep 95% of
it. Measured on CPU:

| Candidate                            | Pass/skip agreement | Recall at 1.08 | Threshold for 95% recall | Passes there (Jev 69%) |
| ------------------------------------ | ------------------- | -------------- | ------------------------ | ---------------------- |
| Qwen3-4B-Instruct-2507 Q4_K_M, local | 67.1%               | 68.8%          | 0.87                     | 80.1%                  |
| qwen3.5:4b, Ollama                   | 70.9%               | 85.1%          | 0.99                     | 87.1%                  |

Re-record the cassette after changing the worth rubric or the generator:
`TYPESAFE_API_KEY=… npx tsx scripts/record-jev-worth-cassette.mts`.
