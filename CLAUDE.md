# CLAUDE.md

Showcase project: goal-oriented agents, a multi-step workflow and layered output guardrails on the Claude API.
`README.md` has the pitch and architecture, `docs/design-notes.md` the reasoning. If a `HANDOFF.md` exists in
the root (local, gitignored), read it first — it holds the session history and the open task list.

## Commands

```bash
npm install
npm test                      # offline: policy rules + scripted end-to-end run. Must pass without an API key.
npm run typecheck             # tsc --noEmit
npm start -- --dry-run --yes  # real models, default topic, nothing written; add --verbose for every step
npm start -- "<topic>" --dest local|staging|production [--dry-run] [--yes]
```

Runs write `out/runs/<timestamp>.json` (state, drafts, reviews, traces, token usage). `out/` is gitignored.

## Layout

- `src/config.ts` — every limit, model, policy rule and publish allow-list. Change behaviour here first.
- `src/llm.ts` — the only module that calls the API; `Budget` charges every call; `setClient()` is the test seam.
- `src/schemas.ts` — zod contracts for each step; `toStrictInputSchema()` turns them into `strict: true` tool schemas.
- `src/agent.ts` — generic `runAgent()`: goal + tools + finish contract, bounded by steps/tool calls/budget.
- `src/tools.ts` — read-only tools; `read_source` logs which ids were opened (provenance).
- `src/corpus.ts` — local demo knowledge base; `vendor-blog` deliberately contains a prompt injection.
- `src/guardrails.ts` — deterministic policy checks, independent LLM judge, human approval prompt.
- `src/publish.ts` — the single side-effecting path, behind `assertDestinationAllowed()`.
- `src/workflow.ts` — orchestrator: research → draft → review (revise ≤ N) → publish; system prompts live here.
- `test/` — `guardrails.test.ts` (policy rules), `workflow.test.ts` (scripted fake model, full pipeline).

## Invariants — keep these true

- No agent ever gets a tool with a real side effect. Publishing is called by the orchestrator only, after every gate.
- Review order stays: schema → deterministic policy → LLM judge → human. The judge runs only when policy passes.
- Every step output is a `strict: true` tool call **and** re-validated with zod. Finish schemas use no `.optional()`
  (strict mode requires all properties in `required`); use empty arrays / empty strings instead.
- `toStrictInputSchema()` strips `minItems`/`minimum`/etc. from the JSON schema — zod still enforces them at runtime.
- The `readSourceIds` log must keep flowing from `read_source` into `citation.unread`.
- All loops are bounded and every bound lives in `config.ts`.
- Tool output is wrapped as untrusted data; `safety.injection_residue` stays a blocking rule.
- `npm test` must stay fully offline so CI needs no secrets.
- No company or employer names anywhere in code, docs or commit messages.

## Conventions

- TypeScript strict, ESM, run via `tsx`; no build step. Node ≥ 22.9 (`--env-file-if-exists`).
- Runtime dependencies stay at `@anthropic-ai/sdk` + `zod` unless there is a strong reason.
- Model ids: `claude-sonnet-5` (worker), `claude-haiku-4-5` (judge). Verify against the current models docs before
  changing; the judge uses forced `tool_choice`, which may need revisiting on models with adaptive thinking on by default.
- After touching prompts in `workflow.ts` or `guardrails.ts`: run `npm test`, then a live `--dry-run --yes`, and note
  what changed in the commit message.
- Commits: imperative mood, one logical change each.
