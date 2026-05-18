import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { decideCandidateBatch } from '../src/pipeline/llm.js';

initDb();

const mask = (v) => (v ? `set (${String(v).length} chars)` : 'MISSING');
console.log('--- LLM config (no secrets) ---');
console.log('ENABLE_LLM:', ENABLE_LLM);
console.log('LLM_API_KEY:', mask(LLM_API_KEY));
console.log('LLM_BASE_URL:', LLM_BASE_URL);
console.log('LLM_MODEL:', LLM_MODEL);
console.log('LLM_TIMEOUT_MS:', LLM_TIMEOUT_MS);

if (!ENABLE_LLM) {
  console.log('\nFAIL: ENABLE_LLM is false');
  process.exit(1);
}
if (!LLM_API_KEY) {
  console.log('\nFAIL: LLM_API_KEY not set in .env');
  process.exit(1);
}

console.log('\n--- Test 1: minimal chat/completions ---');
const t0 = Date.now();
try {
  const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    model: LLM_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Return strict JSON only: {"ok":true,"message":"pong"}' },
      { role: 'user', content: 'ping' },
    ],
  }, {
    timeout: LLM_TIMEOUT_MS,
    headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
  });
  const content = res.data?.choices?.[0]?.message?.content ?? '';
  console.log('HTTP status:', res.status);
  console.log('Latency ms:', Date.now() - t0);
  console.log('Response preview:', content.slice(0, 200));
  console.log('Test 1: PASS');
} catch (e) {
  console.log('Test 1: FAIL');
  console.log('Error:', e.response?.status, e.response?.data?.error?.message || e.message);
  if (e.response?.data) console.log('Body:', JSON.stringify(e.response.data).slice(0, 500));
  process.exit(1);
}

console.log('\n--- Test 2: decideCandidateBatch (mock candidate) ---');
const mockRow = {
  id: 999,
  candidate: {
    token: { mint: 'TestMint11111111111111111111111111111111pump', name: 'TEST', symbol: 'TST' },
    signals: { route: 'fee_graduated_trending', hasFee: true, hasGraduated: true, hasTrending: true },
    metrics: { marketCapUsd: 50000, priceUsd: 0.001, liquidityUsd: 10000, holderCount: 500 },
    feeClaim: { distributedSol: 2.5 },
    trending: { rank: 5, volume: 100000, swaps: 200, rug_ratio: 0.1, bundler_rate: 0.2 },
    graduation: { ageMs: 3600000 },
    holders: { total: 500 },
    chart: { distanceFromAthPercent: 15, topBlastRisk: false },
    filters: { passed: true, failures: [] },
  },
};
const t1 = Date.now();
const decision = await decideCandidateBatch([mockRow], 999);
console.log('Latency ms:', Date.now() - t1);
console.log('Verdict:', decision.verdict);
console.log('Confidence:', decision.confidence);
console.log('Reason:', (decision.reason || '').slice(0, 120));
console.log('Risks:', (decision.risks || []).join(', ') || '(none)');
if (decision.reason?.includes('LLM failed') || decision.risks?.includes('llm_error')) {
  console.log('Test 2: FAIL (LLM error path)');
  process.exit(1);
}
if (decision.reason?.includes('LLM disabled') || decision.risks?.includes('no_llm_decision')) {
  console.log('Test 2: FAIL (disabled/missing key)');
  process.exit(1);
}
console.log('Test 2: PASS');
console.log('\nAll LLM tests passed.');
