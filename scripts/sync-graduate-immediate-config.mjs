/**
 * Sync local SQLite strategy config for graduate_immediate screening tests.
 *
 * This updates only the strategies.config_json row in the local DB. It does not
 * start the bot, open positions, or touch execution logic.
 *
 * Usage:
 *   node scripts/sync-graduate-immediate-config.mjs
 *   node scripts/sync-graduate-immediate-config.mjs --max-age-ms 3600000
 *   node scripts/sync-graduate-immediate-config.mjs --print-only
 */
import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);

function argNumber(name, fallback) {
  const idx = args.indexOf(name);
  if (idx < 0) return fallback;
  const value = Number(args[idx + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const printOnly = args.includes('--print-only');

const { initDb } = await import('../src/db/connection.js');
const { strategyById, updateStrategyConfig } = await import('../src/db/settings.js');

initDb();

const current = strategyById('graduate_immediate');
if (!current) {
  console.error('graduate_immediate strategy not found. Run initDb/bot once first.');
  process.exit(1);
}

const next = {
  ...current,
  min_graduated_age_ms: argNumber('--min-age-ms', 20_000),
  max_graduated_age_ms: argNumber('--max-age-ms', 600_000),
  min_mcap_usd: argNumber('--min-mcap', 35_000),
  max_mcap_usd: argNumber('--max-mcap', 80_000),
  min_liquidity_usd: argNumber('--min-liquidity', 5_000),
  min_volume_1h_usd: argNumber('--min-volume-1h', 0),
  max_volume_1h_usd: argNumber('--max-volume-1h', 0),
  max_bundle_single_holder_percent: argNumber('--max-bundle-single', 80),
  max_bundle_top4_combined_percent: argNumber('--max-bundle-top4', 95),
  duplicate_ticker_og_window_ms: argNumber('--duplicate-window-ms', 7_200_000),
  min_holder_quality_score: argNumber('--min-hqs', 40),
  partial_tp_sell_percent: argNumber('--partial-tp-sell', 80),
};

delete next.id;
delete next.name;

if (!printOnly) {
  updateStrategyConfig('graduate_immediate', next);
}

const synced = strategyById('graduate_immediate');
const out = {
  updated: !printOnly,
  strategy: 'graduate_immediate',
  key_values: {
    min_graduated_age_ms: synced.min_graduated_age_ms,
    max_graduated_age_ms: synced.max_graduated_age_ms,
    min_mcap_usd: synced.min_mcap_usd,
    max_mcap_usd: synced.max_mcap_usd,
    min_liquidity_usd: synced.min_liquidity_usd,
    min_volume_1h_usd: synced.min_volume_1h_usd,
    max_volume_1h_usd: synced.max_volume_1h_usd,
    max_bundle_single_holder_percent: synced.max_bundle_single_holder_percent,
    max_bundle_top4_combined_percent: synced.max_bundle_top4_combined_percent,
    duplicate_ticker_og_window_ms: synced.duplicate_ticker_og_window_ms,
    min_holder_quality_score: synced.min_holder_quality_score,
    partial_tp_sell_percent: synced.partial_tp_sell_percent,
  },
};

console.log(JSON.stringify(out, null, 2));
