# Code review workflow

Ask an agent working in this repository to **review the current changes**, or name
a commit range or component. It reads `AGENTS.md` and coordinates the roles below
through Orca. This is an on-demand development workflow, separate from the automatic
lint, formatting, type checks, and tests in `npm run build`.

## Scope and ownership

The coordinator records the review scope before launching workers:

- Requested behavior and constraints, including the user's latest corrections.
- Base and head commits when applicable, and whether staged, unstaged, and untracked
  files are included. Default: all current uncommitted changes, including untracked
  source and configuration. With a clean tree and no named range, review the current
  implementation and say so.
- Exact files under review and the relevant supporting files. Do not use just
  `git diff` when moved or new files are still untracked.
- Available checks, known limitations, and any user-authorized implementation owner.

Use `validation/reviews/<run-id>/` for local reports. The directory is gitignored
and excluded from packaging and formatting. Create `scope.md`, then give every
worker its absolute path, the repository path, and its assigned report path.
Reviewers may read supporting code but findings must concern the stated scope.

Do not edit the reviewed files while reviewers or the decider are running. Record
the initial Git state and scoped file contents or hashes, and compare them at the
end. If the user or another process changes the scope, identify the affected results
as stale and re-review those changes before declaring a verdict.

Each reviewer owns only its report file. Source, tests, configuration, and Git state
are read-only. The verification reviewer may run local checks and write ignored
test artifacts. The decider owns only `decision.md`. No worker may commit, publish,
push, install dependencies, spend model-provider tokens, or change personal Pi state.
If a check needs one of those actions, report the limitation to the coordinator.

## Independent reviewers

Launch these three roles in parallel. They receive the same scope and do not read
each other's reports before submitting their own. Use the user's configured agent
and model defaults unless the user specifies otherwise; distinct perspectives do
not require different model providers.

### 1. Correctness and lifecycle

Trace behavior through the changed code and its callers. Look for concrete failures
in asynchronous state, cancellation, session replacement, timer cleanup, character
validation, and persistence. Consider actual input and terminal boundaries, including
untrusted model output. Explain the sequence that produces a failure and its user
impact. Do not invent an adversary model or platform support beyond this package's
documented scope.

Report: `correctness.md`; finding IDs: `C1`, `C2`, and so on.

### 2. Maintainability and readability

Assess whether a maintainer can follow the implementation and safely change it.
Look for confusing control flow, duplicated behavior likely to drift, unnecessary
indirection, misleading names, and abstractions whose cost exceeds their benefit.
Prefer a short local fix over a framework, generic subsystem, or broad rewrite.
Respect established conventions when they work. Do not report formatter choices,
personal style preferences, or imagined future requirements as defects.

Report: `maintainability.md`; finding IDs: `M1`, `M2`, and so on.

### 3. Verification and Pi integration

Check whether tests would detect the specific regressions the change could cause.
Inspect Pi API use, the extension manifest, peer dependencies, package contents,
module-relative asset paths, and documented behavior when relevant to the scope.
For API uncertainty, inspect the installed Pi declarations and examples; consult
official Pi documentation when necessary. Do not copy assumptions from a different
Pi version.

Run `npm run build` once for the review when dependencies are available. Run
`npm run test:smoke` if loading, assets, or terminal behavior changed. For packaging
changes, inspect `npm pack --dry-run` (its prepack hook also runs the build).
Avoid duplicating checks without a reason. Never run paid generation as a routine
review check. State precisely which checks passed, failed, or were not run.

Missing tests are findings only when tied to a credible failure worth preventing.
Do not demand tests for trivial, reversible edits or assertions that mirror the code.

Report: `verification.md`; finding IDs: `V1`, `V2`, and so on.

## Finding standard

Zero findings is a valid result. Report at most three substantive findings per
reviewer, unless more independent issues clearly risk data loss or broken core
behavior. This is a ceiling, not a quota.

Each finding includes:

- ID and severity: **P1** for broken core behavior or meaningful data loss; **P2**
  for a concrete, bounded defect or maintainability problem worth fixing now.
- File and line, the relevant evidence, and a reproducible trigger or specific
  explanation of how the code creates the problem.
- User or maintenance impact and the smallest reasonable correction.
- Confidence and what was actually verified. Label uncertainty explicitly; do not
  present a suspected API mismatch as a confirmed failure.

Finish the report with checks and limitations. If there are no actionable findings,
say that directly. Do not pad reports with compliments or generic best practices.

## Decider

After all three reviewers settle, launch a fresh, separate Orca worker as the
decider. Give it the scope, all reports, relevant source, and check results. Its
task is to adjudicate independently, not merge reviewer lists mechanically.

For every finding, choose **accept**, **reject**, or **defer**, with a short reason:

- Verify the claim against code and evidence. Several reviewers repeating a claim
  is not proof. Merge duplicates while preserving their original IDs.
- Weigh likelihood and impact against added concepts, code, tests, and ongoing
  maintenance. Ask whether the smallest fix makes this small repository easier to
  understand and maintain.
- Accept concrete bugs and useful simplifications. Reject unsupported claims,
  cosmetic preferences, speculative flexibility, and disproportionate defenses.
  Do not dismiss real data loss or lifecycle bugs merely because the repo is small.
- Defer only when a material question cannot be resolved from available evidence
  or the work is explicitly outside scope. Name what would resolve it. Do not
  create a backlog of hypothetical improvements.
- If uncertain about an important finding, request one targeted clarification
  through the coordinator. Avoid an open-ended debate or repeated whole-repo review.
- An empty accepted list is fine. The decider is not rewarded for agreeing with
  reviewers or for finding extra work. It may add a new finding only with the same
  evidence standard, clearly labeled as its own.

Write `decision.md` with:

1. Verdict: **ready**, **changes recommended**, or **incomplete**.
2. Accepted findings in priority order, each with the smallest recommended fix.
3. Rejected and deferred finding IDs with reasons.
4. Verification evidence, missing checks, and the scope reviewed.

Use **ready** when no actionable findings remain and applicable checks passed.
Use **changes recommended** for accepted findings. Use **incomplete** when missing
reviewer results, stale scope, or material unverified behavior prevents a reliable
recommendation. Passing tests alone does not establish correctness.

The decision is a recommendation to the user. It does not authorize edits, commits,
publishing, or overriding the user's instructions.

## Orca coordination

Use the installed orchestration skill to resolve the correct executable and load
its version-matched guide. Follow that guide's runtime discovery, Run creation,
Task/Dispatch lifecycle, message acknowledgment, recovery, and release rules rather
than treating commands in repository documentation as a fixed CLI API.

Each worker task must be self-contained: target, requested result, constraints,
file ownership, report path, and observable acceptance. Name its role from this
guide and provide the scope path. Require a final report with findings (or an
explicit no-findings result) and checks, plus the live preamble's authoritative
completion message. Workers must not delegate or edit files beyond their report.

The coordinator starts the full independent wave before waiting. It validates each
completion against its expected active Dispatch and reads the report before
acknowledging delivery. Release settled reviewer workers according to the runtime
guide; the decider can read their durable reports after release. A failed or missing
reviewer is not a clean review. Do not launch the decider as if all reports succeeded.
Never treat a quiet worker or an empty wait as proof of exit.

After accepting and releasing the decider, check scope freshness and report the
verdict, accepted findings, verification, and unresolved limitations to the user.
Link the local reports. Review-only work stops there. If the user also requested
fixes, route only accepted findings to the authorized implementation owner, then
run relevant checks and verify those fixes. A decision that requires changes
cannot be reported as ready just because the review agents finished.
