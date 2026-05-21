import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, volume1hUsdFromJupiterAsset } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { graduated } from '../signals/graduated.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

/**
 * If another mint shares this Pump ticker and graduated strictly earlier within windowMs, return failure reason (copy/vamp heuristic).
 */
export function duplicateTickerOgFailure(mint, graduationRow, windowMs, graduatedMap, fallbackTicker = '') {
  if (!windowMs || !mint || !graduationRow) return null;
  const myTicker = String(graduationRow.ticker ?? fallbackTicker ?? '').trim().toUpperCase();
  const myG = Number(graduationRow.graduationDate || 0);
  if (!myTicker || !myG) return null;
  for (const coin of graduatedMap.values()) {
    const otherMint = coin.coinMint;
    if (!otherMint || otherMint === mint) continue;
    const otherTicker = String(coin.ticker || '').trim().toUpperCase();
    if (otherTicker !== myTicker) continue;
    const otherG = Number(coin.graduationDate || 0);
    if (!(otherG > 0 && otherG < myG)) continue;
    const deltaMs = myG - otherG;
    if (deltaMs > 0 && deltaMs <= windowMs) {
      return `duplicate ticker: ${myTicker} has earlier graduate (${Math.round(deltaMs / 1000)}s before, same window)`;
    }
  }
  return null;
}

/**
 * Holder Quality Score (HQS): bundler cluster, dev wallet, concentration.
 * Score 0–100 (higher = healthier). No extra API calls.
 */
export function computeHolderQualityScore(candidate) {
  const holders = candidate.holders;
  const top20 = holders?.top20 ?? [];
  const bundRate = Number(candidate.trending?.bundler_rate ?? candidate.metrics?.bundlerRate ?? 0);
  const liqUsd = Number(candidate.metrics?.liquidityUsd ?? 0);
  const mcapUsd = Math.max(Number(candidate.metrics?.marketCapUsd ?? 1), 1);
  const flags = [];
  let penalty = 0;

  if (!top20 || top20.length < 3) {
    return { score: 60, flags: ['no_holder_data'] };
  }

  const midPcts = top20
    .slice(1, 15)
    .map(h => Number(h.percent ?? 0))
    .filter(p => p > 0.3);

  if (midPcts.length >= 5) {
    const avg = midPcts.reduce((a, b) => a + b, 0) / midPcts.length;
    const variance = midPcts.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / midPcts.length;
    const cv = avg > 0 ? Math.sqrt(variance) / avg : 99;

    if (cv < 0.45 && avg > 1.5 && midPcts.length >= 7) {
      penalty += 35;
      flags.push('uniform_cluster');
    } else if (cv < 0.35 && avg > 2.0 && midPcts.length >= 5) {
      penalty += 20;
      flags.push('mod_uniform_cluster');
    }
  }

  const topPct = Number(top20[0]?.percent ?? 0);
  const poolRatio = liqUsd / mcapUsd;

  if (topPct > 15) {
    if (bundRate > 0.20 || poolRatio < 0.12) {
      penalty += 30;
      flags.push('high_single_holder');
    }
    if (topPct > 30 && bundRate > 0.10) {
      penalty += 15;
      flags.push('extreme_single_holder');
    }
  }

  const top5excl = top20
    .slice(1, 6)
    .reduce((s, h) => s + Number(h.percent ?? 0), 0);

  if (top5excl > 30 && bundRate > 0.15) {
    penalty += 20;
    flags.push('top5_concentrated');
  } else if (top5excl > 40 && bundRate > 0.08) {
    penalty += 15;
    flags.push('top5_high');
  }

  if (bundRate > 0.45) {
    penalty += 25;
    flags.push('high_bundler_rate');
  } else if (bundRate > 0.30) {
    penalty += 10;
    flags.push('mod_bundler_rate');
  }

  const score = Math.max(0, 100 - penalty);
  return { score, flags };
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const vol1h = candidate.metrics.volume1hUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const rawTop4 = candidate.holders?.top4HolderCombinedPercent;
  const top4Combined = rawTop4 == null ? null : Number(rawTop4);
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    const mcapStr = Number.isFinite(mcap) ? `$${Math.round(mcap).toLocaleString('en-US')}` : 'unknown';
    failures.push(`market cap min: ${mcapStr} < $${Number(strat.min_mcap_usd).toLocaleString('en-US')}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: $${Math.round(mcap).toLocaleString('en-US')} > $${Number(strat.max_mcap_usd).toLocaleString('en-US')}`);
  }

  const dupMsg = duplicateTickerOgFailure(
    candidate.token.mint,
    candidate.graduation,
    strat.duplicate_ticker_og_window_ms,
    graduated,
    candidate.token.symbol,
  );
  if (dupMsg) failures.push(dupMsg);

  // Graduate age gate
  if (strat.min_graduated_age_ms > 0 || strat.max_graduated_age_ms > 0) {
    const gradDate = Number(candidate.graduation?.graduationDate || 0);
    if (gradDate > 0) {
      const ageMs = now() - gradDate;
      if (strat.min_graduated_age_ms > 0 && ageMs < strat.min_graduated_age_ms) {
        failures.push(`token too young (${Math.round(ageMs / 1000)}s < ${Math.round(strat.min_graduated_age_ms / 1000)}s)`);
      }
      if (strat.max_graduated_age_ms > 0 && ageMs > strat.max_graduated_age_ms) {
        failures.push(`token too old (${Math.round(ageMs / 1000)}s > ${Math.round(strat.max_graduated_age_ms / 1000)}s)`);
      }
    }
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // 1h volume (Jupiter stats1h — aligns with GMGN Trench "1h Vol" style gates)
  if (strat.min_volume_1h_usd > 0 || strat.max_volume_1h_usd > 0) {
    if (!Number.isFinite(vol1h) || vol1h == null) {
      if (strat.min_volume_1h_usd > 0) {
        failures.push('1h volume: unavailable (Jupiter stats1h missing)');
      }
    } else {
      if (strat.min_volume_1h_usd > 0 && vol1h < strat.min_volume_1h_usd) {
        failures.push(`1h volume: ${Math.round(vol1h)} < ${strat.min_volume_1h_usd}`);
      }
      if (strat.max_volume_1h_usd > 0 && vol1h > strat.max_volume_1h_usd) {
        failures.push(`1h volume: ${Math.round(vol1h)} > ${strat.max_volume_1h_usd}`);
      }
    }
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Liquidity minimum - filter token yang praktis tidak bisa dijual
  // Data liquidityUsd sudah tersedia dari Jupiter tanpa call tambahan
  if (strat.min_liquidity_usd > 0) {
    const liquidityUsd = Number(candidate.metrics?.liquidityUsd ?? 0);
    if (liquidityUsd < strat.min_liquidity_usd) {
      failures.push(`liquidity: $${liquidityUsd.toFixed(0)} < $${strat.min_liquidity_usd}`);
    }
  }

  if (strat.min_holder_quality_score > 0 && candidate.holders) {
    const hqs = computeHolderQualityScore(candidate);
    if (hqs.score < strat.min_holder_quality_score) {
      const flagStr = hqs.flags.length ? ` (${hqs.flags.join(', ')})` : '';
      failures.push(`holder quality: ${hqs.score}/100 < ${strat.min_holder_quality_score}${flagStr}`);
    }
  }

  // Top holder concentration (legacy single-wallet cap)
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Extreme bundler / supply cartel (Jupiter holder list): not too strict — catches ~4×20% style dumps
  if (strat.max_bundle_single_holder_percent > 0 && Number.isFinite(maxHolder) && maxHolder > strat.max_bundle_single_holder_percent) {
    failures.push(`bundle: largest holder ${maxHolder.toFixed(1)}% > ${strat.max_bundle_single_holder_percent}%`);
  }
  if (strat.max_bundle_top4_combined_percent > 0 && top4Combined != null && Number.isFinite(top4Combined)
    && top4Combined > strat.max_bundle_top4_combined_percent) {
    failures.push(`bundle: top4 combined ${top4Combined.toFixed(1)}% > ${strat.max_bundle_top4_combined_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  return { passed: failures.length === 0, failures, strategy: strat.id };
}

function isFastMigrateEnrichment(route, strat) {
  return route === 'migrate_immediate'
    || (strat?.id === 'graduate_immediate' && strat?.entry_mode === 'immediate');
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const strat = activeStrategy();
  const fastMigrate = isFastMigrateEnrichment(route, strat);
  let gmgn;
  let jupiterAsset;
  let holders;
  let chart;
  let savedWalletExposure;
  let twitterNarrative;

  if (fastMigrate) {
    [gmgn, jupiterAsset, holders] = await Promise.all([
      fetchGmgnTokenInfo(mint),
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
    ]);
    chart = null;
    savedWalletExposure = { holderCount: 0, checked: 0, wallets: [] };
    twitterNarrative = null;
  } else {
    [gmgn, jupiterAsset, holders, chart] = await Promise.all([
      fetchGmgnTokenInfo(mint),
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
      fetchJupiterChartContext(mint),
    ]);
    savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
    twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  }
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const volume1hUsd = volume1hUsdFromJupiterAsset(jupiterAsset);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      volume1hUsd,
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.builtAtMs = now();
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
