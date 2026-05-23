/**
 * Live RugCheck API smoke test (uses .env RUGCHECK_API_KEY).
 * Run: node scripts/test-rugcheck-api.mjs [mint]
 */
import dotenv from 'dotenv';
dotenv.config();

import {
  RUGCHECK_API_KEY,
  RUGCHECK_BASE_URL,
  RUGCHECK_ENABLED,
} from '../src/config.js';
import { fetchRugcheckSummary, rugcheckFilterFailure } from '../src/enrichment/rugcheck.js';

const mint = process.argv[2] || 'So11111111111111111111111111111111111111112';

console.log('=== RugCheck API smoke test ===');
console.log(`enabled: ${RUGCHECK_ENABLED}`);
console.log(`base: ${RUGCHECK_BASE_URL}`);
console.log(`api key set: ${Boolean(RUGCHECK_API_KEY)}`);
console.log(`mint: ${mint}\n`);

if (!RUGCHECK_ENABLED) {
  console.error('RUGCHECK_ENABLED is false');
  process.exit(1);
}

const t0 = Date.now();
const summary = await fetchRugcheckSummary(mint, { useCache: false });
const ms = Date.now() - t0;

console.log(`latency: ${ms}ms`);
console.log('summary:', JSON.stringify(summary, null, 2));

const fail55 = rugcheckFilterFailure({ rugcheck: summary }, 55);
console.log(`filter min 55: ${fail55 ?? 'PASS'}`);

if (!RUGCHECK_API_KEY) {
  console.warn('\n⚠ RUGCHECK_API_KEY empty — using unauthenticated rate limit (1 req/s)');
}

process.exit(summary?.unavailable && !summary?.failOpen ? 1 : 0);
