import { JUPITER_API_KEY, SOLANA_PRIVATE_KEY } from './config.js';
import { liveWalletPubkey, requireLiveExecution } from './liveExecutor.js';

/** Errors blocking live swaps (empty = ready). */
export function getLiveReadinessErrors() {
  const errors = [];
  if (!String(SOLANA_PRIVATE_KEY || '').trim()) {
    errors.push('SOLANA_PRIVATE_KEY missing in .env — add wallet key and restart bot');
  }
  if (!String(JUPITER_API_KEY || '').trim()) {
    errors.push('JUPITER_API_KEY missing in .env');
  }
  if (!liveWalletPubkey()) {
    errors.push('Wallet not loaded — fix SOLANA_PRIVATE_KEY format and restart bot');
  } else {
    try {
      requireLiveExecution();
    } catch (err) {
      errors.push(err.message);
    }
  }
  return errors;
}

export function isLiveReady() {
  return getLiveReadinessErrors().length === 0;
}

export function warnIfLiveMisconfigured(tradingMode) {
  if (tradingMode !== 'live') return;
  const errors = getLiveReadinessErrors();
  if (errors.length) {
    console.log(`[live] NOT READY: ${errors.join(' | ')}`);
    console.log('[live] Set keys in .env and restart before live entries.');
  }
}
