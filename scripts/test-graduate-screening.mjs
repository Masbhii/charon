/**
 * Uji screening token baru migrate/graduate untuk strategi graduate_immediate.
 * Tidak menjalankan bot penuh — fetch Pump.fun + buildCandidate + filterCandidate.
 *
 * Usage: node scripts/test-graduate-screening.mjs [--full N] [--quick-only]
 *   --full N   : enrichment penuh untuk N token terbaru (default 8)
 *   --quick-only : hanya pre-screen umur/mcap dari API Pump (tanpa Jupiter)
 */
import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);
const withGmgn = args.includes('--with-gmgn');
process.env.GMGN_ENABLED = withGmgn ? (process.env.GMGN_ENABLED ?? 'true') : 'false';
process.env.TWITTER_ENABLED = 'false';
const quickOnly = args.includes('--quick-only');
const fullIdx = args.indexOf('--full');
const fullLimit = fullIdx >= 0 ? Math.max(1, Number(args[fullIdx + 1]) || 8) : 8;

const { initDb } = await import('../src/db/connection.js');
const { strategyById, setActiveStrategy, activeStrategy } = await import('../src/db/settings.js');
const { fetchGraduatedCoins, graduated } = await import('../src/signals/graduated.js');
const { buildCandidate, filterCandidate } = await import('../src/pipeline/candidateBuilder.js');
const { now } = await import('../src/utils.js');

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${(s / 3600).toFixed(1)}h`;
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function quickPrefilter(coin, strat) {
  const failures = [];
  const gradDate = Number(coin.graduationDate || 0);
  const ageMs = gradDate > 0 ? now() - gradDate : null;
  const mcap = Number(coin.marketCap ?? coin.usd_market_cap ?? 0) || null;

  if (gradDate <= 0) failures.push('no graduationDate');
  if (ageMs != null && strat.min_graduated_age_ms > 0 && ageMs < strat.min_graduated_age_ms) {
    failures.push(`too young: ${fmtAge(ageMs)} < ${strat.min_graduated_age_ms / 1000}s min`);
  }
  if (ageMs != null && strat.max_graduated_age_ms > 0 && ageMs > strat.max_graduated_age_ms) {
    failures.push(`too old: ${fmtAge(ageMs)} > ${strat.max_graduated_age_ms / 1000}s max`);
  }
  if (strat.min_mcap_usd > 0 && (!mcap || mcap < strat.min_mcap_usd)) {
    failures.push(`mcap pump API ${fmtUsd(mcap)} < min ${fmtUsd(strat.min_mcap_usd)}`);
  }
  if (strat.max_mcap_usd > 0 && mcap && mcap > strat.max_mcap_usd) {
    failures.push(`mcap pump API ${fmtUsd(mcap)} > max ${fmtUsd(strat.max_mcap_usd)}`);
  }
  return { passed: failures.length === 0, failures, ageMs, mcap };
}

initDb();

const strat = strategyById('graduate_immediate');
if (!strat) {
  console.error('Strategi graduate_immediate tidak ada di DB. Restart bot sekali (initDb seed).');
  process.exit(1);
}

const prevActive = activeStrategy();
const prevId = prevActive?.id ?? 'sniper';
setActiveStrategy('graduate_immediate');

console.log('=== TEST SCREENING graduate_immediate ===\n');
console.log('Filter utama:');
console.log(`  umur graduate: ${strat.min_graduated_age_ms / 1000}s – ${strat.max_graduated_age_ms / 1000}s`);
console.log(`  mcap: ${fmtUsd(strat.min_mcap_usd)} – ${fmtUsd(strat.max_mcap_usd)}`);
console.log(`  GMGN_ENABLED=${process.env.GMGN_ENABLED} TWITTER_ENABLED=${process.env.TWITTER_ENABLED}`);
console.log(`  mode: ${quickOnly ? 'quick-only (Pump API)' : `quick + full buildCandidate (max ${fullLimit})`}\n`);

await fetchGraduatedCoins();

const coins = [...graduated.values()]
  .filter(c => c?.coinMint)
  .sort((a, b) => Number(b.graduationDate || 0) - Number(a.graduationDate || 0));

console.log(`Token graduated ter-track: ${coins.length}\n`);

if (!coins.length) {
  console.log('Tidak ada token di map graduated. Cek koneksi Pump.fun API.');
  setActiveStrategy(prevId);
  process.exit(0);
}

const buckets = { passQuick: [], failQuick: [] };
for (const coin of coins) {
  const q = quickPrefilter(coin, strat);
  const row = {
    mint: coin.coinMint.slice(0, 8) + '...',
    symbol: coin.ticker || coin.symbol || '-',
    age: q.ageMs != null ? fmtAge(q.ageMs) : '?',
    mcapPump: fmtUsd(q.mcap),
    quick: q.passed ? 'PASS' : 'FAIL',
    reasons: q.failures,
  };
  if (q.passed) buckets.passQuick.push({ coin, row });
  else buckets.failQuick.push(row);
}

console.log('--- PRE-SCREEN (Pump.fun, umur + mcap API) ---');
console.log(`Lulus: ${buckets.passQuick.length} | Gagal: ${buckets.failQuick.length}\n`);

const failByReason = {};
for (const r of buckets.failQuick) {
  for (const reason of r.reasons) {
    const key = reason.split(':')[0].trim();
    failByReason[key] = (failByReason[key] || 0) + 1;
  }
}
if (Object.keys(failByReason).length) {
  console.log('Alasan gagal (pre-screen):');
  for (const [k, v] of Object.entries(failByReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');
}

console.log('10 token TERBARU (urut graduationDate):');
for (const coin of coins.slice(0, 10)) {
  const q = quickPrefilter(coin, strat);
  console.log(
    `  ${(coin.ticker || '?').padEnd(10)} age=${fmtAge(q.ageMs).padEnd(8)} mcap=${fmtUsd(q.mcap).padEnd(8)} quick=${q.passed ? 'PASS' : 'FAIL'} ${q.failures[0] || ''}`,
  );
}

if (quickOnly) {
  setActiveStrategy(prevId);
  console.log('\nSelesai (--quick-only). Jalankan tanpa flag untuk enrichment Jupiter penuh.');
  process.exit(0);
}

const toEnrich = buckets.passQuick.slice(0, fullLimit);
if (!toEnrich.length) {
  console.log('\nTidak ada token yang lulus pre-screen untuk enrichment penuh.');
  console.log('Tip: banyak token baru graduate < 60s — tunggu min_graduated_age_ms atau turunkan via /stratset.');
  setActiveStrategy(prevId);
  process.exit(0);
}

console.log(`\n--- FULL PIPELINE (buildCandidate + filterCandidate, max ${toEnrich.length}) ---\n`);

let passFull = 0;
for (const { coin } of toEnrich) {
  const mint = coin.coinMint;
  const t0 = Date.now();
  try {
    const candidate = await buildCandidate({
      mint,
      graduatedCoin: coin,
      route: 'graduate_screening_test',
    });
    const ms = Date.now() - t0;
    const f = candidate.filters;
    const sym = candidate.token?.symbol || coin.ticker || '?';
    if (f.passed) passFull += 1;
    console.log({
      symbol: sym,
      mint: mint.slice(0, 12) + '...',
      lulus: f.passed,
      mcapJupiter: fmtUsd(candidate.metrics?.marketCapUsd),
      umurGrad: fmtAge(now() - Number(coin.graduationDate || 0)),
      builtMs: ms,
      gagal: f.failures?.length ? f.failures : undefined,
    });
  } catch (err) {
    console.log({ mint: mint.slice(0, 12), error: err.message });
  }
}

console.log(`\nRingkasan full pipeline: ${passFull}/${toEnrich.length} lulus filter graduate_immediate`);
setActiveStrategy(prevId);
console.log(`Strategi aktif dikembalikan ke: ${prevId}`);
