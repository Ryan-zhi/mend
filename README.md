# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ryan-zhi/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ryan-zhi/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` (in the kit) is the whole specification.

## The formats

- **Unified diffs** — often with wrong line numbers; hunks are matched at the nearest occurrence to the header's line, with `\ No newline at end of file` honoured.
- **SEARCH/REPLACE blocks** — the path is the nearest non-blank, non-fence line above the block; a block whose old lines occur more than once fails `ambiguous`.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, with Add / Delete / Update / Move sections, anchored chunks and a cursor.
- **JSON edits** — one JSON array or JSON Lines of `create` / `str_replace` / `insert` tool calls.

Matching is at the first of three tiers that finds the old lines: exact, trailing whitespace ignored, leading and trailing whitespace ignored (with re-indentation at tier 2). Every file is changed or nothing is: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `LICENSE`: MIT.

## Practice

The kit's practice set (100 checks) passes 100/100 on this entry:

    node check.ts ../program/generator/practice.json

<sub>Entered on make.fun?ref=66c1mp03 — https://make.fun/bounty/hidden-spec-cli-01-run-20261122</sub>
