# Documentation structure for a public, resume-facing windrow

> [!important]
> **Add a dashboard screenshot to the README, and delete one of the two setup documents.** Those
> are the highest-impact changes and neither is a writing exercise. Everything else here is
> refinement.

> [!note]
> This file is a working document. Delete it once the plan is executed — a repo that advertises
> its own reorganisation plan looks mid-refactor, which is the opposite of the goal.

```stats
README: 387 lines
docs/setup.md: 486 lines
docs/design/: 21 files
Design files that fail the git test: 5
```

## What is already good

The README opens correctly. One paragraph states what windrow is, names three concrete questions
it answers — *who is allowed to use the Gmail MCP tools? who used them last week? what was silently
denied?* — and a mermaid flowchart follows immediately. That passes the thirty-second scan test.

A `LICENSE` is present. The design notes are unusually well written; the problem below is where
they sit and which of them are finished, not their quality.

## The structural problem: two setup documents

`README.md` carries `## Setup` plus `Configuration`, `Troubleshooting`, `Running as a Windows
service`, `Restarting without a fleet-wide fault` and `Debugging without enforcement in the way` —
roughly 200 of its 387 lines. `docs/setup.md` is another 486 lines covering the same ground.

Two documents that answer the same question will disagree, and the reader cannot tell which is
current. This session already produced an example: the container cutover changed how central starts,
and there are now two places that would need the edit.

> [!tip]
> The README should link to setup, never contain it. Cut the README to the pitch and keep
> `docs/setup.md` as the single operational source.

## The four kinds, and where windrow's docs belong

[Diátaxis](https://diataxis.fr/) is the standard answer to "how do I split documentation". It sorts
every page by what the reader is doing: learning or working, practical or theoretical.

| Kind | Reader wants | Windrow's | Status |
|---|---|---|---|
| **Tutorial** | "teach me by doing" | — | **missing** |
| **How-to** | "help me accomplish X" | `docs/setup.md`, troubleshooting, service, restart | exists, duplicated in README |
| **Reference** | "tell me the facts" | config table, `api-contract.md` | exists, buried in README |
| **Explanation** | "help me understand why" | most of `docs/design/` | strong |

The README is deliberately **none of these**. It is a landing page whose job is to make a stranger
care in two sentences and then route them to the right kind.

The gap is the tutorial. `docs/setup.md` is a how-to — it assumes you have decided to deploy and
know which topology you want. Nothing yet says *"run these four commands and watch a denial happen."*
For a resume reader, that guided first success is the highest-value page in the repo.

## Proposed tree

```
README.md              pitch, screenshot, quickstart, links out
LICENSE
CONTRIBUTING.md        how to run the tests — short
docs/
  quickstart.md        TUTORIAL: four commands to a working denial
  setup.md             HOW-TO: topologies, config, service, troubleshooting
  reference/
    configuration.md   every env var (moved out of README)
    api.md             from design/api-contract.md
  architecture.md      EXPLANATION: the one essay a reader should start with
  design/              decision records only — see "What belongs in git" below
SECURITY.md            how to report a vulnerability
```

`docs/architecture.md` is the piece that does not exist and should. Twenty-one design notes have no
front door; a single essay explaining the node/central split, the two listeners and the fault ladder
would carry more weight with a technical reader than all twenty-one unindexed files.

## What belongs in git

The instinct to archive working documents *inside* the repo is worth resisting. Archiving is what
you do when you have already decided something belongs in version control; the prior question is
whether it ever did.

Git is good at exactly one thing here: keeping a document **honest against a specific commit**. A
document that must change when the code changes belongs in the tree, because a pull request can
change both together and a reviewer can see that it did. A document with its own lifecycle does not,
because git gives it nothing and takes something away — it becomes stale silently, and it is public
forever.

> [!tip]
> **Two questions settle almost every case.**
> 1. *If I checked out this commit in two years, would this document still be true of it?*
> 2. *Does changing the code require changing this document in the same commit?*
>
> Two yeses: it belongs in the tree. Two noes: it belongs somewhere with its own lifecycle.

### Applying the test

| Document | Still true at that commit? | Co-changes with code? | Home |
|---|---|---|---|
| Architecture decision record | yes — records a decision that *was* made | when superseded | **git** |
| Config / API reference | must be | always | **git** |
| Setup and how-to | for that version | often | **git** |
| `README`, `LICENSE`, `CONTRIBUTING`, `SECURITY` | yes | rarely | **git** |
| TODO / roadmap | no — a claim about the future | no | **issue tracker** |
| Dated review or audit | true on that date only | no | **wiki / internal drive** |
| Migration or rename bookkeeping | no — done is done | no | **delete; git log already has it** |
| Investigation write-up, proposal | only until acted on | no | **issue or wiki** |
| Unfixed security finding | — | no | **private advisory, never the tree** |

The decisive column is the second one. A TODO list has never once needed to change in the same
commit as the code — which is precisely why it drifts, and why trackers exist. Git has no concept
of "closed"; an issue tracker is built around it.

### What this means for windrow's four

| File | Where it should go |
|---|---|
| `integration-todo.md` | issue tracker, one issue per open item; delete the file |
| `governance-review-2026-08-16.md` | wiki — a snapshot of one date, not a description of the code |
| `secrets-audit-2026-08-18.md` | wiki, or private if any finding is open |
| `governance-to-windrow-rename.md` | delete — the rename is in `git log` and the code is renamed |

Nothing is lost by any of these. The rename note is the clearest case: git already records that
migration perfectly, and a second prose account of it can only fall out of step.

The rest of `docs/design/` passes the test comfortably. `per-node-enrollment-credentials.md`,
`upgrade-resilience.md`, `deployment-boundary-decision.md` and `latency-breakdown.md` explain why
the code is shaped as it is, and a reader of any commit needs the reasoning that was valid at that
commit. That is an asset, and it is one of the more impressive things in the repo.

> [!note]
> Superseded decision records are the one case where in-repo archiving is right. An ADR that was
> reversed still explains why the code looked the way it did — keep it, mark it superseded, and
> link to the record that replaced it. `deployment-boundary-decision.md` already does this well.

### Security is its own category

> [!caution]
> `governance-vulnerability-review.md` should not be in a public tree, and retitling it is not
> enough. A vulnerability review read out of context says "this project has vulnerabilities", not
> "these were found and fixed" — and if any finding is still open, publishing it is a disclosure.

GitHub has purpose-built machinery for this, and using it reads as professional rather than
cautious:

- **`SECURITY.md`** — how to report a vulnerability. Belongs in the tree; it is a policy, not a finding.
- **Private vulnerability reporting** — the intake channel, enabled in repository settings.
- **Security advisories (GHSA)** — where a *fixed* finding is published, with the fix linked. This is
  the correct public home for the content of that review, and it is dated, versioned and closable in
  ways a markdown file is not.

The fixes themselves are already in git, which is where they belong. The finding is a record about
the code at a moment, not a description of it.

## The README itself

Cut to roughly 120 lines in this order. The first three items are what a recruiter sees before
scrolling.

1. **Name and one-line tagline**
2. **A dashboard screenshot** — the repo currently shows no evidence the UI exists
3. The existing opening paragraph and mermaid diagram, unchanged
4. **Quickstart** — four commands, linking to `docs/quickstart.md`
5. **Why Windrow** and **Use cases** — trimmed, these are good
6. Tech stack, in one line of prose rather than badges
7. **Links out**: setup · architecture · design notes
8. Status and licence

Everything from `## Setup` to `## Project layout` moves to `docs/`.

> [!tip]
> A screenshot is the single highest-return change in this document. Recruiters read a README as a
> landing page, and a governance dashboard with real grants, principals and usage rows is concrete
> evidence that the thing runs. A mermaid diagram proves you can draw the architecture; a
> screenshot proves you built it.

## Order of work

1. Screenshot into the README — one hour, largest effect
2. Delete the README's setup sections, link to `docs/setup.md` — removes the duplication risk
3. Route the four working documents out of the tree per the table above
4. `SECURITY.md` in, `governance-vulnerability-review.md` out — do this before the repo is public
5. Write `docs/quickstart.md` — the missing tutorial
6. Write `docs/architecture.md` — the missing front door
7. Move the configuration table to `docs/reference/configuration.md`
8. Add a short `CONTRIBUTING.md`

Steps 1–4 are an afternoon and fix what a visitor notices first. Steps 5–8 are the difference
between a good repo and one that reads as a product.

### The same test, applied to this session's documents

Neither of the two documents written this session survives its own rule, and saying so is cheaper
than letting someone else notice.

| File | Verdict |
|---|---|
| `docs/hook-opportunities.md` | A proposal. True only until acted on, never co-changes with code. It is four issues wearing a trench coat — file them and delete it, or keep it only if `SessionEnd` is not going to be built soon. |
| `docs/documentation-plan.md` | This file. A plan for a reorganisation; delete it once executed. |

A repo whose `docs/` is full of plans about the repo is a repo that looks like it is being worked
on rather than one that works.
