# Codex review rubric alignment - 2026-10-08

This note records the review-path change for agents actively working in this repository. Policy authority remains AGENTS.md and docs/DECISIONS.md; this note is the working summary.

## What changed

- Commit `4e59d2f1b` vendors the authentic upstream Codex review rubric (`openai/codex` tag `rust-v0.162.0`, `codex-rs/prompts/templates/review/rubric.md`, SHA-256 `ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`) into `src/github/codex-review-rubric.ts` and composes it as the structured reviewer's base instructions in `src/github/codex-reviewer.ts`, followed by Sentinel's existing read-only boundary and an explicit statement that the harness output schema overrides the rubric's own output-format section.
- The review input prompt (`src/github/review-snapshot.ts`), the strict output schema (`REVIEW_RESULT_OUTPUT_SCHEMA`), journal/receipt parsing, the merge gate and all budget semantics are unchanged.
- `AGENTS.md`, `docs/DECISIONS.md` and `MASTER-PLAN.md` retire external `@codex review` requests: never post `@codex review` or otherwise invoke the hosted Codex GitHub app for any PR; the internal reviewer is the runtime review path for runtime target PRs.

## Why

The internal reviewer was written before the Codex client was reverse-engineered, so its instructions omitted the authentic review rubric that drives the hosted reviewer's finding quality and severity conventions. Requesting the external GitHub app review on top of the internal one duplicated review work and burned hosted review quota.

## Where to read the rubric

- Vendored copy used by the reviewer: `src/github/codex-review-rubric.ts`.
- Pristine upstream text: <https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/prompts/templates/review/rubric.md>.

## How to verify on a post-`4e59d2f1b` candidate

- `deno fmt --check src/github/codex-review-rubric.ts src/github/codex-reviewer.ts tests/github/codex-reviewer_test.ts`
- `deno lint src/github/codex-review-rubric.ts src/github/codex-reviewer.ts`
- `deno check src/github/codex-reviewer.ts src/github/codex-review-rubric.ts`
- `deno test --allow-read=.,/usr,/bin,$(deno eval 'console.log(Deno.execPath())') --allow-run --allow-write --allow-env=PATH,NODE_V8_COVERAGE tests/github/codex-reviewer_test.ts`
- Byte equality of the vendored constant against the upstream file was verified during delivery (`CODEX_REVIEW_RUBRIC === upstream text`, SHA-256 `ec60e7f36a1d1c2679ce095c0205ecc56f7dd8fb57707a13ef362072390f219f`); the committed test pins distinctive rubric phrases plus both schema-override sentences.

## Working with it

- Do not edit `src/github/codex-review-rubric.ts`; it is a verbatim vendor. An upstream re-sync is a new decision recording the new tag and SHA-256.
- Do not re-add `@codex review` comments, workflow steps, or hosted app invocations for Sentinel PRs.
- If your branch or worktree predates `4e59d2f1b`, rebase onto or merge `development` before touching review code; the reviewer tests pin the new instruction surface and older expectations fail deliberately.
- The reviewer's runtime effect is source-only until a revision carrying this commit is installed; installation and hosted dispatch remain owner-gated.
