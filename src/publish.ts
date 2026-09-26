import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { config, type Destination } from './config';
import type { Draft } from './schemas';
import { log } from './log';

/*
 * This is the only module with a real side effect, and it is intentionally NOT exposed to any
 * agent as a tool. The orchestrator calls it after every guardrail has passed. Even then:
 *   - the destination must be on the allow-list,
 *   - production must be enabled via the environment AND approved by a human,
 *   - dry-run short-circuits before anything is written.
 */

export interface LandOptions {
  destination: Destination;
  dryRun: boolean;
  humanApproved: boolean;
}

export interface LandResult {
  destination: Destination;
  path: string | null;
  dryRun: boolean;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function assertDestinationAllowed(destination: Destination, humanApproved: boolean): void {
  if (!config.publish.allowedDestinations.includes(destination)) {
    throw new Error(`destination "${destination}" is not on the allow-list`);
  }
  if (destination === 'production') {
    if (!config.publish.productionEnabled) throw new Error('production publishing is disabled (set ALLOW_PRODUCTION=1)');
    if (!humanApproved) throw new Error('production publishing requires interactive human approval');
  }
}

export async function landDraft(draft: Draft, opts: LandOptions): Promise<LandResult> {
  assertDestinationAllowed(opts.destination, opts.humanApproved);

  const frontMatter = [
    '---',
    `title: ${JSON.stringify(draft.title)}`,
    `sources: [${draft.sources.map((s) => s.id).join(', ')}]`,
    `destination: ${opts.destination}`,
    `published_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
  const document = `${frontMatter}# ${draft.title}\n\n${draft.body}\n`;

  if (opts.dryRun) {
    log.info('publish', `dry-run: would publish "${draft.title}" to ${opts.destination}`);
    return { destination: opts.destination, path: null, dryRun: true };
  }

  // In this demo every destination is a folder. Replace with a CMS/API client per destination.
  const dir = path.join(config.publish.outDir, opts.destination);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${slugify(draft.title)}.md`);
  await writeFile(file, document, 'utf8');
  log.info('publish', `landed "${draft.title}" -> ${file}`);
  return { destination: opts.destination, path: file, dryRun: false };
}
