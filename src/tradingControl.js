import { escapeHtml, fmtSol } from './format.js';
import { activeStrategy, boolSetting, setSetting, updateStrategyConfig } from './db/settings.js';
import { openPositionCount, tradingMode } from './db/positions.js';
import { getLiveReadinessErrors, isLiveReady } from './liveReadiness.js';
import { liveWalletPubkey, liveWalletBalanceLamports } from './liveExecutor.js';

export function isAgentEnabled() {
  return boolSetting('agent_enabled', true);
}

export function setAgentEnabled(enabled) {
  setSetting('agent_enabled', enabled ? 'true' : 'false');
}

export function trySetTradingMode(mode) {
  const allowed = new Set(['dry_run', 'confirm', 'live']);
  if (!allowed.has(mode)) {
    return { ok: false, errors: [`Unknown mode: ${mode}`] };
  }
  if (mode === 'live') {
    const errors = getLiveReadinessErrors();
    if (errors.length) return { ok: false, errors };
  }
  setSetting('trading_mode', mode);
  return { ok: true, mode };
}

export function trySetPositionSizeSol(sol) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0.01 || n > 10) {
    return { ok: false, error: 'Size must be between 0.01 and 10 SOL' };
  }
  const strat = activeStrategy();
  const config = { ...strat };
  delete config.id;
  delete config.name;
  config.position_size_sol = n;
  updateStrategyConfig(strat.id, config);
  return { ok: true, sol: n, strategyId: strat.id, strategyName: strat.name };
}

export async function buildTradingStatusText() {
  const strat = activeStrategy();
  const mode = tradingMode();
  const agentOn = isAgentEnabled();
  const errors = mode === 'live' ? getLiveReadinessErrors() : [];
  const pubkey = liveWalletPubkey();
  let balanceLine = null;
  if (mode === 'live' && isLiveReady()) {
    try {
      const lamports = await liveWalletBalanceLamports();
      balanceLine = `Wallet balance: <b>${fmtSol(lamports / 1_000_000_000)} SOL</b>`;
    } catch (err) {
      balanceLine = `Wallet balance: <i>${escapeHtml(err.message)}</i>`;
    }
  }

  return [
    '📟 <b>Charon status</b>',
    '',
    `Entries: <b>${agentOn ? 'RUNNING' : 'PAUSED'}</b> <i>(/start /stop /pause)</i>`,
    `Mode: <b>${escapeHtml(mode)}</b>`,
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Position size (base): <b>${fmtSol(strat.position_size_sol)} SOL</b> <i>(/size)</i>`,
    `Open positions: <b>${openPositionCount()}${(strat.max_open_positions ?? 0) > 0 ? `/${strat.max_open_positions}` : ' (unlimited)'}</b>`,
    mode === 'live' ? `Live wallet: <code>${escapeHtml(pubkey || 'not loaded')}</code>` : null,
    balanceLine,
    errors.length ? `\n⚠️ <b>Live not ready</b>\n${errors.map(e => `• ${escapeHtml(e)}`).join('\n')}` : null,
    mode === 'live' && !errors.length ? '\n✅ Live execution ready' : null,
    '',
    '<i>Pause/stop = no new entries. Live apes each pass while SOL lasts (gas reserve %).</i>',
  ].filter(Boolean).join('\n');
}
