/**
 * Unit tests for RugCheck filter logic (no network).
 * Run: node scripts/test-rugcheck-logic.mjs
 */
import {
  rugcheckDisplayScore,
  summarizeRugcheckReport,
  rugcheckFilterFailure,
} from '../src/enrichment/rugcheck.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('=== RugCheck logic tests ===\n');

// score_normalised preferred
assert(
  rugcheckDisplayScore({ score_normalised: 76, score: 9999 }) === 76,
  'uses score_normalised 76',
);
assert(
  rugcheckDisplayScore({ score: 46 }) === 46,
  'falls back to score 0-100',
);
assert(rugcheckDisplayScore({ score: 15000 }) === null, 'ignores raw score > 100');

// summarize — creator rugged flag detected but not used for pass/fail
const give = summarizeRugcheckReport({
  score_normalised: 76,
  riskLevel: 'Danger',
  risks: [{ name: 'Creator history of rugged tokens' }],
});
assert(give.displayScore === 76 && give.creatorHistoryRug === true, 'GIVE-like: score 76 + creator rugged flag');

const african = summarizeRugcheckReport({
  score_normalised: 46,
  riskLevel: 'Danger',
  risks: [{ name: 'Creator history of rugged tokens' }, { name: 'Low amount of LP Providers' }],
});
assert(african.displayScore === 46, 'African-like: score 46');

// filter — min 55: pass 76, fail 46/33
process.env.RUGCHECK_FAIL_OPEN = 'false';

assert(
  rugcheckFilterFailure({ rugcheck: { displayScore: 76, riskFlags: ['Creator history of rugged tokens'] } }, 55) === null,
  'PASS: score 76 with creator rugged history (score-only gate)',
);
assert(
  String(rugcheckFilterFailure({ rugcheck: { displayScore: 46, riskFlags: ['x'] } }, 55)).includes('46/100'),
  'FAIL: score 46',
);
assert(
  String(rugcheckFilterFailure({ rugcheck: { displayScore: 33 } }, 55)).includes('33/100'),
  'FAIL: score 33',
);
assert(
  rugcheckFilterFailure({ rugcheck: { displayScore: 55 } }, 55) === null,
  'PASS: score exactly 55',
);
assert(
  String(rugcheckFilterFailure({ rugcheck: { displayScore: 54 } }, 55)).includes('54/100'),
  'FAIL: score 54',
);

process.env.RUGCHECK_FAIL_OPEN = 'true';
assert(
  rugcheckFilterFailure({ rugcheck: { unavailable: true, reason: 'timeout' } }, 55) === null,
  'fail-open: unavailable does not block',
);

assert(rugcheckFilterFailure({ rugcheck: { displayScore: 80 } }, 0) === null, 'min 0 = filter off');

// integration with filterCandidate (no network)
const { initDb } = await import('../src/db/connection.js');
const { strategyById, setActiveStrategy } = await import('../src/db/settings.js');
const { filterCandidate } = await import('../src/pipeline/candidateBuilder.js');
initDb();
setActiveStrategy('graduate_immediate');
assert(strategyById('graduate_immediate').min_rugcheck_score === 55, 'DB min_rugcheck_score is 55');

const base = {
  token: { mint: 'TestMint1111111111111111111111111111111111' },
  metrics: { marketCapUsd: 50000, liquidityUsd: 20000, holderCount: 200, volume1hUsd: 5000 },
  holders: { top20: [{ percent: 10 }, { percent: 5 }], maxHolderPercent: 22, top4HolderCombinedPercent: 40 },
  graduation: { graduationDate: Date.now() - 120000 },
  trending: { bundler_rate: 0.1 },
  savedWalletExposure: { holderCount: 0 },
};

const f76 = filterCandidate({ ...base, rugcheck: { displayScore: 76, creatorHistoryRug: true } });
assert(f76.passed, 'filterCandidate PASS score 76 + creator rugged');

const f46 = filterCandidate({ ...base, rugcheck: { displayScore: 46 } });
assert(!f46.passed && f46.failures.some(x => x.startsWith('rugcheck:')), 'filterCandidate FAIL score 46');

const fBare = filterCandidate({
  token: { mint: 'x' },
  metrics: { marketCapUsd: 50000, liquidityUsd: 20000, holderCount: 200 },
  holders: { maxHolderPercent: 20 },
  graduation: { graduationDate: Date.now() - 120000 },
  rugcheck: { displayScore: 70 },
});
assert(fBare.passed, 'filterCandidate no crash without savedWalletExposure');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
