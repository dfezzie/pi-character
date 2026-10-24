# Working on pi-character

This is a small Pi extension. Keep changes focused on its current behavior and
supported Pi APIs. Favor direct, readable code over abstractions for hypothetical
requirements.

- Production code: `src/`; tests and fixtures: `test/`; bundled presets: `assets/`.
- Pi loads `src/index.ts` through `package.json`'s `pi.extensions` manifest.
  Ship TypeScript source and assets; no compiled `dist/` is needed.
- Preserve local startup playback, explicit opt-in model generation, and cancellation
  and shutdown cleanup. Keep personal character data outside the repository.
- Use `npm run build` for lint, formatting, type checks, and offline tests.
  Use `npm run format` to apply formatting. Run the real terminal smoke check when
  changing loading, asset paths, or terminal behavior. Paid generation is opt-in.
- Keep work local unless the user requests publishing or pushing.

## Code reviews

When the user requests a code review, follow [the review workflow](docs/code-review.md).
Use three independent Orca reviewers, then a separate decider. Read the orchestration
skill and the installed CLI's version-matched guide before coordinating workers.
Do not substitute non-Orca subagents when running this workflow.

Reviews are read-only unless the user also requests fixes. The coordinator owns
scope and worker cleanup; the decider owns the recommendation. A suggestion is an
input to evaluate, not an instruction to implement. The decider must balance actual
impact against maintenance cost and readability, and may accept none of the findings.

Dispatched reviewers and the decider must do only their assigned role; they must
not recursively launch this workflow.
