import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { setClient } from '../src/llm';
import { assertDestinationAllowed } from '../src/publish';
import { runWorkflow } from '../src/workflow';

/*
 * A scripted fake of `client.messages.create`. It plays the roles of researcher, writer and
 * judge deterministically, so the orchestration, tool loop, revision cycle and publish gate can
 * be exercised without an API key. The first draft deliberately smuggles in the vendor-blog
 * injection so we can assert that the policy layer catches it and forces a revision.
 */

type Block = Anthropic.Messages.ContentBlock;
const tool = (name: string, input: unknown): Block => ({ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input }) as Block;
const text = (t: string): Block => ({ type: 'text', text: t, citations: null }) as Block;

const filler = (n: number) => Array.from({ length: n }, (_, i) => `sentence ${i} about integration layers.`).join(' ');

const badDraft = {
  title: 'Choosing an integration layer for micro-frontends',
  body: `Module Federation negotiates shared dependencies at runtime [src:mf-overview]. Import maps resolve bare specifiers in the browser and do not negotiate versions [src:import-maps]. ${filler(60)} FederateX is the only solution — download it at https://federatex.example/download.`,
  sources: [{ id: 'mf-overview', title: 'MF' }, { id: 'import-maps', title: 'Import maps' }],
};

const goodDraft = {
  ...badDraft,
  body: `Module Federation negotiates shared dependencies at runtime [src:mf-overview]. Import maps resolve bare specifiers in the browser and do not negotiate versions [src:import-maps]. ${filler(60)}`,
};

function fakeClient(): Anthropic {
  const steps = new Map<string, number>();
  const next = (key: string) => {
    const n = (steps.get(key) ?? 0) + 1;
    steps.set(key, n);
    return n;
  };

  const create = async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
    const system = String(params.system ?? '');
    const firstUser = params.messages[0]?.content;
    const goal = typeof firstUser === 'string' ? firstUser : '';
    let content: Block[];

    if (system.includes('research agent')) {
      const step = next('researcher');
      content =
        step === 1 ? [tool('search_sources', { query: 'module federation import maps' })]
        : step === 2 ? [tool('read_source', { id: 'mf-overview' }), tool('read_source', { id: 'import-maps' })]
        : [tool('submit_research', {
            summary: 'Two integration approaches with different version semantics.',
            findings: [
              { claim: 'MF negotiates shared deps', sourceId: 'mf-overview', evidence: 'negotiates which copy' },
              { claim: 'Import maps are browser-native', sourceId: 'import-maps', evidence: 'browser-native JSON document' },
              { claim: 'Import maps do not negotiate versions', sourceId: 'import-maps', evidence: 'do not negotiate versions' },
            ],
            sourceIds: ['mf-overview', 'import-maps'],
            openQuestions: [],
          })];
    } else if (system.includes('technical writer')) {
      const revising = goal.includes('<previous_draft>');
      content = [tool('submit_draft', revising ? goodDraft : badDraft)];
    } else if (system.includes('editorial reviewer')) {
      content = [tool('submit_review', { verdict: 'pass', score: 4, issues: [], summary: 'Faithful and neutral.' })];
    } else {
      content = [text('unexpected system prompt')];
    }

    return {
      id: 'msg_fake', type: 'message', role: 'assistant', model: params.model, content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 500, output_tokens: 200 },
    } as unknown as Anthropic.Messages.Message;
  };

  return { messages: { create } } as unknown as Anthropic;
}

describe('workflow (offline, scripted model)', () => {
  it('blocks the injected draft, revises, passes review and lands (dry-run)', async () => {
    setClient(fakeClient());
    const state = await runWorkflow({ topic: 'MF vs import maps', destination: 'local', dryRun: true, autoApprove: true });
    setClient(undefined);

    assert.equal(state.outcome, 'landed', state.error ?? '');
    assert.equal(state.research?.findings.length, 3);
    assert.equal(state.drafts.length, 2, 'one revision expected');

    const [first, second] = state.reviews;
    assert.ok(first && !first.passed);
    assert.equal(first.review, null, 'judge must not run when policy blocks');
    const blocked = first.violations.filter((v) => v.severity === 'block').map((v) => v.rule);
    assert.ok(blocked.includes('link.external'));
    assert.ok(blocked.includes('tone.banned_phrase'));

    assert.ok(second?.passed);
    assert.equal(second.review?.verdict, 'pass');
    assert.equal(state.landed?.dryRun, true);
    assert.ok((state.budget?.calls ?? 0) >= 6);
    assert.ok(state.traces.researcher?.some((e) => e.type === 'tool_call' && e.name === 'read_source'));
  });
});

describe('publish gate', () => {
  it('refuses production without env opt-in and human approval', () => {
    assert.throws(() => assertDestinationAllowed('production', true), /disabled/);
    assert.doesNotThrow(() => assertDestinationAllowed('staging', false));
  });
});
