/**
 * Smoke tests for live position sizing (gas reserve + /size target).
 */
import { computeDynamicPositionSize, computeGasReserveLamports, canAffordLiveEntry } from '../src/execution/sizing.js';

const SOL = 1_000_000_000;
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

const strat = { position_size_sol: 0.1 };

// 1 SOL wallet, 10% gas reserve = 0.1 SOL reserved, 0.9 available → buy 0.1
const bal1 = SOL;
const gas1 = computeGasReserveLamports(bal1);
assert(gas1 === Math.floor(0.1 * SOL), `gas reserve 10% = ${gas1 / SOL} SOL`);
assert(computeDynamicPositionSize(bal1, strat) === Math.floor(0.1 * SOL), 'full 0.1 SOL target when balance allows');
assert(canAffordLiveEntry(bal1, strat), 'can afford with 1 SOL');

// thin wallet: 0.12 SOL total, reserve ~0.02 min → ~0.1 available
const balThin = Math.floor(0.12 * SOL);
const sizeThin = computeDynamicPositionSize(balThin, strat);
assert(sizeThin > 0 && sizeThin <= Math.floor(0.1 * SOL), `thin wallet sizes down (${sizeThin / SOL})`);
assert(canAffordLiveEntry(balThin, strat) || sizeThin === 0, 'thin wallet afford check consistent');

// empty
assert(computeDynamicPositionSize(Math.floor(0.01 * SOL), strat) === 0, 'too low balance → 0');
assert(!canAffordLiveEntry(Math.floor(0.01 * SOL), strat), 'cannot afford dust wallet');

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
