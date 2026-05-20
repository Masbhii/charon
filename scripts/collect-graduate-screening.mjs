/**
 * Data-only collector for graduate_immediate screening research.
 *
 * It polls graduated tokens, writes JSONL observations, and optionally runs a
 * full Jupiter confirmation for quick PASS candidates. It does not start the
 * bot, create positions, or execute trades.
 *
 * Usage:
 *   node scripts/collect-graduate-screening.mjs --interval 5000
 *   node scripts/collect-graduate-screening.mjs --interval 5000 --confirm-pass
 *   node scripts/collect-graduate-screening.mjs --once --confirm-pass
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function argNumber(name, fallback) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) ? value : fallback;
}

const intervalMs = Math.max(1_000, argNumber('--interval', 5_000));
const logDir = argValue('--log-dir', 'data/graduate-screening');
const confirmPass = args.includes('--confirm-pass') || args.includes('--confirm-full-pass');
const fullRefreshMs = Math.max(30_000, argNumber('--full-refresh-ms', 10 * 60_000));
const once = args.includes('--once');
const maxTicks = Math.max(0, argNumber('--max-ticks', 0));
const quiet = args.includes('--quiet');

process.env.GMGN_ENABLED = 'false';
process.env.TWITTER_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
const { strategyById, setActiveStrategy, activeStrategy } = await import('../src/db/settings.js');
const { fetchGraduatedCoins, graduated } = await import('../src/signals/graduated.js');
const { buildCandidate, duplicateTickerOgFailure } = await import('../src/pipeline/candidateBuilder.js');
const { now } = await import('../src/utils.js');

function quickPrefilter(coin, strat, graduatedMap) {
  const failures = [];
  const gradDate = Number(coin.graduationDate || 0);
  const ageMs = gradDate > 0 ? now() - gradDate : null;
  const mcap = Number(coin.marketCap ?? coin.usd_market_cap ?? 0) || null;

  if (gradDate <= 0) failures.push('no graduationDate');
  if (ageMs != null && strat.min_graduated_age_ms > 0 && ageMs < strat.min_graduated_age_ms) {
    failures.push(`too young: ${ageMs}ms < ${strat.min_graduated_age_ms}ms`);
  }
  if (ageMs != null && strat.max_graduated_age_ms > 0 && ageMs > strat.max_graduated_age_ms) {
    failures.push(`too old: ${ageMs}ms > ${strat.max_graduated_age_ms}ms`);
  }
  if (strat.min_mcap_usd > 0 && (!mcap || mcap < strat.min_mcap_usd)) {
    failures.push(`mcap < min: ${mcap ?? 'null'} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && mcap && mcap > strat.max_mcap_usd) {
    failures.push(`mcap > max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  const dupMsg = duplicateTickerOgFailure(coin.coinMint, coin, strat.duplicate_ticker_og_window_ms, graduatedMap);
  if (dupMsg) failures.push(dupMsg);

  return {
    passed: failures.length === 0,
    failures,
    ageMs,
    marketCapUsd: mcap,
    graduationDateMs: gradDate || null,
  };
}

function pickStrategy(strat) {
  return {
    id: strat.id,
    min_graduated_age_ms: strat.min_graduated_age_ms,
    max_graduated_age_ms: strat.max_graduated_age_ms,
    min_mcap_usd: strat.min_mcap_usd,
    max_mcap_usd: strat.max_mcap_usd,
    min_liquidity_usd: strat.min_liquidity_usd,
    min_volume_1h_usd: strat.min_volume_1h_usd,
    max_volume_1h_usd: strat.max_volume_1h_usd,
    max_bundle_single_holder_percent: strat.max_bundle_single_holder_percent,
    max_bundle_top4_combined_percent: strat.max_bundle_top4_combined_percent,
    duplicate_ticker_og_window_ms: strat.duplicate_ticker_og_window_ms,
    partial_tp: strat.partial_tp,
    partial_tp_at_percent: strat.partial_tp_at_percent,
    partial_tp_sell_percent: strat.partial_tp_sell_percent,
    tp_percent: strat.tp_percent,
    sl_percent: strat.sl_percent,
    trailing_enabled: strat.trailing_enabled,
    trailing_percent: strat.trailing_percent,
    max_hold_ms: strat.max_hold_ms,
  };
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function candidateMetrics(candidate) {
  return {
    token: candidate.token,
    metrics: {
      price_usd: candidate.metrics?.priceUsd ?? null,
      market_cap_usd: candidate.metrics?.marketCapUsd ?? null,
      liquidity_usd: candidate.metrics?.liquidityUsd ?? null,
      holder_count: candidate.metrics?.holderCount ?? null,
      gmgn_total_fees_sol: candidate.metrics?.gmgnTotalFeesSol ?? null,
      volume_1h_usd: candidate.metrics?.volume1hUsd ?? null,
      graduated_volume_usd: candidate.metrics?.graduatedVolumeUsd ?? null,
    },
    holders: {
      count: candidate.holders?.count ?? null,
      max_holder_percent: candidate.holders?.maxHolderPercent ?? null,
      top4_holder_combined_percent: candidate.holders?.top4HolderCombinedPercent ?? null,
      top20_percent: candidate.holders?.top20Percent ?? null,
    },
    filters: candidate.filters,
  };
}

initDb();

const strat = strategyById('graduate_immediate');
if (!strat) {
  console.error('graduate_immediate strategy not found. Run initDb/bot once first.');
  process.exit(1);
}

const prevId = activeStrategy()?.id ?? 'sniper';
if (confirmPass) setActiveStrategy('graduate_immediate');

fs.mkdirSync(logDir, { recursive: true });
const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
const observationsFile = path.join(logDir, `observations-${sessionId}.jsonl`);
const eventsFile = path.join(logDir, `events-${sessionId}.jsonl`);
const fullChecksFile = path.join(logDir, `full-checks-${sessionId}.jsonl`);
const sessionFile = path.join(logDir, `session-${sessionId}.json`);

const session = {
  session_id: sessionId,
  started_at_iso: new Date().toISOString(),
  interval_ms: intervalMs,
  confirm_pass: confirmPass,
  full_refresh_ms: fullRefreshMs,
  log_dir: logDir,
  files: {
    observations: observationsFile,
    events: eventsFile,
    full_checks: confirmPass ? fullChecksFile : null,
  },
  strategy: pickStrategy(strat),
  env: {
    gmgn_enabled: process.env.GMGN_ENABLED,
    twitter_enabled: process.env.TWITTER_ENABLED,
  },
};

fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);

const seenMints = new Set();
const firstPassMints = new Set();
const lastQuickPass = new Map();
const lastFullCheckAt = new Map();
let tick = 0;

console.log('[collect] graduate_immediate screening collector');
console.log(`[collect] interval=${intervalMs}ms confirm_pass=${confirmPass} log_dir=${logDir}`);
console.log(`[collect] observations=${observationsFile}`);
if (confirmPass) console.log(`[collect] full_checks=${fullChecksFile}`);
console.log('[collect] Ctrl+C to stop');

async function maybeFullCheck({ mint, coin, observedAtMs, observedAtIso }) {
  if (!confirmPass) return;
  const lastAt = lastFullCheckAt.get(mint) || 0;
  if (observedAtMs - lastAt < fullRefreshMs) return;
  lastFullCheckAt.set(mint, observedAtMs);

  const buildStart = Date.now();
  try {
    const candidate = await buildCandidate({
      mint,
      graduatedCoin: coin,
      route: 'graduate_screening_collect',
    });
    appendJsonl(fullChecksFile, {
      type: 'full_check',
      session_id: sessionId,
      tick,
      observed_at_ms: observedAtMs,
      observed_at_iso: observedAtIso,
      mint,
      build_ms: Date.now() - buildStart,
      ...candidateMetrics(candidate),
    });
  } catch (err) {
    appendJsonl(fullChecksFile, {
      type: 'full_check_error',
      session_id: sessionId,
      tick,
      observed_at_ms: observedAtMs,
      observed_at_iso: observedAtIso,
      mint,
      build_ms: Date.now() - buildStart,
      error: err.message,
    });
  }
}

async function scanOnce() {
  tick += 1;
  const observedAtMs = now();
  const observedAtIso = new Date(observedAtMs).toISOString();

  graduated.clear();
  await fetchGraduatedCoins();

  const coins = [...graduated.values()]
    .filter(coin => coin?.coinMint)
    .sort((a, b) => Number(b.graduationDate || 0) - Number(a.graduationDate || 0));

  let quickPassCount = 0;
  let newPassCount = 0;

  for (const coin of coins) {
    const mint = coin.coinMint;
    const q = quickPrefilter(coin, strat, graduated);
    if (q.passed) quickPassCount += 1;

    const observation = {
      type: 'quick_observation',
      session_id: sessionId,
      tick,
      observed_at_ms: observedAtMs,
      observed_at_iso: observedAtIso,
      mint,
      symbol: coin.ticker || coin.symbol || null,
      name: coin.name || null,
      graduation_date_ms: q.graduationDateMs,
      age_ms: q.ageMs,
      market_cap_usd_pump: q.marketCapUsd,
      passed_quick: q.passed,
      quick_failures: q.failures,
      source: coin.source || 'graduated_api',
    };
    appendJsonl(observationsFile, observation);

    if (!seenMints.has(mint)) {
      seenMints.add(mint);
      appendJsonl(eventsFile, { ...observation, type: 'first_seen' });
    }

    const prevPass = lastQuickPass.get(mint);
    if (prevPass !== q.passed) {
      lastQuickPass.set(mint, q.passed);
      appendJsonl(eventsFile, {
        ...observation,
        type: 'quick_pass_state_change',
        previous_passed_quick: prevPass ?? null,
      });
    }

    if (q.passed && !firstPassMints.has(mint)) {
      firstPassMints.add(mint);
      newPassCount += 1;
      appendJsonl(eventsFile, {
        ...observation,
        type: 'quick_pass_first',
        entry_proxy_market_cap_usd: q.marketCapUsd,
        entry_proxy_age_ms: q.ageMs,
      });
    }

    if (q.passed) {
      await maybeFullCheck({ mint, coin, observedAtMs, observedAtIso });
    }
  }

  const summary = {
    type: 'tick_summary',
    session_id: sessionId,
    tick,
    observed_at_ms: observedAtMs,
    observed_at_iso: observedAtIso,
    tracked: coins.length,
    quick_pass: quickPassCount,
    quick_fail: coins.length - quickPassCount,
    new_quick_pass: newPassCount,
    unique_seen: seenMints.size,
    unique_quick_pass: firstPassMints.size,
  };
  appendJsonl(eventsFile, summary);

  if (!quiet) {
    console.log(`[collect] tick=${tick} tracked=${coins.length} quick_pass=${quickPassCount} new_pass=${newPassCount} unique_pass=${firstPassMints.size}`);
  }
}

let timer = null;
let stopped = false;

function stop(code = 0) {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  if (confirmPass) setActiveStrategy(prevId);
  console.log(`[collect] stopped. session=${sessionId}`);
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  await scanOnce();
  if (once || maxTicks === 1) stop(0);

  const scheduleNext = () => {
    if (stopped) return;
    if (maxTicks > 0 && tick >= maxTicks) stop(0);
    timer = setTimeout(async () => {
      try {
        await scanOnce();
      } catch (err) {
        appendJsonl(eventsFile, {
          type: 'collector_error',
          session_id: sessionId,
          tick,
          observed_at_ms: now(),
          observed_at_iso: new Date().toISOString(),
          error: err.message,
        });
        console.error(`[collect] error: ${err.message}`);
      }
      scheduleNext();
    }, intervalMs);
  };

  scheduleNext();
} catch (err) {
  console.error(`[collect] fatal: ${err.message}`);
  stop(1);
}
