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
 *   node scripts/collect-graduate-screening.mjs --interval 5000 --confirm-pass --telegram
 *   node scripts/collect-graduate-screening.mjs --once --confirm-pass
 */
import dotenv from 'dotenv';
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import TelegramBot from 'node-telegram-bot-api';

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
const telegramRequested = args.includes('--telegram') || args.includes('--telegram-pass') || args.includes('--send-telegram');
const finalFilesEnabled = !args.includes('--no-final-send');
const durationHours = argNumber('--duration-hours', 72);
const durationMs = Math.max(0, argNumber('--duration-ms', durationHours * 60 * 60_000));
const telegramMaxFileBytes = Math.max(1_000_000, argNumber('--telegram-max-file-mb', 45) * 1024 * 1024);

process.env.GMGN_ENABLED = 'false';
process.env.TWITTER_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
const { strategyById, setActiveStrategy, activeStrategy } = await import('../src/db/settings.js');
const { fetchGraduatedCoins, graduated } = await import('../src/signals/graduated.js');
const { buildCandidate, duplicateTickerOgFailure } = await import('../src/pipeline/candidateBuilder.js');
const { now } = await import('../src/utils.js');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtAge(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return 'n/a';
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  const value = Number(n);
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

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
const summaryFile = path.join(logDir, `summary-${sessionId}.json`);

const session = {
  session_id: sessionId,
  started_at_iso: new Date().toISOString(),
  interval_ms: intervalMs,
  duration_ms: durationMs,
  planned_stop_at_iso: durationMs > 0 ? new Date(now() + durationMs).toISOString() : null,
  confirm_pass: confirmPass,
  full_refresh_ms: fullRefreshMs,
  log_dir: logDir,
  files: {
    observations: observationsFile,
    events: eventsFile,
    full_checks: confirmPass ? fullChecksFile : null,
    summary: summaryFile,
  },
  strategy: pickStrategy(strat),
  env: {
    gmgn_enabled: process.env.GMGN_ENABLED,
    twitter_enabled: process.env.TWITTER_ENABLED,
    telegram_enabled: telegramRequested,
  },
};

fs.writeFileSync(sessionFile, `${JSON.stringify(session, null, 2)}\n`);

const telegram = {
  enabled: false,
  bot: null,
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  topicId: process.env.TELEGRAM_TOPIC_ID || '',
};

if (telegramRequested) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !telegram.chatId) {
    console.log('[telegram] disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing');
  } else {
    telegram.enabled = true;
    telegram.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
}

function telegramExtra(extra = {}) {
  const topicId = Number(telegram.topicId);
  return {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(Number.isFinite(topicId) && topicId > 0 ? { message_thread_id: topicId } : {}),
    ...extra,
  };
}

async function sendTelegramMessage(text, extra = {}) {
  if (!telegram.enabled) return null;
  try {
    return await telegram.bot.sendMessage(telegram.chatId, text, telegramExtra(extra));
  } catch (err) {
    console.log(`[telegram] message failed: ${err.message}`);
    return null;
  }
}

async function sendTelegramDocument(file, caption = '') {
  if (!telegram.enabled) return null;
  try {
    return await telegram.bot.sendDocument(
      telegram.chatId,
      file,
      telegramExtra({ caption: caption.slice(0, 1024) }),
    );
  } catch (err) {
    console.log(`[telegram] document failed (${path.basename(file)}): ${err.message}`);
    return null;
  }
}

function passAlertText(observation) {
  return [
    '<b>Graduate Immediate PASS</b>',
    '',
    `Symbol: <b>${escapeHtml(observation.symbol || '?')}</b>`,
    `CA: <code>${escapeHtml(observation.mint)}</code>`,
    `Age: <b>${escapeHtml(fmtAge(observation.age_ms))}</b> since graduate`,
    `Mcap: <b>${escapeHtml(fmtUsd(observation.market_cap_usd_pump))}</b> Pump`,
    `Session: <code>${escapeHtml(sessionId.slice(0, 19))}</code>`,
    '',
    '<i>Screening-only collector. No buy/sell executed.</i>',
  ].join('\n');
}

const seenMints = new Set();
const firstPassMints = new Set();
const lastQuickPass = new Map();
const lastFullCheckAt = new Map();
let tick = 0;
let totalObservations = 0;
let totalFullChecks = 0;
let totalFullCheckErrors = 0;
const startedAtMs = now();

console.log('[collect] graduate_immediate screening collector');
console.log(`[collect] interval=${intervalMs}ms duration=${durationMs > 0 ? `${durationMs}ms` : 'off'} confirm_pass=${confirmPass} telegram=${telegram.enabled} log_dir=${logDir}`);
console.log(`[collect] observations=${observationsFile}`);
if (confirmPass) console.log(`[collect] full_checks=${fullChecksFile}`);
console.log('[collect] Ctrl+C to stop');

await sendTelegramMessage([
  '<b>Graduate screening collector started</b>',
  '',
  `Session: <code>${escapeHtml(sessionId)}</code>`,
  `Interval: <b>${intervalMs}ms</b>`,
  `Duration: <b>${durationMs > 0 ? `${(durationMs / 3_600_000).toFixed(1)}h` : 'off'}</b>`,
  `Confirm pass: <b>${confirmPass ? 'yes' : 'no'}</b>`,
  '',
  `Filters: age ${strat.min_graduated_age_ms / 1000}s-${strat.max_graduated_age_ms / 1000}s, mcap ${fmtUsd(strat.min_mcap_usd)}-${fmtUsd(strat.max_mcap_usd)}`,
  '<i>Data-only mode. No trade execution.</i>',
].join('\n'));

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
    totalFullChecks += 1;
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
    totalFullCheckErrors += 1;
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
    totalObservations += 1;

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
      await sendTelegramMessage(passAlertText(observation));
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
let finalSent = false;

async function gzipFile(src) {
  const dest = `${src}.gz`;
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest),
  );
  return dest;
}

function writeSummary(stopReason) {
  const finishedAtMs = now();
  const summary = {
    session_id: sessionId,
    started_at_ms: startedAtMs,
    started_at_iso: new Date(startedAtMs).toISOString(),
    finished_at_ms: finishedAtMs,
    finished_at_iso: new Date(finishedAtMs).toISOString(),
    stop_reason: stopReason,
    runtime_ms: finishedAtMs - startedAtMs,
    tick_count: tick,
    total_observations: totalObservations,
    unique_seen: seenMints.size,
    unique_quick_pass: firstPassMints.size,
    total_full_checks: totalFullChecks,
    total_full_check_errors: totalFullCheckErrors,
    files: session.files,
    strategy: session.strategy,
  };
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function sendFinalArtifacts(stopReason) {
  if (finalSent) return;
  finalSent = true;
  const summary = writeSummary(stopReason);
  if (!telegram.enabled || !finalFilesEnabled) return;
  await sendTelegramMessage([
    '<b>Graduate screening collector finished</b>',
    '',
    `Session: <code>${escapeHtml(sessionId)}</code>`,
    `Reason: <b>${escapeHtml(stopReason)}</b>`,
    `Runtime: <b>${escapeHtml(fmtAge(summary.runtime_ms))}</b>`,
    `Ticks: <b>${summary.tick_count}</b>`,
    `Observations: <b>${summary.total_observations}</b>`,
    `Unique seen: <b>${summary.unique_seen}</b>`,
    `Unique quick PASS: <b>${summary.unique_quick_pass}</b>`,
    `Full checks: <b>${summary.total_full_checks}</b>`,
    '',
    'Sending JSON/JSONL artifacts now.',
  ].join('\n'));

  const files = [
    { file: sessionFile, caption: 'graduate_immediate session config JSON' },
    { file: summaryFile, caption: 'graduate_immediate screening summary JSON' },
    { file: eventsFile, caption: 'graduate_immediate events JSONL (gzip)' },
    { file: observationsFile, caption: 'graduate_immediate observations JSONL (gzip)' },
    ...(confirmPass ? [{ file: fullChecksFile, caption: 'graduate_immediate full Jupiter checks JSONL (gzip)' }] : []),
  ];

  for (const item of files) {
    if (!fs.existsSync(item.file)) continue;
    const source = item.file.endsWith('.jsonl') ? await gzipFile(item.file) : item.file;
    const size = fs.statSync(source).size;
    if (size > telegramMaxFileBytes) {
      await sendTelegramMessage([
        '<b>Artifact too large for Telegram</b>',
        '',
        `File: <code>${escapeHtml(path.basename(source))}</code>`,
        `Size: <b>${(size / 1024 / 1024).toFixed(1)} MB</b>`,
        `Path on VPS: <code>${escapeHtml(path.resolve(source))}</code>`,
      ].join('\n'));
      continue;
    }
    await sendTelegramDocument(source, item.caption);
  }
}

async function stop(code = 0, reason = 'stopped') {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  try {
    await sendFinalArtifacts(reason);
  } finally {
    if (confirmPass) setActiveStrategy(prevId);
    console.log(`[collect] stopped. session=${sessionId}`);
    process.exit(code);
  }
}

process.on('SIGINT', () => {
  stop(0, 'SIGINT').catch(err => {
    console.error(`[collect] stop failed: ${err.message}`);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  stop(0, 'SIGTERM').catch(err => {
    console.error(`[collect] stop failed: ${err.message}`);
    process.exit(1);
  });
});

try {
  await scanOnce();
  if (once || maxTicks === 1) await stop(0, once ? 'once' : 'max_ticks');

  const scheduleNext = () => {
    if (stopped) return;
    if (maxTicks > 0 && tick >= maxTicks) {
      stop(0, 'max_ticks').catch(err => console.error(`[collect] stop failed: ${err.message}`));
      return;
    }
    if (durationMs > 0 && now() - startedAtMs >= durationMs) {
      stop(0, 'duration_elapsed').catch(err => console.error(`[collect] stop failed: ${err.message}`));
      return;
    }
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
  await stop(1, 'fatal_error');
}
