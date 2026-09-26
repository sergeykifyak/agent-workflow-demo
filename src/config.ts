/**
 * Single place for every knob that shapes agent behaviour and what is allowed to land.
 * Everything here is deliberately boring and declarative: a reviewer should be able to
 * read this file and know the blast radius of the whole system.
 */
export type Destination = 'local' | 'staging' | 'production';

export const config = {
  models: {
    /** Does the actual work (research, drafting). */
    worker: process.env.WORKER_MODEL ?? 'claude-sonnet-5',
    /** Independent reviewer. A different, cheaper model keeps review costs low and
     *  avoids "grading your own homework". */
    judge: process.env.JUDGE_MODEL ?? 'claude-haiku-4-5',
  },

  /** Hard resource limits. Agents are goal-oriented, so without these they could loop forever. */
  budget: {
    maxTotalTokens: 250_000, // whole workflow run (input + output)
    maxStepsPerAgent: 12, // model round-trips per agent
    maxToolCallsPerAgent: 20, // tool executions per agent
    maxRevisions: 2, // draft -> review -> revise cycles before giving up
    maxTokensPerStep: 8_192,
  },

  /** Editorial policy — deterministic rules every draft must satisfy before an LLM judge even sees it. */
  policy: {
    minWords: 250,
    maxWords: 700,
    /** External links are forbidden in the body unless the host is listed here. Empty = none allowed. */
    allowedLinkDomains: [] as string[],
    bannedPhrases: ['the only solution', 'guaranteed', '100%', 'revolutionary', 'game-changing'],
    /** Text that looks like instructions aimed at an AI must never land — it signals that
     *  tool output (untrusted data) leaked into the agent's behaviour. */
    injectionPatterns: [
      /ignore (all |any |your |the |previous |prior )*instructions/i,
      /disregard (all |any |your |the |previous |prior )*(rules|guidelines|instructions)/i,
      /system prompt/i,
      /\bAI assistants? reading this\b/i,
    ],
  },

  publish: {
    /** Destinations the orchestrator may write to at all. */
    allowedDestinations: ['local', 'staging', 'production'] as Destination[],
    /** Production needs an explicit environment opt-in AND interactive human approval. */
    productionEnabled: process.env.ALLOW_PRODUCTION === '1',
    outDir: 'out',
  },
} as const;
