import Anthropic from '@anthropic-ai/sdk';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Run-wide token accounting. One Budget instance is shared by every agent and judge call
 * in a workflow run, so the total cost of a run is bounded no matter how the agents behave.
 */
export class Budget {
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;

  constructor(readonly maxTotalTokens: number) {}

  get total(): number {
    return this.inputTokens + this.outputTokens;
  }

  record(usage: Anthropic.Messages.Usage): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.calls += 1;
    if (this.total > this.maxTotalTokens) {
      throw new BudgetExceededError(
        `Token budget exceeded: ${this.total} > ${this.maxTotalTokens} after ${this.calls} calls`,
      );
    }
  }

  summary() {
    return { calls: this.calls, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}

let client: Anthropic | undefined;

/** Dependency injection point — tests pass a scripted fake so the whole workflow runs offline. */
export function setClient(override: Anthropic | undefined): void {
  client = override;
}

export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env or export it in your shell.');
    }
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  }
  return client;
}

/** The only place in the codebase that talks to the model. Every call is charged to the budget. */
export async function createMessage(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  budget: Budget,
): Promise<Anthropic.Messages.Message> {
  const message = await getClient().messages.create(params);
  budget.record(message.usage);
  return message;
}
