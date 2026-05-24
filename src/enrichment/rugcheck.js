import axios from 'axios';
import {
  RUGCHECK_API_KEY,
  RUGCHECK_BASE_URL,
  RUGCHECK_ENABLED,
  RUGCHECK_FAIL_OPEN,
  RUGCHECK_TIMEOUT_MS,
  RUGCHECK_CACHE_TTL_MS,
} from '../config.js';
import { now } from '../utils.js';

const summaryCache = new Map();

function authHeaders() {
  if (!RUGCHECK_API_KEY) return {};
  return { 'X-API-KEY': RUGCHECK_API_KEY };
}

/**
 * RugCheck UI score 0–100 (higher = safer). Prefer score_normalised from API.
 */
export function rugcheckDisplayScore(report) {
  if (!report || typeof report !== 'object') return null;
  const norm = Number(report.score_normalised ?? report.scoreNormalized);
  if (Number.isFinite(norm) && norm >= 0 && norm <= 100) return Math.round(norm);
  const score = Number(report.score);
  if (Number.isFinite(score) && score >= 0 && score <= 100) return Math.round(score);
  return null;
}

export function summarizeRugcheckReport(report) {
  if (!report) return null;
  const displayScore = rugcheckDisplayScore(report);
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const riskNames = risks
    .map(r => String(r?.name || r?.title || r?.description || '').trim())
    .filter(Boolean);
  return {
    displayScore,
    riskLevel: report.riskLevel ?? report.risk_level ?? null,
    rugged: Boolean(report.rugged),
    lpLockedPct: Number(report.lpLockedPct ?? report.lp_locked_pct ?? NaN),
    topHoldersPct: Number(report.topHoldersPct ?? report.top_holders_pct ?? NaN),
    creatorHistoryRug: riskNames.some(n => /creator history of rugged/i.test(n)),
    riskFlags: riskNames.slice(0, 6),
    fetchedAtMs: now(),
  };
}

/**
 * GET /v1/tokens/{mint}/report/summary — FluxRPC / RugCheck API.
 * @see https://fluxbeam.gitbook.io/fluxrpc-docs/rugcheck-api/getting-started
 */
export async function fetchRugcheckSummary(mint, { useCache = true, ttlMs = RUGCHECK_CACHE_TTL_MS } = {}) {
  if (!RUGCHECK_ENABLED || !mint) return null;

  const cached = summaryCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) {
    return cached.data;
  }

  const base = RUGCHECK_BASE_URL.replace(/\/$/, '');
  const url = `${base}/v1/tokens/${mint}/report/summary`;

  try {
    const res = await axios.get(url, {
      timeout: RUGCHECK_TIMEOUT_MS,
      headers: { Accept: 'application/json', ...authHeaders() },
      validateStatus: status => status === 200 || status === 404,
    });
    if (res.status === 404) {
      const missing = { displayScore: null, riskLevel: null, unavailable: true, reason: 'not_found' };
      summaryCache.set(mint, { at: now(), data: missing });
      return missing;
    }
    const summary = summarizeRugcheckReport(res.data);
    summaryCache.set(mint, { at: now(), data: summary });
    return summary;
  } catch (err) {
    const fail = {
      displayScore: null,
      riskLevel: null,
      unavailable: true,
      reason: err.message,
      failOpen: RUGCHECK_FAIL_OPEN,
    };
    if (useCache) summaryCache.set(mint, { at: now(), data: fail });
    console.log(`[rugcheck] ${mint.slice(0, 8)}... ${err.message}`);
    return fail;
  }
}

/**
 * Check rugcheck data against strategy filters.
 * @param {object} candidate - candidate with .rugcheck property
 * @param {number} minScore - legacy numeric threshold (0 = disabled). Higher = stricter.
 * @param {string|null} maxRiskLevel - text-based filter: 'good' | 'warn' | 'danger' | 'off' | null
 *   'good'   → only "Good" passes, "Warn"/"Danger" rejected
 *   'warn'   → "Good" and "Warn" pass, "Danger" rejected
 *   'danger' → everything passes (effectively disabled)
 *   'off'/null → text filter disabled, fall through to numeric check
 */
export function rugcheckFilterFailure(candidate, minScore, maxRiskLevel = null) {
  const rc = candidate?.rugcheck;
  const hasNumericFilter = minScore && minScore > 0;
  const hasLevelFilter = maxRiskLevel && maxRiskLevel !== 'off' && maxRiskLevel !== 'danger';

  // Both filters disabled → pass
  if (!hasNumericFilter && !hasLevelFilter) return null;

  if (!rc) {
    return RUGCHECK_FAIL_OPEN ? null : 'rugcheck: no data';
  }
  if (rc.unavailable) {
    return RUGCHECK_FAIL_OPEN ? null : `rugcheck: unavailable (${rc.reason || 'error'})`;
  }

  // Risk level check (text-based, primary — more reliable than numeric score)
  if (hasLevelFilter && rc.riskLevel) {
    const LEVEL_ORDER = { good: 0, warn: 1, warning: 1, danger: 2 };
    const maxAllowed = LEVEL_ORDER[String(maxRiskLevel).toLowerCase()] ?? 2;
    const actual = LEVEL_ORDER[String(rc.riskLevel).toLowerCase()];
    if (actual != null && actual > maxAllowed) {
      const flags = rc.riskFlags?.length ? ` (${rc.riskFlags.join(', ')})` : '';
      return `rugcheck: ${rc.riskLevel} > max allowed ${maxRiskLevel}${flags}`;
    }
  }

  // Numeric score check (legacy fallback, only if minScore > 0)
  if (hasNumericFilter) {
    if (rc.displayScore == null) {
      return RUGCHECK_FAIL_OPEN ? null : 'rugcheck: score missing';
    }
    if (rc.displayScore < minScore) {
      const flags = rc.riskFlags?.length ? ` (${rc.riskFlags.join(', ')})` : '';
      return `rugcheck: ${rc.displayScore}/100 < ${minScore}${flags}`;
    }
  }

  return null;
}
