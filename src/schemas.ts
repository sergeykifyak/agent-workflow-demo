import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';

/*
 * Every step boundary in the workflow has an explicit contract. The same zod schema is used
 * twice: (1) converted to a JSON schema for a strict tool so the API guarantees the *shape*,
 * and (2) run at runtime so we also enforce *constraints* (min items, lengths, etc.) that the
 * strict-tool grammar does not cover. "Trust, but verify" — the API's guarantee is not a
 * substitute for validation at the trust boundary.
 */

export const ResearchFinding = z.object({
  claim: z.string().describe('One factual statement, in your own words'),
  sourceId: z.string().describe('The id of the source that supports this claim'),
  evidence: z.string().describe('Short quote or close paraphrase from that source'),
});

export const ResearchNotes = z.object({
  summary: z.string().describe('2-4 sentence overview of what the sources say'),
  findings: z.array(ResearchFinding).min(3),
  sourceIds: z.array(z.string()).min(2).describe('Every source id you actually read and rely on'),
  openQuestions: z.array(z.string()).describe('Things the sources did not answer (may be empty)'),
});
export type ResearchNotes = z.infer<typeof ResearchNotes>;

export const DraftSource = z.object({
  id: z.string(),
  title: z.string(),
});

export const Draft = z.object({
  title: z.string().min(5),
  body: z
    .string()
    .describe('Markdown body. Cite sources inline with [src:ID] markers. No external links.'),
  sources: z.array(DraftSource).min(1).describe('Only sources that are cited in the body'),
});
export type Draft = z.infer<typeof Draft>;

export const ReviewIssue = z.object({
  severity: z.enum(['minor', 'major']),
  message: z.string(),
  quote: z.string().describe('The offending passage, or an empty string if not applicable'),
});

export const Review = z.object({
  verdict: z.enum(['pass', 'revise', 'reject']),
  score: z.number().int().min(1).max(5).describe('1 = unpublishable, 5 = excellent'),
  issues: z.array(ReviewIssue),
  summary: z.string(),
});
export type Review = z.infer<typeof Review>;

// ---------------------------------------------------------------------------

/** Keys that the strict-tool JSON Schema subset does not support; zod still enforces them at runtime. */
const UNSUPPORTED_KEYS = new Set(['$schema', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_KEYS.has(key)) continue;
      out[key] = sanitize(value);
    }
    return out;
  }
  return node;
}

/**
 * Convert a zod object schema into an `input_schema` suitable for `strict: true`.
 * Strict mode requires `additionalProperties: false` and every property listed in `required`,
 * which zod v4's `toJSONSchema` already produces for objects without optional fields.
 */
export function toStrictInputSchema(schema: z.ZodType): Anthropic.Messages.Tool['input_schema'] {
  const json = sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
  return { ...json, type: 'object' } as Anthropic.Messages.Tool['input_schema'];
}
