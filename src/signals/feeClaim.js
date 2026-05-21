import WebSocket from 'ws';
import {
  PUMP_PROGRAM,
  PUMP_AMM,
  DISC_DIST_FEES,
  DISC_CREATE_POOL,
  GRADUATE_IMMEDIATE_ENABLED,
  SOLANA_WS_URL,
} from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees, readPubkeyFromBuffer } from '../utils.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';

export const seenFeeClaims = new Map();
export const seenMigrations = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleMigrateEvent(data, signature) {
  if (!GRADUATE_IMMEDIATE_ENABLED) return;

  let mint = readPubkeyFromBuffer(data, 8);
  if (!mint) mint = readPubkeyFromBuffer(data, 32);
  if (!mint) mint = readPubkeyFromBuffer(data, 64);
  if (!mint) {
    console.log(`[migrate] Could not parse mint from sig ${signature?.slice(0, 8) || '???'}...`);
    return;
  }

  pruneSeen(seenMigrations, 10 * 60_000);
  const dedupeKey = `migrate:${mint}`;
  if (seenMigrations.has(dedupeKey)) return;
  seenMigrations.set(dedupeKey, now());

  console.log(`[migrate] Pool created: ${mint.slice(0, 8)}... sig=${signature?.slice(0, 8) || '???'}...`);

  if (!graduated.has(mint)) {
    graduated.set(mint, {
      coinMint: mint,
      graduationDate: now(),
      seenAt: now(),
      source: 'ws_migrate_event',
    });
  }

  if (!candidateHandler) return;

  const strat = strategyById('graduate_immediate');
  const minAgeMs = Math.max(0, Number(strat?.min_graduated_age_ms ?? 20_000));
  const payload = {
    mint,
    fee: null,
    signature,
    graduatedCoin: graduated.get(mint),
    trendingToken: null,
    route: 'migrate_immediate',
  };

  const runCandidate = () => {
    candidateHandler(payload).catch((err) => {
      console.log(`[migrate] candidate handler error: ${err.message}`);
    });
  };

  if (minAgeMs > 0) {
    console.log(`[migrate] check in ${minAgeMs / 1000}s (min_graduated_age_ms)`);
    setTimeout(runCandidate, minAgeMs);
  } else {
    await runCandidate();
  }
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8) continue;

    if (discMatch(data, DISC_DIST_FEES)) {
      try {
        await handleFeeClaim(parseDistFees(data), signature);
      } catch (error) {
        console.log(`[fee] parse/alert failed: ${error.message}`);
      }
    }

    if (GRADUATE_IMMEDIATE_ENABLED && discMatch(data, DISC_CREATE_POOL)) {
      try {
        await handleMigrateEvent(data, signature);
      } catch (e) {
        console.log(`[migrate] handler error: ${e.message}`);
      }
    }
  }
}

export function startWebsocket() {
  const wsUrl = SOLANA_WS_URL;
  let ws;
  let pingTimer;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('[ws] connected');
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log('[ws] closed, reconnecting in 5s');
      setTimeout(connect, 5000);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
}
