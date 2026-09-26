import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { config, type Destination } from './config';
import { log } from './log';
import { runWorkflow } from './workflow';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dest: { type: 'string', default: 'local' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm start -- "<topic>" [--dest local|staging|production] [--dry-run] [--yes] [--verbose]

  --dest      where an approved draft lands (default: local). production also needs ALLOW_PRODUCTION=1
  --dry-run   run every step including approval, but write nothing
  --yes       skip the interactive approval prompt (ignored for production)
  --verbose   print every model step and tool call`);
  process.exit(0);
}

const topic = positionals.join(' ').trim() || 'Module Federation vs. import maps: choosing an integration layer for micro-frontends';
const destination = values.dest as Destination;
if (!config.publish.allowedDestinations.includes(destination)) {
  log.error('cli', `unknown destination "${values.dest}"`);
  process.exit(2);
}

const state = await runWorkflow({ topic, destination, dryRun: values['dry-run'], autoApprove: values.yes });

// Persist the full run (state + traces) for observability / debugging.
const runsDir = path.join(config.publish.outDir, 'runs');
await mkdir(runsDir, { recursive: true });
const runFile = path.join(runsDir, `${state.startedAt.replace(/[:.]/g, '-')}.json`);
await writeFile(runFile, JSON.stringify(state, null, 2), 'utf8');

console.log(`\nOutcome:   ${state.outcome}${state.error ? ` — ${state.error}` : ''}`);
if (state.landed?.path) console.log(`Landed at: ${state.landed.path}`);
console.log(`Reviews:   ${state.reviews.map((r) => `round ${r.round}: ${r.passed ? 'pass' : r.review?.verdict ?? 'blocked by policy'}`).join(' | ')}`);
console.log(`Budget:    ${state.budget?.calls} calls, ${state.budget?.inputTokens} in / ${state.budget?.outputTokens} out tokens`);
console.log(`Run log:   ${runFile}`);

process.exit(state.outcome === 'landed' || state.outcome === 'not-approved' ? 0 : 1);
