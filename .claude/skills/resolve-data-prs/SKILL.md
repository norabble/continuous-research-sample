---
name: resolve-data-prs
description: Clear a backlog of open data-PRs in this instance by accepting or declining each one, producing a real evolution narrative. Use when data-PRs have accumulated unreviewed (e.g. "clean up the open data-PRs", "resolve the edition backlog", "triage the data-PRs").
---

# Resolve outstanding data-PRs

This is a **demonstration instance**. Editions are BTC-USD daily closes from a
public API; no decision here is load-bearing. The point of clearing a backlog
is to produce a realistic evolution narrative — accepted editions accumulating
citations, declined ones settling as decline records — not to reach the
"right" verdict on each edition.

Everything below is specific to `continuous-research-sample`.

## Before starting

1. **Count the work.** `gh pr list --limit 50` — data-PRs carry a
   `data:<descriptor>` label; anything else is a normal PR and out of scope.
2. **Confirm the maintainer's repo association is publicly visible** (see
   *Traps*). If it is not, every decline record will read *"Closed without
   merge; no reason provided."* Check it costs one command:
   ```bash
   curl -s "https://api.github.com/repos/norabble/continuous-research-sample/issues/<any-pr>/comments" \
     | grep author_association
   ```
   Anonymous is what the App token sees. It must be `MEMBER`, `OWNER`, or
   `COLLABORATOR` for the maintainer's comment to become the decline reason.
3. **Agree the outcome split with the maintainer** before touching anything.

## Assign outcomes from a seed

Never decide ad hoc — assign from a disclosed seed so the split is
reproducible and auditable afterwards.

```python
import hashlib
SEED = "cr-sample-triage-<YYYY-MM-DD>"
# byte % 3 != 0  -> roughly 2 in 3 accepted; adjust the modulus for other ratios
accept = hashlib.sha256(f"{SEED}|{descriptor}".encode()).digest()[0] % 3 != 0
```

State the seed and rule in the summary. Process **chronologically by
descriptor** so the resulting narrative reads in order.

## Accepting

Every data-PR rewrites the same claim paragraph in `findings.md`, so **after
the first merge they all conflict**. For each accepted PR:

```bash
git fetch origin main && git fetch origin "$BR"
git checkout -B "$BR" "origin/$BR"
git merge --no-edit origin/main || {
  # findings.md is the ONLY expected conflict — anything else, stop and ask.
  git checkout --ours findings.md && git add findings.md && git commit --no-edit
}
git push origin "$BR"
```

`--ours` on the PR branch keeps the PR's claim prose and status — that is the
interpretation being accepted. The provenance stub and data artifact are new
files and never conflict.

Then comment and merge. **Wait for mergeability**: right after a push GitHub
reports `UNKNOWN` and `gh pr merge` fails.

```bash
for i in $(seq 1 12); do
  [ "$(gh pr view "$N" --json mergeable -q .mergeable)" = MERGEABLE ] && break
  sleep 5
done
gh pr merge "$N" --merge --delete-branch
```

## Declining

Declines never touch `findings.md`, so they never conflict. Comment **first** —
the engine takes the latest trusted comment as the decline reason — then close:

```bash
gh pr comment "$N" --body "<reason>"
gh pr close "$N"
```

`decline.yml` fires on close and commits `.research/decisions/<descriptor>.md`
to `main`. Give it ~60s, then `git pull` and confirm the record exists **and
carries the real reason**, not the fallback.

## Reconcile citations once, at the end

Do **not** try to append each descriptor to the annotation's `editions:` list
during conflict resolution. Some merges apply cleanly, no resolution runs, and
those editions are silently never cited.

Instead rebuild the list once from the authoritative source — the provenance
stubs on `main` *are* the accepted record:

```python
stubs = sorted(p.stem for p in pathlib.Path(".research/provenance").glob("*.json"))
# replace the annotation's `| editions: ...` with ', '.join(stubs)
```

Land it as its own PR. Correct by construction rather than by having gotten
every merge right.

## Comment wording

Decline reasons are **published** — they land in `_okf/log.md` and on the
site. Say what actually happened; do not invent per-edition rationale. A
fabricated reason becomes a permanent, plausible-looking review finding that
nobody computed.

> Sample decline on demonstration instance. Outcome assigned arbitrarily to
> exercise both paths of the loop — not a judgment about the data, which looks
> ordinary.
>
> The impact declaration written when this PR opened is preserved in the PR
> history. Declining settles this content-state: it will not be re-proposed.

The acceptance comment mirrors it, noting that the impact declaration and
claim revision are accepted as-is.

## Verify

```bash
gh pr list                                    # expect zero data-PRs left
ls .research/provenance | wc -l               # accepted editions
ls .research/decisions  | wc -l               # decline records
npx --yes github:norabble/continuous-research#<pinned-sha> okf-export
grep -c '  - id:' _okf/findings/<claim>.md    # must equal the stub count
head -30 _okf/log.md                          # accepted + declined, newest first
```

The citation count matching the stub count is the check that actually catches
mistakes.

## Traps

- **Decline reasons silently fall back if the maintainer's repo association
  is not visible.** `author_association` is computed per-viewer. With *private*
  org membership, every viewer except the maintainer — including the App token
  the workflow runs as — sees `CONTRIBUTOR`, which the engine does not trust,
  so the closing comment is ignored and the record reads *"Closed without
  merge; no reason provided."* The run succeeds; nothing warns. Verified
  2026-07-27: adding the maintainer as a **direct repo collaborator** makes the
  App token see `COLLABORATOR` and the reason lands. Repair records already
  written this way by reopening and re-closing the PR — `decline.yml` rewrites
  them in place, confirmed on all 7. Allow ~60s per record and re-`git pull`
  before concluding it failed; the commit lands after the run reports success.
- **A conflicting PR cannot trigger `pull_request` workflows.** GitHub cannot
  compute `refs/pull/N/merge` for a conflicting PR, so `pull_request` runs
  never start. This is why `decline.yml` uses `pull_request_target`. If a
  decline records nothing, check the workflow's trigger before anything else.
- **Declining is final for that content-state.** A declined descriptor can
  never be re-proposed — the dedup classifier treats a closed-unmerged PR as
  settled. Only the identical content is blocked; genuinely new data hashes
  differently and proposes cleanly.
- **Merging fires a Pages deploy per merge.** Fine now that `site.yml` uses
  `cancel-in-progress: false`; queued duplicates drop and in-flight deploys
  finish. If deployments start erroring, check that setting.
- **No agent quota is spent.** Interpretation triggers on `opened`/`reopened`,
  not on merge — so a bulk triage costs nothing in inference. Avoid reopening
  PRs casually, which *does* re-trigger it.
