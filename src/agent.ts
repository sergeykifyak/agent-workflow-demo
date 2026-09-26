import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { Budget, createMessage } from './llm';
import { toStrictInputSchema } from './schemas';
import { log } from './log';

/*
 * A goal-oriented agent is given a GOAL, a set of TOOLS and a FINISH contract — never a script.
 * The model decides which tools to call and in what order; this loop only (a) executes tools,
 * (b) enforces limits, and (c) validates the final result against the contract.
 *
 * Design rules:
 *  - The agent can only *propose*. Side effects that matter (publishing) are not tools here;
 *    they belong to the orchestrator behind guardrails (see workflow.ts / publish.ts).
 *  - Everything a tool returns is untrusted data. Tools wrap their output to say so.
 *  - The loop always terminates: max steps, max tool calls, and a run-wide token budget.
 */

export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run: (input: I) => Promise<string>;
}

export interface FinishSpec<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
}

export interface AgentLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxTokensPerStep: number;
}

export interface AgentSpec<T> {
  name: string;
  model: string;
  system: string;
  goal: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[];
  finish: FinishSpec<T>;
  limits: AgentLimits;
}

export type TraceEvent =
  | { type: 'model'; step: number; stopReason: string | null; inputTokens: number; outputTokens: number }
  | { type: 'tool_call'; step: number; name: string; input: unknown }
  | { type: 'tool_result'; step: number; name: string; ok: boolean; preview: string }
  | { type: 'finish'; step: number; valid: boolean; error?: string };

export interface AgentRun<T> {
  result: T;
  steps: number;
  toolCalls: number;
  trace: TraceEvent[];
}

export class AgentError extends Error {
  constructor(message: string, readonly trace: TraceEvent[]) {
    super(message);
    this.name = 'AgentError';
  }
}

function toToolDefinition(tool: { name: string; description: string; input: z.ZodType }): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    strict: true,
    input_schema: toStrictInputSchema(tool.input),
  };
}

export async function runAgent<T>(spec: AgentSpec<T>, budget: Budget): Promise<AgentRun<T>> {
  const { limits, finish } = spec;
  const trace: TraceEvent[] = [];
  const toolsByName = new Map(spec.tools.map((t) => [t.name, t]));

  const toolDefinitions: Anthropic.Messages.Tool[] = [
    ...spec.tools.map(toToolDefinition),
    toToolDefinition({ name: finish.name, description: finish.description, input: finish.schema }),
  ];

  const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: spec.goal }];
  let toolCalls = 0;
  let nudged = false;

  for (let step = 1; step <= limits.maxSteps; step++) {
    const response = await createMessage(
      {
        model: spec.model,
        max_tokens: limits.maxTokensPerStep,
        system: spec.system,
        tools: toolDefinitions,
        messages,
      },
      budget,
    );

    trace.push({
      type: 'model',
      step,
      stopReason: response.stop_reason,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    log.debug(spec.name, `step ${step}: stop_reason=${response.stop_reason}`);

    // Echo the assistant turn back verbatim (including any thinking blocks) to keep the transcript valid.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      throw new AgentError(`${spec.name}: model refused the task`, trace);
    }
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
      throw new AgentError(`${spec.name}: response truncated (${response.stop_reason})`, trace);
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
    );

    // The model stopped talking without delivering. Give it exactly one nudge, then fail.
    if (toolUses.length === 0) {
      if (nudged) throw new AgentError(`${spec.name}: ended without calling ${finish.name}`, trace);
      nudged = true;
      messages.push({ role: 'user', content: `Deliver your result now by calling the ${finish.name} tool.` });
      continue;
    }

    const results: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const call of toolUses) {
      // --- Finish: validate the contract. Valid -> we are done. Invalid -> tell the model why and let it retry.
      if (call.name === finish.name) {
        const parsed = finish.schema.safeParse(call.input);
        if (parsed.success) {
          trace.push({ type: 'finish', step, valid: true });
          log.info(spec.name, `finished in ${step} step(s), ${toolCalls} tool call(s)`);
          return { result: parsed.data, steps: step, toolCalls, trace };
        }
        const error = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
        trace.push({ type: 'finish', step, valid: false, error });
        log.warn(spec.name, `invalid ${finish.name} payload: ${error}`);
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Invalid payload: ${error}` });
        continue;
      }

      // --- Regular tool call, subject to the tool-call budget.
      trace.push({ type: 'tool_call', step, name: call.name, input: call.input });
      if (toolCalls >= limits.maxToolCalls) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          is_error: true,
          content: `Tool budget exhausted (${limits.maxToolCalls}). Call ${finish.name} with what you have.`,
        });
        continue;
      }
      toolCalls += 1;

      const tool = toolsByName.get(call.name);
      let content: string;
      let ok = true;
      try {
        if (!tool) throw new Error(`unknown tool ${call.name}`);
        const input = tool.input.parse(call.input); // strict mode guarantees shape; zod enforces constraints
        content = await tool.run(input);
      } catch (err) {
        ok = false;
        content = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      trace.push({ type: 'tool_result', step, name: call.name, ok, preview: content.slice(0, 120) });
      log.debug(spec.name, `${call.name}(${JSON.stringify(call.input)}) -> ${ok ? 'ok' : 'error'}`);
      results.push({ type: 'tool_result', tool_use_id: call.id, is_error: !ok, content });
    }

    messages.push({ role: 'user', content: results });
  }

  throw new AgentError(`${spec.name}: exceeded ${limits.maxSteps} steps without finishing`, trace);
}
