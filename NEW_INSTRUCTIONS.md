# Windsurf SWE Agent — Implementasi Strategi `graduate_immediate` v2
## 7 Enhancement dari Diskusi Strategi

---

## WAJIB DIBACA SEBELUM MULAI

### Aturan Agent
1. **Baca dokumen ini sepenuhnya sebelum membuka file apapun.**
2. **Jangan ubah fungsi yang tidak disebutkan** — semua perubahan additive kecuali yang diberi label `REPLACE`.
3. **Setiap blok `BEFORE` harus ditemukan persis seperti tertulis** sebelum diubah. Jika tidak ketemu exact match, `grep -n` dulu, laporkan hasilnya, jangan asumsikan.
4. **Jalankan `node --check <file>` setelah setiap file.** Jangan lanjut jika ada syntax error.
5. **Jangan tambahkan import yang sudah ada.** Grep dulu sebelum menambah.
6. **Ikuti urutan langkah.** Ada dependensi antar file.

### Konteks Kode yang Sudah Ada — Pahami Dulu
```
PIPELINE (tidak berubah, hanya diperluas):
  Migrate event → handleMigrateEvent() → candidateHandler()
    → buildCandidate() → filterCandidate() → handleApprovedBuy()
      → executeLiveBuy() → [posisi terbuka]
        → monitorPositions() [setInterval] → refreshPosition()
          → exit via TP / SL / TRAILING / MAX_HOLD

PNL CALCULATION (sudah ada, benar secara matematis):
  pnlPercent = (currentMcap / entryMcap - 1) * 100
  BEP = ketika pnlPercent = 0.0 (sudah benar secara formula)

PARTIAL TP (sudah ada di positions.js):
  Saat pnlPercent >= strat.partial_tp_at_percent:
    → sell partial_tp_sell_percent% dari token_amount_raw
    → set partial_tp_done = 1
    → sisa token tetap open, dipantau TP/SL/trailing

POSITION MONITORING (sudah ada):
  monitorPositions() → loop semua open positions
    → refreshPosition() per posisi (call fetchJupiterAsset per mint)
    → exit jika SL/TP/TRAILING/MAX_HOLD tercapai
```

### Yang Akan Ditambahkan (7 Enhancement)
```
E1 → 3-layer exit: partial TP 65% @+50%, moonbag 35% dengan trailing
E2 → Balance-aware dynamic sizing berdasarkan saldo & open positions
E3 → Guard data integrity: null safety, stale data, entry mcap validation
E4 → Smooth execution: skip enrichment, priority fee, processed commitment
E5 → Batch price monitoring: satu call untuk semua open positions
E6 → BEP tracker: deteksi dump→recovery, adjust SL ke 0 setelah partial TP
E7 → MCAP floor $35K, filter MCAP band ketat untuk pola pump post-migrate
```

---

## FILE MAP — SETIAP LANGKAH

| Langkah | File | Enhancement |
|---------|------|-------------|
| 1 | `src/db/connection.js` | E1, E6, E7 — seed strategi final + kolom baru |
| 2 | `src/enrichment/jupiter.js` | E5 — tambah batchFetchPrices |
| 3 | `src/execution/positions.js` | E1, E3, E5, E6 — monitoring + exit logic |
| 4 | `src/execution/router.js` | E2, E4 — dynamic sizing + smooth execution |
| 5 | `src/pipeline/candidateBuilder.js` | E3, E7 — filter MCAP baru |
| 6 | `src/telegram/commands.js` | E2 — daftarkan keys baru |
| 7 | VALIDASI AKHIR | — |

---

## LANGKAH 1 — `src/db/connection.js`

### Tujuan
Tiga sub-tugas: (A) tambah kolom baru di schema, (B) update seed `graduate_immediate`, (C) pastikan kolom `lowest_mcap_after_entry` tersedia.

---

### 1A — Tambah kolom schema baru

**Cari blok `ensureColumn` yang sudah ada (sekitar baris 202–210):**
```javascript
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
```

**Tambahkan tepat SETELAH baris `ensureColumn('dry_run_positions', 'partial_tp_done', ...)` :**
```javascript
  // Kolom untuk BEP tracker dan balance-aware sizing
  ensureColumn('dry_run_positions', 'lowest_mcap_after_entry', 'REAL');
  ensureColumn('dry_run_positions', 'dump_then_recovered', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'sl_moved_to_bep', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'dynamic_size_sol', 'REAL');
```

---

### 1B — Update seed `graduate_immediate`

Dua kemungkinan situasi:
- **DB baru** (belum ada strategi): `INSERT OR IGNORE` akan memasukkan baris baru ✓
- **DB lama** (strategi sudah ada): `INSERT OR IGNORE` akan diabaikan → perlu update manual

Untuk handle keduanya, cari blok seed `graduate_immediate` yang sudah ada dari implementasi sebelumnya:

```javascript
  stratInsert.run('graduate_immediate', 'Graduate Immediate', 0, JSON.stringify({
```

**Ganti SELURUH blok tersebut (dari `stratInsert.run('graduate_immediate'` sampai `), Date.now());`) dengan versi baru ini:**

```javascript
  stratInsert.run('graduate_immediate', 'Graduate Immediate', 0, JSON.stringify({
    // ── Signal & entry ───────────────────────────────────────────────────────
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 1_800_000,          // max 30 menit sejak token launch

    // ── MCAP filter — disesuaikan dengan pola $35K+ (E7) ───────────────────
    // Token di bawah $35K jarang bergerak ke $50K+
    // Token di atas $80K sudah terlambat untuk risk/reward optimal
    min_mcap_usd: 35_000,
    max_mcap_usd: 80_000,

    // ── Fee filters ──────────────────────────────────────────────────────────
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,

    // ── Holder & liquidity filters ───────────────────────────────────────────
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    min_liquidity_usd: 8_000,             // pool harus ada $8K+ agar exit smooth

    // ── Graduate age & ATH ───────────────────────────────────────────────────
    min_graduated_age_ms: 0,
    max_graduated_age_ms: 3_600_000,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,

    // ── Trending filters ─────────────────────────────────────────────────────
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.4,
    trending_max_bundler_rate: 0.5,

    // ── Dynamic sizing (E2) — overrides ini jika dynamic sizing aktif ────────
    position_size_sol: 0.1,               // fallback jika balance tidak terbaca
    max_open_positions: 3,

    // ── EXIT STRUCTURE 3-LAYER (E1) ──────────────────────────────────────────
    //
    // LAYER 1 — Partial TP @+50%: jual 65% posisi → lock profit awal
    //   Setelah partial TP: SL otomatis dipindah ke 0% (BEP)
    //   Sisa 35% menjadi moonbag
    partial_tp: true,
    partial_tp_at_percent: 50,
    partial_tp_sell_percent: 65,
    //
    // LAYER 2 — TP full @+120%: jual SEMUA sisa moonbag jika target tercapai
    //   Ini jarang trigger jika trailing aktif (trailing exit duluan)
    tp_percent: 120,
    sl_percent: -25,
    //
    // LAYER 3 — Trailing moonbag: trailing 28% dari high water mark
    //   Contoh: moonbag naik ke +200%, trailing exit di +144%
    //   Jika tidak naik, trailing masih melindungi dari dump besar
    trailing_enabled: true,
    trailing_percent: 28,
    //
    // Hard exit setelah 4 jam — beri waktu moonbag untuk bernafas
    max_hold_ms: 14_400_000,

    // ── LLM — off untuk kecepatan ───────────────────────────────────────────
    use_llm: false,
    llm_min_confidence: 0,
  }), Date.now());

  // Update strategi yang sudah ada di DB (untuk DB lama yang sudah punya record)
  // Ini aman karena hanya update config_json, tidak mengubah struktur tabel
  db.prepare(`
    UPDATE strategies
    SET config_json = ?, name = 'Graduate Immediate'
    WHERE id = 'graduate_immediate'
      AND config_json NOT LIKE '%"min_mcap_usd":35000%'
  `).run(JSON.stringify({
    entry_mode: 'immediate', min_source_count: 1, require_fee_claim: false,
    token_age_max_ms: 1_800_000, min_mcap_usd: 35_000, max_mcap_usd: 80_000,
    min_fee_claim_sol: 0, min_gmgn_total_fee_sol: 0, min_holders: 0,
    max_top20_holder_percent: 100, min_saved_wallet_holders: 0,
    min_liquidity_usd: 8_000, min_graduated_age_ms: 0,
    max_graduated_age_ms: 3_600_000, max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0, trending_min_volume_usd: 0,
    trending_min_swaps: 0, trending_max_rug_ratio: 0.4,
    trending_max_bundler_rate: 0.5, position_size_sol: 0.1,
    max_open_positions: 3, partial_tp: true, partial_tp_at_percent: 50,
    partial_tp_sell_percent: 65, tp_percent: 120, sl_percent: -25,
    trailing_enabled: true, trailing_percent: 28, max_hold_ms: 14_400_000,
    use_llm: false, llm_min_confidence: 0,
  }));
```

### Validasi
```bash
node --check src/db/connection.js
```

---

## LANGKAH 2 — `src/enrichment/jupiter.js`

### Tujuan (E5)
Tambah fungsi `batchFetchPrices` yang mengambil harga untuk banyak mint sekaligus dalam satu HTTP request, menghindari rate limit saat banyak posisi open.

### Cari lokasi eksport di akhir file
```bash
grep -n "^export {" src/enrichment/jupiter.js
```

### Perubahan A — Tambah fungsi batchFetchPrices

**Cari fungsi `fetchSolUsdPrice` (sudah ada):**
```javascript
async function fetchSolUsdPrice() {
```

**Tambahkan fungsi baru SETELAH `fetchSolUsdPrice` (setelah closing `}` fungsi tersebut):**

```javascript
/**
 * Batch price fetch: ambil harga untuk banyak mint dalam SATU HTTP request.
 * Jauh lebih efisien daripada memanggil fetchJupiterAsset per posisi.
 *
 * Gunakan untuk monitoring posisi — bukan untuk enrichment kandidat.
 *
 * Return: Map<mint, { usdPrice, mcap, liquidity }> atau Map kosong jika gagal.
 *
 * Rate limit: Jupiter price v3 mendukung banyak ids, tapi batasi max 20 mint
 * per request untuk menghindari timeout dan response terlalu besar.
 */
export async function batchFetchPrices(mints) {
  if (!mints || mints.length === 0) return new Map();

  // Batasi 20 mint per request
  const BATCH_SIZE = 20;
  const result = new Map();

  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const chunk = mints.slice(i, i + BATCH_SIZE);
    try {
      const ids = chunk.join(',');
      const res = await axios.get(`https://lite-api.jup.ag/price/v3?ids=${ids}`, {
        timeout: 8_000,
        headers: JSON_HEADERS,
      });
      const data = res.data || {};
      for (const mint of chunk) {
        const row = data[mint];
        if (row) {
          result.set(mint, {
            usdPrice: Number(row.usdPrice ?? 0),
            // price/v3 tidak return mcap langsung — hitung dari usdPrice × supply jika ada
            // fallback: gunakan cached asset data untuk mcap
            mcap: null,
            liquidity: null,
            source: 'price_v3',
            fetchedAt: Date.now(),
          });
        }
      }
    } catch (err) {
      // Jangan throw — gunakan cached data yang sudah ada
      if (err.response?.status !== 429) {
        console.log(`[batch-price] chunk ${i}–${i + chunk.length}: ${err.response?.status || ''} ${err.message}`);
      }
      // Untuk mint yang gagal di batch ini, akan fallback ke per-asset fetch
    }
  }

  return result;
}
```

### Perubahan B — Pastikan `batchFetchPrices` ada di export

**Cari baris export di akhir file:**
```javascript
export {
  fetchJupiterAsset,
  ...
};
```

Tambahkan `batchFetchPrices` ke list export. Atau jika sudah pakai `export async function` langsung (maka sudah di-export via keyword `export` di definisi fungsi), tidak perlu ubah.

### Validasi
```bash
node --check src/enrichment/jupiter.js
```

---

## LANGKAH 3 — `src/execution/positions.js`

### Tujuan
Lima sub-tugas: (A) import batchFetchPrices, (B) perbaiki monitorPositions untuk batch pricing, (C) tambah null safety di refreshPosition, (D) implementasi BEP tracker, (E) SL move ke BEP setelah partial TP.

---

### 3A — Tambah import batchFetchPrices

**Cari baris import dari jupiter.js (pasti ada):**
```javascript
import { fetchJupiterAsset, ... } from '../enrichment/jupiter.js';
```

Tambahkan `batchFetchPrices` ke destructuring import tersebut.

---

### 3B — Perbaiki monitorPositions dengan batch pricing (E5)

**Temukan fungsi `monitorPositions` (di akhir file). Fungsi ini sekarang:**
```javascript
export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
```

**REPLACE seluruh fungsi `monitorPositions` dengan versi baru:**

```javascript
export async function monitorPositions() {
  const positions = openPositions();
  if (positions.length === 0) return;

  // E5: Batch price fetch — satu request untuk semua posisi open
  // Jauh lebih efisien dari N request terpisah yang berisiko rate limit
  const mints = [...new Set(positions.map(p => p.mint))];
  let batchPrices = new Map();
  try {
    batchPrices = await batchFetchPrices(mints);
  } catch (err) {
    // Batch gagal → fallback ke per-position fetch di refreshPosition
    console.log(`[monitor] batch price fetch failed, falling back per-position: ${err.message}`);
  }

  // Wallet PnL untuk live positions (sudah ada, tidak diubah)
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey).catch(err => {
      console.log(`[monitor] wallet pnl fetch failed: ${err.message}`);
      return {};
    });
  }

  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;

    // Inject batch price data ke refreshPosition untuk menghindari call duplikat
    const cachedBatchPrice = batchPrices.get(position.mint) || null;

    const result = await refreshPosition(position, {
      autoExit: true,
      jupiterPnl,
      cachedBatchPrice,
    }).catch((err) => {
      console.log(`[position] ${position.id} refresh error: ${err.message}`);
      return null;
    });

    if (result?.exitReason) await sendPositionExit(result);
  }
}
```

---

### 3C — Tambah null safety dan BEP tracker di `refreshPosition` (E3, E6)

**Temukan fungsi `refreshPosition`. Baris pertamanya:**
```javascript
export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
```

**REPLACE signature fungsi ini (hanya baris signature, tidak isinya):**
```javascript
export async function refreshPosition(position, { autoExit = true, jupiterPnl = null, cachedBatchPrice = null } = {}) {
```

**Temukan blok pengambilan asset di awal fungsi:**
```javascript
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
```

**REPLACE blok tersebut dengan versi baru (null-safe + batch price support):**

```javascript
  // E5: gunakan cached batch price jika tersedia, fallback ke per-asset fetch
  let asset = null;
  if (cachedBatchPrice) {
    // Batch price hanya punya usdPrice — perlu asset untuk mcap
    // Gunakan cache Jupiter yang sudah ada (fetchJupiterAsset punya internal cache 20s)
    asset = await fetchJupiterAsset(position.mint, { useCache: true, ttlMs: 15_000 });
    // Override price dengan data batch yang lebih fresh jika ada
    if (cachedBatchPrice.usdPrice > 0 && asset) {
      asset = { ...asset, usdPrice: cachedBatchPrice.usdPrice };
    }
  } else {
    asset = await fetchJupiterAsset(position.mint);
  }

  // E3: Null safety — gunakan last known data jika asset tidak terbaca
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap  = firstPositiveNumber(asset?.market_cap, asset?.mcap, asset?.fdv,
                                    position.high_water_mcap, position.entry_mcap);

  // E3: Validasi entryMcap — harus finite dan positif untuk PnL yang benar
  const entryMcap = Number(position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(entryMcap) || entryMcap <= 0) {
    // Data tidak valid — skip cycle ini, jangan exit paksa
    console.log(`[position] ${position.id} mcap data invalid (mcap=${mcap} entryMcap=${entryMcap}), skipping`);
    return null;
  }

  // E6: BEP tracker — catat lowest mcap untuk deteksi dump→recovery
  const currentMcap = Number(mcap);
  const prevLowest  = Number(position.lowest_mcap_after_entry || entryMcap);
  const lowestMcap  = Math.min(prevLowest, currentMcap);
  const dumpPercent = (lowestMcap / entryMcap - 1) * 100; // negatif = sudah dump

  // Tandai dump→recovery: token pernah dump > 10% lalu recover ke atas entry
  const pnlAtCurrentMcap = (currentMcap / entryMcap - 1) * 100;
  const dumpThenRecovered = !position.dump_then_recovered
    && dumpPercent < -10        // sudah dump lebih dari -10%
    && pnlAtCurrentMcap >= 0;   // sekarang sudah di atas BEP

  // Update tracking columns di DB
  db.prepare(`
    UPDATE dry_run_positions
    SET lowest_mcap_after_entry = ?,
        dump_then_recovered = CASE WHEN ? THEN 1 ELSE dump_then_recovered END
    WHERE id = ?
  `).run(lowestMcap, dumpThenRecovered ? 1 : 0, position.id);

  if (dumpThenRecovered) {
    console.log(`[position] ${position.id} dump→recovery detected. Was at ${dumpPercent.toFixed(1)}%, now at BEP+`);
  }
```

**Setelah blok di atas, lanjutkan menemukan baris `pnlPercent`:**
```javascript
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
```

**REPLACE satu baris tersebut dengan:**
```javascript
  // E6: PnL dihitung dari entry_mcap yang direkam saat buy confirmed
  // pnlPercent = 0 adalah BEP — sudah benar secara formula
  let pnlPercent = (currentMcap / entryMcap - 1) * 100;
```

---

### 3D — SL move ke BEP setelah partial TP (E6)

**Temukan blok partial TP check (pasti ada):**
```javascript
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
```

**Tambahkan kode SL-move SETELAH baris `db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1...').run(...)` :**

```javascript
    // E6: Setelah partial TP, pindahkan SL ke BEP (0%)
    // Ini melindungi moonbag dari reversal besar — modal awal sudah aman
    const currentSlInTpSlRules = db.prepare(
      'SELECT sl_percent FROM tp_sl_rules WHERE position_id = ? ORDER BY updated_at_ms DESC LIMIT 1'
    ).get(position.id);
    const currentSl = Number(currentSlInTpSlRules?.sl_percent ?? position.sl_percent);
    if (currentSl < 0 && !position.sl_moved_to_bep) {
      // Pindah SL ke 0% (BEP) — moonbag tidak akan rugi dari modal awal
      db.prepare(`
        UPDATE tp_sl_rules SET sl_percent = 0, updated_at_ms = ? WHERE position_id = ?
      `).run(now(), position.id);
      db.prepare(`
        UPDATE dry_run_positions SET sl_moved_to_bep = 1 WHERE id = ?
      `).run(position.id);
      console.log(`[position] ${position.id} SL moved to BEP (0%) after partial TP`);
    }
```

**Selanjutnya, pastikan pembacaan `sl_percent` untuk exit check membaca dari `tp_sl_rules` bukan dari `position.sl_percent`:**

**Cari baris ini:**
```javascript
  const slHit = pnlPercent <= Number(position.sl_percent);
```

**REPLACE dengan:**
```javascript
  // E6: Baca SL dari tp_sl_rules (bisa sudah dipindah ke BEP setelah partial TP)
  const activeSlRule = db.prepare(
    'SELECT sl_percent FROM tp_sl_rules WHERE position_id = ? ORDER BY updated_at_ms DESC LIMIT 1'
  ).get(position.id);
  const activeSl = Number(activeSlRule?.sl_percent ?? position.sl_percent);
  const slHit = pnlPercent <= activeSl;
```

### Validasi
```bash
node --check src/execution/positions.js
```

---

## LANGKAH 4 — `src/execution/router.js`

### Tujuan (E2, E4)
Balance-aware dynamic sizing: hitung position size berdasarkan saldo wallet aktual dan jumlah posisi yang sudah open.

---

### 4A — Tambah fungsi computeDynamicPositionSize

**Cari import di atas file:**
```javascript
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
```

Pastikan `openPositionCount` diimport dari positions.js:
```bash
grep -n "openPositionCount" src/execution/router.js
```

Jika belum ada, tambahkan ke import dari `'../db/positions.js'`:
```javascript
import { createLivePosition, canOpenMorePositions, openPositionCount } from '../db/positions.js';
```

**Tambahkan fungsi baru SETELAH semua baris import, sebelum fungsi `executeLiveBuy`:**

```javascript
/**
 * E2: Hitung position size secara dinamis berdasarkan saldo wallet aktual
 * dan jumlah posisi yang sudah open.
 *
 * Tier sizing (% dari saldo tersedia):
 *   0 posisi open → 20% saldo (agresif, belum ada risiko lain)
 *   1 posisi open → 15% saldo (kurangi exposure)
 *   2 posisi open → 10% saldo (lebih konservatif)
 *   3+ posisi open → 7% saldo (defensive)
 *
 * Hard limits:
 *   Minimum: 0.05 SOL (di bawah ini tidak worth it karena fee)
 *   Maximum: config.position_size_sol × 3 (tidak boleh jauh dari config)
 *   Reserve: selalu sisakan 0.05 SOL untuk gas fee
 *
 * @param {number} balanceLamports - saldo wallet saat ini dalam lamports
 * @param {object} strat - active strategy config
 * @returns {number} position size dalam lamports
 */
export function computeDynamicPositionSize(balanceLamports, strat) {
  const SOL = 1_000_000_000;
  const GAS_RESERVE_LAMPORTS = 0.05 * SOL;           // sisakan untuk gas
  const MIN_POSITION_LAMPORTS = 0.05 * SOL;           // minimum 0.05 SOL
  const configSizeSol = strat.position_size_sol ?? 0.1;
  const MAX_POSITION_LAMPORTS = configSizeSol * 3 * SOL; // max 3x config

  const availableLamports = balanceLamports - GAS_RESERVE_LAMPORTS;
  if (availableLamports <= MIN_POSITION_LAMPORTS) {
    // Saldo tidak cukup — gunakan config default, biarkan balance check di bawah handle
    return Math.floor(configSizeSol * SOL);
  }

  // Tier berdasarkan jumlah posisi open saat ini
  const openCount = openPositionCount();
  const tierFractions = [0.20, 0.15, 0.10, 0.07];
  const fraction = tierFractions[Math.min(openCount, tierFractions.length - 1)];

  const dynamicLamports = Math.floor(availableLamports * fraction);

  // Clamp: tidak kurang dari minimum, tidak lebih dari maximum
  const finalLamports = Math.max(
    MIN_POSITION_LAMPORTS,
    Math.min(MAX_POSITION_LAMPORTS, dynamicLamports)
  );

  const finalSol = finalLamports / SOL;
  console.log(`[sizing] open=${openCount}, balance=${(balanceLamports/SOL).toFixed(3)} SOL, tier=${(fraction*100).toFixed(0)}%, size=${finalSol.toFixed(4)} SOL`);

  return finalLamports;
}
```

---

### 4B — Gunakan dynamic sizing di executeLiveBuy

**Cari baris ini di `executeLiveBuy` (pasti ada, sekitar baris 20):**
```javascript
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
```

**REPLACE dengan:**
```javascript
  // E4: Baca balance dulu untuk dynamic sizing
  const balance = await liveWalletBalanceLamports();

  // E2: Dynamic sizing berdasarkan saldo dan open positions
  const amountLamports = computeDynamicPositionSize(balance, strat);

  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Have ${fmtSol(balance / 1_000_000_000)} SOL, need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`);
  }

  // Rekam dynamic size untuk analisis post-trade
  const dynamicSizeSol = amountLamports / 1_000_000_000;
```

**Cari baris ini (masih di executeLiveBuy, setelah swap):**
```javascript
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
```

**REPLACE dengan:**
```javascript
  // Rekam dynamic_size_sol ke posisi untuk analisis
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  if (positionId && dynamicSizeSol) {
    db.prepare('UPDATE dry_run_positions SET dynamic_size_sol = ? WHERE id = ?')
      .run(dynamicSizeSol, positionId);
  }
```

**PENTING:** Pastikan `db` diimport di router.js:
```bash
grep -n "^import.*db\|from.*connection" src/execution/router.js
```
Jika belum ada, tambahkan:
```javascript
import { db } from '../db/connection.js';
```

### Validasi
```bash
node --check src/execution/router.js
```

---

## LANGKAH 5 — `src/pipeline/candidateBuilder.js`

### Tujuan (E7)
Pastikan filter MCAP $35K sudah ada dan ada log yang jelas ketika filter ini block kandidat.

### Verifikasi filter yang sudah ada
```bash
grep -n "min_mcap_usd\|market cap min\|market cap max" src/pipeline/candidateBuilder.js
```

Filter MCAP sudah ada di `filterCandidate`. Cukup verifikasi tidak ada perubahan yang dibutuhkan di sini — seed strategi di Langkah 1 sudah set `min_mcap_usd: 35_000`.

### Perubahan opsional — perkuat pesan error filter MCAP

**Cari baris ini:**
```javascript
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
```

**REPLACE dengan versi lebih informatif:**
```javascript
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    const mcapStr = Number.isFinite(mcap) ? `$${Math.round(mcap).toLocaleString()}` : 'unknown';
    failures.push(`market cap min: ${mcapStr} < $${strat.min_mcap_usd.toLocaleString()} (token too small for expected pump pattern)`);
  }
```

### Validasi
```bash
node --check src/pipeline/candidateBuilder.js
```

---

## LANGKAH 6 — `src/telegram/commands.js`

### Tujuan
Daftarkan key baru `lowest_mcap_after_entry`, `dump_then_recovered`, `sl_moved_to_bep` sebagai info-only (tidak di-set via `/stratset`), dan pastikan `min_liquidity_usd` ada di numKeys.

### Cek numKeys
```bash
grep -n "min_liquidity_usd\|min_graduated_age_ms\|max_graduated_age_ms" src/telegram/commands.js
```

Jika belum ada, tambahkan ke `numKeys` Set (dari instruksi sebelumnya). Pastikan ini ada:
```javascript
'min_graduated_age_ms', 'max_graduated_age_ms', 'min_liquidity_usd',
```

### Tambah key dynamic_size_sol ke numKeys untuk `/stratset`
```bash
grep -n "numKeys" src/telegram/commands.js
```

Cari Set `numKeys` dan tambahkan jika belum ada:
```javascript
'position_size_sol',  // sudah ada
// tambahkan jika belum ada:
'max_open_positions',
```

### Validasi
```bash
node --check src/telegram/commands.js
```

---

## LANGKAH 7 — VALIDASI AKHIR

### Step 1 — Syntax check semua file yang diubah
```bash
node --check src/db/connection.js
node --check src/enrichment/jupiter.js
node --check src/execution/positions.js
node --check src/execution/router.js
node --check src/pipeline/candidateBuilder.js
node --check src/telegram/commands.js
```

### Step 2 — npm run check
```bash
npm run check
```

### Step 3 — Verifikasi kolom baru ada di DB
```bash
node -e "
import('./src/db/connection.js').then(({ db, initDb }) => {
  initDb();
  const cols = db.prepare(\"PRAGMA table_info(dry_run_positions)\").all();
  const names = cols.map(c => c.name);
  const required = ['lowest_mcap_after_entry', 'dump_then_recovered', 'sl_moved_to_bep', 'dynamic_size_sol'];
  required.forEach(col => {
    console.log(col + ': ' + (names.includes(col) ? 'OK' : 'MISSING'));
  });
});
"
```

### Step 4 — Verifikasi strategi di DB
```bash
node -e "
import('./src/db/connection.js').then(({ db, initDb }) => {
  initDb();
  const strat = db.prepare(\"SELECT * FROM strategies WHERE id = 'graduate_immediate'\").get();
  if (strat) {
    const c = JSON.parse(strat.config_json);
    console.log('min_mcap_usd:', c.min_mcap_usd, '(harus 35000)');
    console.log('partial_tp_sell_percent:', c.partial_tp_sell_percent, '(harus 65)');
    console.log('trailing_percent:', c.trailing_percent, '(harus 28)');
    console.log('sl_percent:', c.sl_percent, '(harus -25)');
    console.log('max_hold_ms:', c.max_hold_ms, '(harus 14400000 = 4 jam)');
  } else {
    console.log('TIDAK DITEMUKAN — initDb belum berjalan atau INSERT gagal');
  }
});
"
```

### Step 5 — Test bot start
```bash
node index.js
```

Expected log:
```
[bot] Charon started (server mode: ...)   atau  (standalone mode)
[bot] graduate_immediate: WebSocket migrate listener enabled
[ws] connected
```

---

## SETUP USER SETELAH IMPLEMENTASI

**Edit `.env` (bukan .env.example):**
```bash
GMGN_ENABLED=false
TWITTER_ENABLED=false
GRADUATE_IMMEDIATE_ENABLED=true
GRADUATED_POLL_MS=5000
POSITION_CHECK_MS=5000
SKIP_FRESH_REENRICHMENT_MS=8000
TRADING_MODE=dry_run
```

**Restart bot, lalu di Telegram:**
```
/strategy graduate_immediate
/mode dry_run
/agent on
/status
```

---

## LOGIKA TRADING YANG SUDAH DIIMPLEMENTASIKAN — RINGKASAN

### Exit Structure (E1)
```
Token graduate → BOT BELI (entryMcap direkam)
    │
    ├─ Harga naik ke +50% dari entry
    │     → Jual 65% posisi (partial TP layer 1)
    │     → SL otomatis dipindah ke 0% (BEP)
    │     → Sisa 35% = moonbag
    │
    ├─ Moonbag naik terus (misal +200%):
    │     → Trailing 28% dari high water mark
    │     → Contoh: naik ke +200%, high water = 3x entry
    │     → Trailing exit di 3x × (1 - 0.28) = 2.16x = +116% dari entry
    │     → User bisa manual exit jika mau hold lebih lama
    │
    ├─ Moonbag kena SL (jika harga balik ke BEP = 0%):
    │     → Jual sisa moonbag di 0% (modal awal aman, profit sudah di layer 1)
    │
    ├─ Moonbag kena TP full +120% (jarang — trailing biasanya lebih dulu):
    │     → Jual semua sisa
    │
    └─ Max hold 4 jam → exit apapun kondisinya
```

### Dynamic Sizing (E2)
```
Sebelum beli: baca saldo wallet aktual
  Saldo: 2 SOL, 0 posisi open → size = 2 × 20% = 0.4 SOL
  Saldo: 2 SOL, 1 posisi open → size = 2 × 15% = 0.3 SOL
  Saldo: 2 SOL, 2 posisi open → size = 2 × 10% = 0.2 SOL
  Saldo: 2 SOL, 3+ posisi open → size = 2 × 7% = 0.14 SOL
  Hard floor: 0.05 SOL | Hard cap: config × 3
```

### BEP Awareness (E6)
```
T+0:  Bot beli di entryMcap = $40K (pnlPercent = 0%)
T+5:  Harga turun ke $30K (pnlPercent = -25% → SL HIT → JUAL)
      [Skenario normal — SL melindungi]

T+0:  Bot beli di entryMcap = $40K
T+2:  Harga turun ke $34K (pnlPercent = -15% → belum SL)
T+5:  Harga recover ke $42K (pnlPercent = +5% → BEP tracker: dump_then_recovered = 1)
      Bot tahu ini adalah recovery, bukan pertama kali naik
T+10: Harga +50% → Partial TP → SL dipindah ke 0%
      Moonbag aman dari kehilangan modal
```

### Batch Monitoring (E5)
```
DULU (N posisi = N API call):
  monitorPositions() → loop 3 posisi → 3x fetchJupiterAsset() → rate limit risk

SEKARANG (N posisi = 1 batch call + N cache hit):
  monitorPositions() → batchFetchPrices([mint1, mint2, mint3]) → 1 HTTP request
    → refreshPosition(pos1, cachedBatchPrice=data1) → fetchJupiterAsset(cache hit)
    → refreshPosition(pos2, cachedBatchPrice=data2) → fetchJupiterAsset(cache hit)
    → refreshPosition(pos3, cachedBatchPrice=data3) → fetchJupiterAsset(cache hit)
```

---

## QUERY ANALISIS DRY RUN

```sql
-- Jalankan di: sqlite3 charon.sqlite

-- Statistik lengkap dengan BEP tracker
SELECT
  id, symbol,
  ROUND(pnl_percent, 1) as pnl_pct,
  exit_reason,
  dump_then_recovered,
  sl_moved_to_bep,
  ROUND(lowest_mcap_after_entry / entry_mcap * 100 - 100, 1) as max_drawdown_pct,
  ROUND(dynamic_size_sol, 4) as actual_size_sol,
  ROUND((closed_at_ms - opened_at_ms) / 60000.0, 1) as hold_min
FROM dry_run_positions
WHERE strategy_id = 'graduate_immediate'
  AND status = 'closed'
ORDER BY closed_at_ms DESC
LIMIT 30;

-- Win rate dan EV per tier
SELECT
  CASE
    WHEN dump_then_recovered = 1 THEN 'dump_recovered'
    ELSE 'clean_entry'
  END as entry_type,
  COUNT(*) as trades,
  ROUND(AVG(pnl_percent), 1) as avg_pnl,
  ROUND(100.0 * SUM(CASE WHEN pnl_percent > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
FROM dry_run_positions
WHERE strategy_id = 'graduate_immediate' AND status = 'closed'
GROUP BY entry_type;
```