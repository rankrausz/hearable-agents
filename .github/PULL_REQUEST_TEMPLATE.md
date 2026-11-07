## What

One or two sentences in domain language. Link the issue.

## Acceptance criteria

For each criterion in the issue: how it is demonstrated (test name, artifact, screenshot, WAV).

- [ ] …

## Docs

- [ ] Updated the affected public docs or described why they still apply

## Checks

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm audio:qa` (if anything audible changed) and PR labelled `needs-ear`
- [ ] No fixtures, snapshots, thresholds or scope changed — or explained below

## Golden snapshot diff (engine changes only)

Per fixture, one line: what moved and whether it's better.

## Verified externally

APIs or behaviours you checked in documentation rather than recalled, with links.

## Open questions / needs a human

Anything you chose that someone should confirm; anything you couldn't judge.
