/**
 * Monitor realtime: token graduate yang lulus filter graduate_immediate.
 * Menampilkan contract address (CA) penuh untuk yang PASS.
 *
 * Usage:
 *   node scripts/watch-graduate-screening.mjs
 *   node scripts/watch-graduate-screening.mjs --interval 5000
 *   node scripts/watch-graduate-screening.mjs --confirm-full   # Jupiter confirm untuk PASS quick
 *
 * Ctrl+C untuk stop.
 */
import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);
const intervalMs = Number(args[args.indexOf('--interval') + 1]) || 5_000;
const confirmFull = args.includes('--confirm-full');

process.env.GMGN_ENABLED = 'false';
process.env.TWITTER_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
const { strategyById, setActiveStrategy, activeStrategy } = await import('../src/db/settings.js');
const { fetchGraduatedCoins, graduated } = await import('../src/signals/graduated.js');
const { buildCandidate } = await import('../src/pipeline/candidateBuilder.js');
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
  return `$${Math.round(n)}`;
}

function quickPrefilter(coin, strat) {
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
  return { passed: failures.length === 0, failures, ageMs, mcap };
}

initDb();

const strat = strategyById('graduate_immediate');
if (!strat) {
  console.error('Strategi graduate_immediate tidak ada. Jalankan bot sekali untuk seed DB.');
  process.exit(1);
}

const prevId = activeStrategy()?.id ?? 'sniper';
setActiveStrategy('graduate_immediate');

const announcedPass = new Set();
const announcedFail = new Set();
let tick = 0;

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  WATCH graduate_immediate — realtime screening               ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`Poll setiap ${intervalMs / 1000}s | umur ${strat.min_graduated_age_ms / 1000}s–${strat.max_graduated_age_ms / 1000}s | mcap ${fmtUsd(strat.min_mcap_usd)}–${fmtUsd(strat.max_mcap_usd)}`);
console.log(`Confirm Jupiter: ${confirmFull ? 'YA' : 'tidak (quick Pump saja)'}`);
console.log('Ctrl+C untuk berhenti\n');

async function scanOnce() {
  tick += 1;
  const ts = new Date().toISOString();
  graduated.clear();
  await fetchGraduatedCoins();

  const coins = [...graduated.values()]
    .filter(c => c?.coinMint)
    .sort((a, b) => Number(b.graduationDate || 0) - Number(a.graduationDate || 0));

  const passQuick = [];
  const analyzed = [];

  for (const coin of coins) {
    const q = quickPrefilter(coin, strat);
    const mint = coin.coinMint;
    const row = {
      symbol: coin.ticker || coin.symbol || '?',
      CA: mint,
      pass: q.passed,
      age: fmtAge(q.ageMs),
      mcapPump: fmtUsd(q.mcap),
      reasons: q.failures,
    };
    analyzed.push(row);
    if (q.passed) passQuick.push({ coin, row });
  }

  // Ringkasan tick
  console.log(`\n[${ts}] tick #${tick} | tracked=${coins.length} | quick PASS=${passQuick.length} | FAIL=${coins.length - passQuick.length}`);

  // Tampilkan semua yang dianalisa (CA lengkap)
  console.log('── Semua token dianalisa (CA lengkap) ──');
  for (const r of analyzed) {
    const status = r.pass ? '✓ PASS' : '✗ FAIL';
    const reason = r.reasons.length ? ` | ${r.reasons.join('; ')}` : '';
    console.log(`  ${status} | ${r.symbol.padEnd(12)} | age=${r.age.padEnd(8)} mcap=${r.mcapPump.padEnd(8)}${reason}`);
    console.log(`           CA: ${r.CA}`);
  }

  // Highlight PASS baru
  for (const { coin, row } of passQuick) {
    const mint = coin.coinMint;
    if (announcedPass.has(mint)) continue;

    let fullPass = true;
    let fullFailures = [];
    let mcapJup = row.mcapPump;

    if (confirmFull) {
      try {
        const candidate = await buildCandidate({
          mint,
          graduatedCoin: coin,
          route: 'watch_graduate',
        });
        fullPass = candidate.filters?.passed ?? false;
        fullFailures = candidate.filters?.failures ?? [];
        mcapJup = fmtUsd(candidate.metrics?.marketCapUsd);
      } catch (err) {
        fullPass = false;
        fullFailures = [`build error: ${err.message}`];
      }
    }

    if (!confirmFull || fullPass) {
      announcedPass.add(mint);
      console.log('\n🟢 ═══ LULUS FILTER (BARU) ═══');
      console.log(`   Symbol : ${row.symbol}`);
      console.log(`   CA     : ${mint}`);
      console.log(`   Umur   : ${row.age} sejak graduate`);
      console.log(`   Mcap   : Pump ${row.mcapPump}${confirmFull ? ` | Jupiter ${mcapJup}` : ''}`);
      if (fullFailures.length) console.log(`   Catatan: ${fullFailures.join('; ')}`);
      console.log('══════════════════════════════\n');
    } else {
      console.log(`\n⚠ Quick PASS tapi Jupiter FAIL: ${row.symbol}`);
      console.log(`   CA: ${mint}`);
      console.log(`   ${fullFailures.join('; ')}\n`);
    }
  }

  if (!passQuick.length && tick === 1) {
    console.log('\n(tidak ada token yang lulus quick filter saat ini — monitor terus…)\n');
  }
}

await scanOnce();

const timer = setInterval(() => {
  scanOnce().catch(err => console.error('[watch] error:', err.message));
}, intervalMs);

process.on('SIGINT', () => {
  clearInterval(timer);
  setActiveStrategy(prevId);
  console.log(`\n[watch] stopped. Strategi dikembalikan ke: ${prevId}`);
  process.exit(0);
});
