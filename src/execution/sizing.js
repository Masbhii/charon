import { LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { numSetting } from '../db/settings.js';

const SOL = 1_000_000_000;
const MIN_TRADE_LAMPORTS = Math.floor(0.01 * SOL);

/** Gas + buffer kept in wallet (percent of balance, floor = LIVE_MIN_SOL_RESERVE). */
export function computeGasReserveLamports(balanceLamports) {
  const pct = Number(process.env.LIVE_GAS_RESERVE_PERCENT || 10) / 100;
  const percentReserve = Math.floor(balanceLamports * pct);
  return Math.max(LIVE_MIN_SOL_RESERVE_LAMPORTS, percentReserve);
}

/**
 * Per-entry size for live swaps: target = strategy position_size_sol (/size),
 * capped by wallet after gas reserve. No max-open cap — only balance limits entries.
 */
export function computeDynamicPositionSize(balanceLamports, strat) {
  const targetLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * SOL);
  const gasReserve = computeGasReserveLamports(balanceLamports);
  const available = balanceLamports - gasReserve;
  if (available < MIN_TRADE_LAMPORTS) return 0;
  const amount = Math.min(targetLamports, available);
  return amount >= MIN_TRADE_LAMPORTS ? amount : 0;
}

export function canAffordLiveEntry(balanceLamports, strat) {
  const amount = computeDynamicPositionSize(balanceLamports, strat);
  if (amount < MIN_TRADE_LAMPORTS) return false;
  const gasReserve = computeGasReserveLamports(balanceLamports);
  return balanceLamports >= amount + gasReserve;
}
