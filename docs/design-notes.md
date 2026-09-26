# Design notes

Why the code is shaped the way it is. Read the README first; this assumes you have.

## 1. Where the trust boundaries are

```
   user / operator ─────────────┐
                                ▼
   orchestrator (trusted code) ──── decides sequence, retries, and whether anything lands
        │              ▲
        ▼              │  contracts (strict tool + zod)
   agents (semi-trusted) ─── autonomous inside a step, can only propose
        │              ▲
        ▼              │  wrapped, labelled as data
   tools / sources (untrusted) ─── anything a tool returns is input, never instruction
```

Two consequences fall out of this:

- **Side effects live above the agents.** `landDraft()` is called by the orchestrator, never offered as a tool.
  An agent that is convinced (or tricked) to "publish now" has no way to do it.
- **The direction of trust never flips.** Tool output is wrapped in `<source trust="untrusted">` on the way in,
  and `safety.injection_residue` checks on the way out whether instruction-like text made it into a draft anyway.
  The prompt-level reminder is a soft control; the policy rule is the hard one.

## 2. Why each layer of the review exists

| Layer | Catches | Cost | Can be argued with? |
| --- | --- | --- | --- |
| Strict tool schema | malformed JSON, missing fields, wrong types | none (API-side) | no |
| zod re-validation | `min(3)` items, enum case, length bounds — constraints the grammar subset cannot express | µs | no |
| Deterministic policy | hallucinated or unread citations, external links, PII, banned phrases, injection residue, length | µs | no |
| LLM judge | claims not supported by the cited source, vendor bias, weak structure — things that need reading | one cheap model call | yes, so it is never the only gate |
| Human approval | everything else; and it is where accountability sits | a person's time | — |

Ordering is by cost. A draft with a blocking policy violation never reaches the judge, so review spend is only
paid for drafts that could actually land.

The judge is a **different model with a different prompt** that sees only the draft and the sources it cites —
not the writer's conversation. Sharing context would let the same mistaken reading of a source pass twice.

## 3. Provenance over plausibility

`citation.unknown` rejects references to sources that do not exist. `citation.unread` goes further: the source
must have been opened with `read_source` during *this* run. The tool records every id it serves into a shared
`Set`; the policy check consults it. This turns "did the model make this up?" from a judgment call into a lookup.

The same mechanism is why `read_source` is available to the writer, not only the researcher: a writer that wants
to quote a source has to open it, which registers it.

## 4. Termination and cost

Goal-oriented agents can loop. Every loop here is bounded on several axes at once:

- per agent: `maxSteps` (model round-trips) and `maxToolCalls` (tool executions) — when the tool budget is
  gone the agent is told to finish with what it has rather than failing outright;
- per workflow: `maxRevisions`;
- per run: one `Budget` object charged by every model call, judge included. Exceeding it throws, the run is
  recorded as `failed`, nothing lands.

`config.ts` is the single file to read to know the worst case of a run.

## 5. Failure modes and what happens

| Failure | Handling |
| --- | --- |
| Agent stops talking without calling the finish tool | one nudge, then `AgentError` |
| Finish payload fails zod | error returned as a `tool_result`; the model can retry within the step budget |
| Unknown or invalid tool input | `tool_result` with `is_error`, no exception |
| Model refuses / output truncated | `AgentError`, run marked `failed` |
| Draft blocked by policy | structured violations fed back to the writer, revise |
| Judge says `revise` | issues with quotes fed back to the writer, revise |
| Judge says `reject` or revisions exhausted | run marked `rejected`, nothing lands |
| Human declines | `not-approved`, nothing lands, exit code 0 (a valid outcome, not an error) |
| Token budget exceeded | `BudgetExceededError`, run marked `failed` |
| `--dest production` without `ALLOW_PRODUCTION=1` | refused before anything is written; `--yes` is ignored for production |

Every outcome is written to `out/runs/<timestamp>.json` with full traces, so a bad run can be replayed and
reasoned about after the fact.

## 6. Deliberate simplifications

- **Local corpus instead of web search** keeps runs deterministic and the demo offline. Swapping in the API's
  server-side web search or an internal connector does not touch `agent.ts`; keep the read log so provenance
  checks keep working.
- **Folders instead of a CMS** as publish destinations. `assertDestinationAllowed` is the part to keep in front of
  a real client.
- **Hand-rolled agent loop.** The SDK ships a tool-runner helper, and the Claude Agent SDK adds hooks and
  subagents. The explicit loop exists so the mechanics are visible in ~150 lines.
- **Single-process, sequential.** Research and drafting could run as queued jobs with the same contracts between
  them; the orchestrator would then be a state machine over a store rather than a function.

## 7. What a production version adds

- Traces to OpenTelemetry (the `TraceEvent[]` shape is already span-like), cost per run to metrics.
- Prompt and policy versioning: a run should record which prompt/policy version produced it.
- An evaluation set of past drafts with known verdicts, run in CI against the judge prompt, so prompt changes
  are measured rather than felt.
- Rate-limit and retry policy around `createMessage` (the SDK retries transient errors; the workflow-level
  decision of "how long are we willing to wait" belongs in config).
- A review UI instead of a terminal prompt; the approval step's contract stays the same.
