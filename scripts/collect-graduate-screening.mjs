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
 * Telegram: alert on first quick PASS per mint; optional follow-up when full Jupiter passes.
 *   node scripts/collect-graduate-screening.mjs --interval 5000 --telegram --verbose
 *   node scripts/collect-graduate-screening.mjs --once --confirm-pass
 *
 * Tetap jalan setelah tutup terminal/SSH (jangan jalankan foreground langsung):
 *   node scripts/graduate-screening-daemon.mjs start -- --interval 5000 --verbose --confirm-pass --telegram
 *   node scripts/graduate-screening-daemon.mjs status
 *   node scripts/graduate-screening-daemon.mjs stop
 *   tail -f data/graduate-screening/collector.log
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
const verbose = args.includes('--verbose') || args.includes('--watch-style');
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
const { buildCandidate, duplicateTickerOgFailure, computeHolderQualityScore } = await import('../src/pipeline/candidateBuilder.js');
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

function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function quickPrefilter(coin, strat, graduatedMap) {
  const failures = [];
  const gradDate = Number(coin.graduationDate || 0);
  const ageMs = gradDate > 0 ? now() - gradDate : null;
  const mcap = Number(coin.marketCap ?? coin.usd_market_cap ?? 0) || null;

  if (gradDate <= 0) failures.push('no graduationDate');
  if (ageMs != null && strat.min_graduated_age_ms > 0 && ageMs < strat.min_graduated_age_ms) {
    failures.push(`too young (${fmtAge(ageMs)} < ${strat.min_graduated_age_ms / 1000}s)`);
  }
  if (ageMs != null && strat.max_graduated_age_ms > 0 && ageMs > strat.max_graduated_age_ms) {
    failures.push(`too old (${fmtAge(ageMs)} > ${strat.max_graduated_age_ms / 1000}s)`);
  }
  if (strat.min_mcap_usd > 0 && (!mcap || mcap < strat.min_mcap_usd)) {
    failures.push(`mcap ${fmtUsd(mcap)} < ${fmtUsd(strat.min_mcap_usd)}`);
  }
  if (strat.max_mcap_usd > 0 && mcap && mcap > strat.max_mcap_usd) {
    failures.push(`mcap ${fmtUsd(mcap)} > ${fmtUsd(strat.max_mcap_usd)}`);
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
    min_holder_quality_score: strat.min_holder_quality_score,
    min_rugcheck_score: strat.min_rugcheck_score,
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

function safeAppendJsonl(file, row) {
  try {
    appendJsonl(file, row);
  } catch (err) {
    console.log(`[collect] append failed (${path.basename(file)}): ${err.message}`);
  }
}

function candidateMetrics(candidate) {
  const hqs = candidate.holders && strat.min_holder_quality_score > 0
    ? computeHolderQualityScore(candidate)
    : null;
  return {
    token: candidate.token,
    holder_quality: hqs ? { score: hqs.score, flags: hqs.flags } : null,
    rugcheck: candidate.rugcheck ?? null,
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
    telegram.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false, request: { timeout: 30_000 } });
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
  const payload = text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
  try {
    return await withTimeout(
      telegram.bot.sendMessage(telegram.chatId, payload, telegramExtra(extra)),
      30_000,
      'telegram.sendMessage',
    );
  } catch (err) {
    console.log(`[telegram] message failed: ${err.message}`);
    if (/parse entities|can't parse/i.test(err.message)) {
      try {
        return await withTimeout(
          telegram.bot.sendMessage(telegram.chatId, payload.replace(/<[^>]+>/g, ''), {
            disable_web_page_preview: true,
            ...(Number(telegram.topicId) > 0 ? { message_thread_id: Number(telegram.topicId) } : {}),
            ...extra,
          }),
          30_000,
          'telegram.sendMessage(plain)',
        );
      } catch (retryErr) {
        console.log(`[telegram] plain retry failed: ${retryErr.message}`);
      }
    }
    return null;
  }
}

async function sendTelegramDocument(file, caption = '') {
  if (!telegram.enabled) return null;
  try {
    return await withTimeout(
      telegram.bot.sendDocument(
        telegram.chatId,
        file,
        telegramExtra({ caption: caption.slice(0, 1024) }),
      ),
      60_000,
      'telegram.sendDocument',
    );
  } catch (err) {
    console.log(`[telegram] document failed (${path.basename(file)}): ${err.message}`);
    return null;
  }
}

function passAlertText(observation, fullFilter = null) {
  const lines = [
    '<b>Graduate Immediate PASS</b>',
    '',
    `Symbol: <b>${escapeHtml(observation.symbol || '?')}</b>`,
    `CA: <code>${escapeHtml(observation.mint)}</code>`,
    `Age: <b>${escapeHtml(fmtAge(observation.age_ms))}</b> since graduate`,
    `Mcap: <b>${escapeHtml(fmtUsd(observation.market_cap_usd_pump))}</b> Pump`,
  ];
  if (fullFilter?.passed) {
    if (fullFilter.hqs?.score != null) lines.push(`HQS: <b>${fullFilter.hqs.score}/100</b>`);
    if (fullFilter.rugcheck?.displayScore != null) {
      lines.push(`RugCheck: <b>${fullFilter.rugcheck.displayScore}/100</b>`);
    }
    lines.push('', '<i>Quick + Jupiter full check passed.</i>');
  } else if (confirmPass && fullFilter && !fullFilter.passed) {
    const fail = (fullFilter.failures || []).slice(0, 4).join('; ') || 'full check failed';
    lines.push('', `<i>Quick PASS — full check FAIL: ${escapeHtml(fail)}</i>`);
  } else {
    lines.push('', '<i>Quick PASS (Pump API). Full Jupiter check pending or skipped.</i>');
  }
  lines.push(`Session: <code>${escapeHtml(sessionId.slice(0, 19))}</code>`);
  lines.push('', '<i>Screening-only collector. No buy/sell executed.</i>');
  return lines.join('\n');
}

const seenMints = new Set();
const firstPassAlertMints = new Set();
const firstFullPassAlertMints = new Set();
const lastQuickPass = new Map();
const lastFullCheckAt = new Map();
const lastFullCheckResult = new Map();
let tick = 0;
let totalObservations = 0;
let totalFullChecks = 0;
let totalFullCheckErrors = 0;
const startedAtMs = now();
let scanInProgress = false;

console.log('[collect] graduate_immediate screening collector (data-only, no trades)');
console.log(`[collect] interval=${intervalMs}ms duration=${durationMs > 0 ? `${durationMs}ms` : 'off'} confirm_pass=${confirmPass} telegram=${telegram.enabled} verbose=${verbose} log_dir=${logDir}`);
console.log(`[collect] observations=${observationsFile}`);
if (confirmPass) console.log(`[collect] full_checks=${fullChecksFile}`);
if (verbose) {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SCREENING graduate_immediate — logs + optional Telegram    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Poll setiap ${intervalMs / 1000}s | umur ${strat.min_graduated_age_ms / 1000}s–${strat.max_graduated_age_ms / 1000}s | mcap ${fmtUsd(strat.min_mcap_usd)}–${fmtUsd(strat.max_mcap_usd)}`);
  console.log(`Telegram PASS alerts: ${telegram.enabled ? 'YA' : 'tidak (--telegram)'}`);
  console.log('Ctrl+C untuk berhenti\n');
}
console.log('[collect] Ctrl+C to stop');

await sendTelegramMessage([
  '<b>Graduate screening collector started</b>',
  '',
  `Session: <code>${escapeHtml(sessionId)}</code>`,
  `Interval: <b>${intervalMs}ms</b>`,
  `Duration: <b>${durationMs > 0 ? `${(durationMs / 3_600_000).toFixed(1)}h` : 'off'}</b>`,
  `Confirm pass: <b>${confirmPass ? 'yes' : 'no'}</b>`,
  '',
  `Filters: age ${strat.min_graduated_age_ms / 1000}s-${strat.max_graduated_age_ms / 1000}s, mcap ${fmtUsd(strat.min_mcap_usd)}-${fmtUsd(strat.max_mcap_usd)}, HQS≥${strat.min_holder_quality_score || 0}, RugCheck≥${strat.min_rugcheck_score || 0}, partial TP ${strat.partial_tp_sell_percent}%`,
  '<i>Data-only mode. No trade execution.</i>',
].join('\n'));

async function maybeFullCheck({ mint, coin, observedAtMs, observedAtIso }) {
  if (!confirmPass) return null;
  const lastAt = lastFullCheckAt.get(mint) || 0;
  if (observedAtMs - lastAt < fullRefreshMs) {
    const cached = lastFullCheckResult.get(mint);
    if (cached) return { ...cached, throttled: true };
    return { passed: false, failures: ['full check pending (refresh soon)'], hqs: null, rugcheck: null, throttled: true };
  }
  lastFullCheckAt.set(mint, observedAtMs);

  const buildStart = Date.now();
  try {
    const candidate = await withTimeout(
      buildCandidate({
        mint,
        graduatedCoin: coin,
        route: 'graduate_screening_collect',
      }),
      60_000,
      `buildCandidate(${mint.slice(0, 8)})`,
    );
    const full = {
      passed: candidate.filters?.passed ?? false,
      failures: candidate.filters?.failures ?? [],
      hqs: candidate.holders && strat.min_holder_quality_score > 0
        ? computeHolderQualityScore(candidate)
        : null,
      rugcheck: candidate.rugcheck ?? null,
    };
    safeAppendJsonl(fullChecksFile, {
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
    lastFullCheckResult.set(mint, full);
    return full;
  } catch (err) {
    safeAppendJsonl(fullChecksFile, {
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
    const failed = { passed: false, failures: [err.message], hqs: null, rugcheck: null };
    lastFullCheckResult.set(mint, failed);
    return failed;
  }
}

async function sendPassTelegram(observation, fullFilter, kind) {
  if (!telegram.enabled) return false;
  const text = passAlertText(observation, fullFilter);
  const sent = await sendTelegramMessage(text);
  if (sent) {
    console.log(`[telegram] ${kind} alert sent: ${observation.symbol || '?'} ${observation.mint.slice(0, 8)}...`);
    return true;
  }
  return false;
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
  const analyzed = [];

  for (const coin of coins) {
    const mint = coin.coinMint;
    const q = quickPrefilter(coin, strat, graduated);
    if (q.passed) quickPassCount += 1;

    let fullFilter = null;
    if (q.passed && confirmPass) {
      fullFilter = await maybeFullCheck({ mint, coin, observedAtMs, observedAtIso });
    }

    if (verbose) {
      const reasons = [...q.failures];
      if (q.passed && fullFilter && !fullFilter.passed) {
        reasons.push(...(fullFilter.failures || []));
      } else if (q.passed && confirmPass && fullFilter?.throttled) {
        reasons.push('full check cached (throttled)');
      } else if (q.passed && confirmPass && !fullFilter) {
        reasons.push('full check pending');
      }
      const fullOk = fullFilter?.passed === true;
      const displayPass = q.passed && (!confirmPass || fullOk);
      const quickOnlyPass = q.passed && confirmPass && !fullOk;
      const row = {
        symbol: coin.ticker || coin.symbol || '?',
        mint,
        pass: displayPass,
        quickOnlyPass,
        age: fmtAge(q.ageMs),
        mcapPump: fmtUsd(q.marketCapUsd),
        reasons,
      };
      if (fullFilter?.hqs) row.hqs = `${fullFilter.hqs.score}/100`;
      if (fullFilter?.rugcheck?.displayScore != null) {
        row.rugcheck = `${fullFilter.rugcheck.displayScore}/100`;
      }
      analyzed.push(row);
    }

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
    safeAppendJsonl(observationsFile, observation);
    totalObservations += 1;

    if (!seenMints.has(mint)) {
      seenMints.add(mint);
      safeAppendJsonl(eventsFile, { ...observation, type: 'first_seen' });
    }

    const prevPass = lastQuickPass.get(mint);
    if (prevPass !== q.passed) {
      lastQuickPass.set(mint, q.passed);
      safeAppendJsonl(eventsFile, {
        ...observation,
        type: 'quick_pass_state_change',
        previous_passed_quick: prevPass ?? null,
      });
    }

    if (q.passed && !firstPassAlertMints.has(mint)) {
      firstPassAlertMints.add(mint);
      newPassCount += 1;
      safeAppendJsonl(eventsFile, {
        ...observation,
        type: 'quick_pass_first',
        entry_proxy_market_cap_usd: q.marketCapUsd,
        entry_proxy_age_ms: q.ageMs,
        full_passed: fullFilter?.passed ?? null,
      });
      await sendPassTelegram(observation, fullFilter, 'quick PASS');
      if (verbose) {
        console.log('\n🟢 ═══ QUICK PASS (BARU) → Telegram terkirim ═══');
        console.log(`   Symbol : ${observation.symbol || '?'}`);
        console.log(`   CA     : ${mint}`);
        console.log(`   Umur   : ${fmtAge(observation.age_ms)} sejak graduate`);
        console.log(`   Mcap   : Pump ${fmtUsd(observation.market_cap_usd_pump)}`);
        if (fullFilter?.passed) console.log('   Full   : Jupiter check PASS');
        else if (fullFilter && !fullFilter.passed) {
          console.log(`   Full   : FAIL — ${(fullFilter.failures || []).join('; ')}`);
        }
        console.log('══════════════════════════════\n');
      }
    } else if (
      confirmPass
      && q.passed
      && fullFilter?.passed
      && firstPassAlertMints.has(mint)
      && !firstFullPassAlertMints.has(mint)
    ) {
      firstFullPassAlertMints.add(mint);
      safeAppendJsonl(eventsFile, {
        ...observation,
        type: 'full_pass_first',
        entry_proxy_market_cap_usd: q.marketCapUsd,
      });
      await sendPassTelegram(observation, fullFilter, 'full PASS');
      if (verbose) {
        console.log(`\n🟢 Full Jupiter PASS → Telegram follow-up: ${observation.symbol || '?'} ${mint.slice(0, 8)}...\n`);
      }
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
    unique_quick_pass: firstPassAlertMints.size,
    unique_full_pass: firstFullPassAlertMints.size,
  };
  safeAppendJsonl(eventsFile, summary);

  if (verbose) {
    console.log(`\n[${observedAtIso}] tick #${tick} | tracked=${coins.length} | quick PASS=${quickPassCount} | FAIL=${coins.length - quickPassCount}`);
    console.log('── Semua token dianalisa (CA lengkap) ──');
    for (const r of analyzed) {
      const status = r.pass ? '✓ PASS' : (r.quickOnlyPass ? '◐ QUICK' : '✗ FAIL');
      const hqsStr = r.hqs ? ` hqs=${r.hqs}` : '';
      const rcStr = r.rugcheck ? ` rc=${r.rugcheck}` : '';
      const reason = r.reasons.length ? ` | ${r.reasons.join('; ')}` : '';
      console.log(`  ${status} | ${String(r.symbol).padEnd(12)} | age=${r.age.padEnd(8)} mcap=${r.mcapPump.padEnd(8)}${hqsStr}${rcStr}${reason}`);
      console.log(`           CA: ${r.mint}`);
    }
    if (!quickPassCount && tick === 1) {
      console.log('\n(tidak ada token yang lulus quick filter saat ini — monitor terus…)\n');
    }
    console.log(`[graduated] tick #${tick} complete | new_pass_this_tick=${newPassCount}`);
  } else if (!quiet) {
    console.log(`[collect] tick=${tick} tracked=${coins.length} quick_pass=${quickPassCount} new_pass=${newPassCount} unique_pass=${firstPassAlertMints.size}`);
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
    unique_quick_pass: firstPassAlertMints.size,
    unique_full_pass: firstFullPassAlertMints.size,
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

function handleStopSignal(signal) {
  stop(0, signal).catch(err => {
    console.error(`[collect] stop failed: ${err.message}`);
    process.exit(1);
  });
}

// Tutup terminal SSH mengirim SIGHUP — abaikan agar proses tidak mati (pakai daemon spawn detached tetap disarankan).
process.on('SIGHUP', () => {
  console.log('[collect] SIGHUP ignored (use graduate-screening-daemon.mjs start for detached runs)');
});

process.on('SIGINT', () => handleStopSignal('SIGINT'));
process.on('SIGTERM', () => handleStopSignal('SIGTERM'));

try {
  await withTimeout(scanOnce(), 5 * 60_000, 'scanOnce (initial)');
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
      if (scanInProgress) {
        console.log('[collect] previous scan still running, skipping tick');
        scheduleNext();
        return;
      }
      scanInProgress = true;
      try {
        await withTimeout(scanOnce(), 5 * 60_000, 'scanOnce');
      } catch (err) {
        try {
          safeAppendJsonl(eventsFile, {
            type: 'collector_error',
            session_id: sessionId,
            tick,
            observed_at_ms: now(),
            observed_at_iso: new Date().toISOString(),
            error: err.message,
          });
        } catch { /* protect loop recovery */ }
        console.error(`[collect] error: ${err.message}`);
      } finally {
        scanInProgress = false;
        scheduleNext();
      }
    }, intervalMs);
  };

  scheduleNext();
} catch (err) {
  console.error(`[collect] fatal: ${err.message}`);
  await stop(1, 'fatal_error');
}
