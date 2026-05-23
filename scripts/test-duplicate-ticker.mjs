import { duplicateTickerOgFailure } from '../src/pipeline/candidateBuilder.js';

const WINDOW = 600_000;
const base = 1_700_000_000_000;
const graduated = new Map([
  ['og', { coinMint: 'og', ticker: 'KITTEN', graduationDate: base }],
  ['copy4m', { coinMint: 'copy4m', ticker: 'KITTEN', graduationDate: base + 4 * 60_000 }],
  ['copy11m', { coinMint: 'copy11m', ticker: 'KITTEN', graduationDate: base + 11 * 60_000 }],
]);

let ok = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

assert(duplicateTickerOgFailure('copy4m', graduated.get('copy4m'), WINDOW, graduated) != null, '4m apart → reject');
assert(duplicateTickerOgFailure('copy11m', graduated.get('copy11m'), WINDOW, graduated) == null, '11m apart → allow');
assert(duplicateTickerOgFailure('og', graduated.get('og'), WINDOW, graduated) == null, 'OG → allow');
assert(duplicateTickerOgFailure('x', { coinMint: 'x', ticker: 'X', graduationDate: base }, 0, graduated) == null, 'window 0 = off');

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
