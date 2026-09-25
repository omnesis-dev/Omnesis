<!-- Thanks for contributing to Omnesis! -->

## What & why

<!-- What does this change, and why? Link the issue it addresses, e.g. "Closes #123". -->

## Checklist

<!-- CI runs on `main`, not on pull requests — these local runs are the only
     check this change gets before it lands. -->

- [ ] Tests added or updated
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm test` passes
- [ ] Docs updated for any user-visible change (pages under `website/docs/`)
- [ ] If touching `ios/`, ran `xcodegen generate` after editing `project.yml` or adding a `*.swift` file
- [ ] If adding or changing a data source, ran `/source-review` (`.claude/commands/source-review.md`) and completed its manual validation list
- [ ] No real personal data or secrets in the diff, tests, fixtures, or screenshots (see CONTRIBUTING → _Fixture privacy_)

<!--
First-time contributor? A Contributor License Agreement (CLA) check runs on your
first PR — see CLA.md. It is a copyright assignment + relicensing grant; sign it
by commenting when the bot prompts you.
-->
