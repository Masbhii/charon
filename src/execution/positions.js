import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById, activeStrategy } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl, batchFetchPrices, volume1hUsdFromJupiterAsset } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { fetchRugcheckSummary } from '../enrichment/rugcheck.js';
import { RUGCHECK_ENABLED } from '../config.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const strat = strategyById(activeStrategy()?.id);
  const fastMigrate = strat?.id === 'graduate_immediate';
  const needRugcheck = RUGCHECK_ENABLED && (Number(strat?.min_rugcheck_score ?? 0) > 0 || (strat?.rugcheck_max_risk_level && strat?.rugcheck_max_risk_level !== 'off'));
  const [gmgn, asset, holders, chart, rugcheck] = await Promise.all([
    fetchGmgnTokenInfo(mint, false),
    fetchJupiterAsset(mint, { useCache: false }),
    fetchJupiterHolders(mint),
    fastMigrate ? Promise.resolve(null) : fetchJupiterChartContext(mint),
    needRugcheck ? fetchRugcheckSummary(mint, { useCache: false }) : Promise.resolve(candidate.rugcheck ?? null),
  ]);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = fastMigrate
    ? (candidate.savedWalletExposure || { holderCount: 0, checked: 0, wallets: [] })
    : selectedHolders
      ? await fetchSavedWalletExposure(mint, selectedHolders)
      : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      volume1hUsd: volume1hUsdFromJupiterAsset(asset) ?? candidate.metrics?.volume1hUsd ?? null,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    rugcheck,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null, cachedBatchPrice = null } = {}) {
  let asset = null;
  if (cachedBatchPrice) {
    asset = await fetchJupiterAsset(position.mint, { useCache: true, ttlMs: 15_000 });
    if (cachedBatchPrice.usdPrice > 0 && asset) {
      asset = { ...asset, usdPrice: cachedBatchPrice.usdPrice };
    }
  } else {
    asset = await fetchJupiterAsset(position.mint);
  }

  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  const entryMcap = Number(position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(entryMcap) || entryMcap <= 0) {
    console.log(`[position] ${position.id} mcap invalid (mcap=${mcap} entry=${entryMcap}), skip`);
    return null;
  }

  const currentMcap = Number(mcap);
  const prevLowest = Number(position.lowest_mcap_after_entry || entryMcap);
  const lowestMcap = Math.min(prevLowest, currentMcap);
  const dumpPercent = (lowestMcap / entryMcap - 1) * 100;
  const pnlAtCurrentMcap = (currentMcap / entryMcap - 1) * 100;
  const dumpThenRecovered = !position.dump_then_recovered && dumpPercent < -10 && pnlAtCurrentMcap >= 0;
  db.prepare(`
    UPDATE dry_run_positions
    SET lowest_mcap_after_entry = ?,
        dump_then_recovered = CASE WHEN ? THEN 1 ELSE dump_then_recovered END
    WHERE id = ?
  `).run(lowestMcap, dumpThenRecovered ? 1 : 0, position.id);
  if (dumpThenRecovered) {
    console.log(`[position] ${position.id} dump→recovery (was ${dumpPercent.toFixed(1)}%, now BEP+)`);
  }

  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), currentMcap);
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const entrySol = Number(position.dynamic_size_sol ?? position.size_sol);
  let pnlPercent = (currentMcap / entryMcap - 1) * 100;
  let pnlSol = entrySol * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const strat = strategyById(position.strategy_id);
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const activeSlRule = db.prepare(
    'SELECT sl_percent FROM tp_sl_rules WHERE position_id = ? ORDER BY updated_at_ms DESC LIMIT 1',
  ).get(position.id);
  const activeSl = Number(activeSlRule?.sl_percent ?? position.sl_percent);
  const slHit = pnlPercent <= activeSl;
  const earlyTrailArmPct = Number(strat?.early_trail_arm_pct ?? 0);
  const trailingArmed = position.trailing_armed
    || (position.trailing_enabled && tpHit)
    || (position.trailing_enabled && earlyTrailArmPct > 0 && pnlPercent >= earlyTrailArmPct);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;

  // Max hold time check
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP check
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    if (!strat.moonbag_on_partial_tp && !position.sl_moved_to_bep) {
      const currentSl = Number(activeSlRule?.sl_percent ?? position.sl_percent);
      if (currentSl < 0) {
        db.prepare('UPDATE tp_sl_rules SET sl_percent = 0, updated_at_ms = ? WHERE position_id = ?').run(now(), position.id);
        db.prepare('UPDATE dry_run_positions SET sl_moved_to_bep = 1 WHERE id = ?').run(position.id);
        console.log(`[position] ${position.id} SL → BEP after partial TP`);
      }
    }
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    let partialSellOk = position.execution_mode !== 'live';
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          partialSellOk = true;
          const remaining = Number(position.token_amount_raw) - sellAmount;
          if (!strat.moonbag_on_partial_tp) {
            db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          }
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
    if (strat.moonbag_on_partial_tp && partialSellOk) {
      exitReason = 'MOONBAG';
      const remainingRaw = position.token_amount_raw
        ? Math.floor(Number(position.token_amount_raw) * (1 - (strat.partial_tp_sell_percent / 100)))
        : null;
      console.log(`[position] ${position.id} MOONBAG — ${remainingRaw ?? '?'} tokens left in wallet (manual)`);
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (exitReason === 'MOONBAG') {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
            pnl_percent = ?, pnl_sol = ?
        WHERE id = ?
      `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'moonbag', ?, ?, ?, ?, ?, 'MOONBAG', ?)
      `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est,
        json({ pnlPercent, pnlSol, note: 'remainder in wallet — monitor manually' }));
      closed = true;
    } else if (sellInProgress.has(position.id)) {
      return { ...position, exitReason: null };
    } else {
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - entrySol;
      finalPnlPercent = (receivedSol / entrySol - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
    }
  } else if (exitReason && autoExit) {
    if (exitReason === 'MOONBAG') {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
        WHERE id = ?
      `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'moonbag', ?, ?, ?, ?, ?, 'MOONBAG', ?)
      `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est,
        json({ pnlPercent, pnlSol, note: 'remainder in wallet — monitor manually' }));
      closed = true;
    } else {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol }));
    closed = true;
    }
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  if (positions.length === 0) return;

  const mints = [...new Set(positions.map(p => p.mint))];
  let batchPrices = new Map();
  try {
    batchPrices = await batchFetchPrices(mints);
  } catch (err) {
    console.log(`[monitor] batch price failed: ${err.message}`);
  }

  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey).catch((err) => {
      console.log(`[monitor] wallet pnl failed: ${err.message}`);
      return {};
    });
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, {
      autoExit: true,
      jupiterPnl,
      cachedBatchPrice: batchPrices.get(position.mint) || null,
    }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
