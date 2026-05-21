# Windsurf Agent — Implementasi HQS (Holder Quality Score) Filter
## Charon Solana Trading Bot

---

## WAJIB DIBACA SEBELUM MULAI

1. Baca dokumen ini sepenuhnya sebelum membuka file apapun.
2. Semua perubahan bersifat additive — tidak ada logika existing yang dihapus.
3. Setiap blok `BEFORE` harus ditemukan persis di file sebelum diubah. Jika tidak ketemu, grep dulu dan laporkan.
4. Jalankan `node --check <file>` setelah setiap file selesai.
5. Jangan tambahkan import yang sudah ada — grep dulu.

---

## KONTEKS — APA YANG DILAKUKAN

Menambahkan sistem filter **Holder Quality Score (HQS)** yang mendeteksi:
- Bundler cluster: banyak wallet kecil dengan jumlah seragam (pola CATTER)
- Dev wallet tersembunyi: satu wallet pegang lebih dari 15–25% supply
- Top-5 concentration tinggi dikombinasikan bundler rate tinggi

**Yang TIDAK diblokir (false positive dicegah):**
- Pool address (Pumpswap, Raydium) yang pegang besar tapi bundler_rate rendah
- Token baru migrate yang belum banyak holder

**Tidak ada API call baru** — semua dari `fetchJupiterHolders()` dan `trending.bundler_rate` yang sudah ada.
Komputasi pure sync JavaScript, latency < 1ms.

---

## FILE YANG DIMODIFIKASI

| File | Perubahan |
|------|-----------|
| `src/pipeline/candidateBuilder.js` | Tambah fungsi `computeHolderQualityScore` + filter baru |
| `src/db/connection.js` | Tambah `min_holder_quality_score` ke seed `graduate_immediate` |
| `src/telegram/commands.js` | Tambah key baru ke `numKeys` untuk `/stratset` |

---

## LANGKAH 1 — `src/pipeline/candidateBuilder.js`

### Tujuan
Dua sub-tugas: (A) tambah fungsi `computeHolderQualityScore`, (B) tambah pemanggilan filter di `filterCandidate`.

---

### 1A — Tambah fungsi `computeHolderQualityScore`

**Cari baris ini (fungsi `filterCandidate` pasti ada, temukan baris pertamanya):**
```javascript
export function filterCandidate(candidate) {
```

**Tambahkan fungsi baru SEBELUM `export function filterCandidate` (di luar fungsi, bukan di dalamnya):**

```javascript
/**
 * Menghitung Holder Quality Score (HQS) untuk mendeteksi bundler cluster,
 * dev wallet tersembunyi, dan konsentrasi holder yang tidak wajar.
 *
 * Score: 0–100. Semakin tinggi = distribusi holder lebih sehat.
 * Threshold degen: 40 (hanya block yang jelas-jelas buruk)
 * Threshold strict: 55 (lebih selektif)
 *
 * Tidak ada API call baru — semua dari data yang sudah di-fetch.
 *
 * Logika utama:
 *   CEK 1 — Bundler cluster: holder rank 2–15 punya % seragam (CV rendah)
 *   CEK 2 — Single wallet dominan: >15% DAN bukan pool (bundler_rate tinggi atau pool_ratio rendah)
 *   CEK 3 — Top-5 concentration DAN bundler_rate sedang-tinggi
 *   CEK 4 — bundler_rate langsung sebagai signal
 */
function computeHolderQualityScore(candidate) {
  const holders   = candidate.holders;
  const top20     = holders?.top20 ?? [];
  const bundRate  = Number(candidate.trending?.bundler_rate ?? candidate.metrics?.bundlerRate ?? 0);
  const liqUsd    = Number(candidate.metrics?.liquidityUsd ?? 0);
  const mcapUsd   = Math.max(Number(candidate.metrics?.marketCapUsd ?? 1), 1);
  const flags     = [];
  let   penalty   = 0;

  // Jika tidak ada data holder, return score netral (jangan block karena data tidak ada)
  if (!top20 || top20.length < 3) {
    return { score: 60, flags: ['no_holder_data'] };
  }

  // ─── CEK 1: Bundler cluster ──────────────────────────────────────────────
  // Ambil holder rank 2–15 (skip rank 1 karena bisa pool)
  // Hitung coefficient of variation (CV) dari distribusi persentase
  // CV rendah + avg tinggi = distribusi seragam = tanda bundler
  const midPcts = top20
    .slice(1, 15)
    .map(h => Number(h.percent ?? 0))
    .filter(p => p > 0.3); // hanya yang meaningful

  if (midPcts.length >= 5) {
    const avg = midPcts.reduce((a, b) => a + b, 0) / midPcts.length;
    const variance = midPcts.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / midPcts.length;
    const cv = avg > 0 ? Math.sqrt(variance) / avg : 99;

    // CV < 0.45 (sangat seragam) + avg > 1.5% + minimal 7 wallet = pola bundler
    if (cv < 0.45 && avg > 1.5 && midPcts.length >= 7) {
      penalty += 35;
      flags.push('uniform_cluster');
    }
    // CV rendah tapi tidak terlalu banyak wallet = warning lebih ringan
    else if (cv < 0.35 && avg > 2.0 && midPcts.length >= 5) {
      penalty += 20;
      flags.push('mod_uniform_cluster');
    }
  }

  // ─── CEK 2: Single wallet dominan ────────────────────────────────────────
  // Top holder > 15%: bisa dev wallet ATAU pool AMM
  // Bedakan dengan: bundler_rate rendah + pool_ratio tinggi = kemungkinan pool = aman
  const topPct    = Number(top20[0]?.percent ?? 0);
  const poolRatio = liqUsd / mcapUsd; // rasio liquidity vs mcap

  if (topPct > 15) {
    // Jika bundler_rate > 0.20 ATAU pool_ratio < 0.12 → bukan pool, kemungkinan dev
    if (bundRate > 0.20 || poolRatio < 0.12) {
      penalty += 30;
      flags.push('high_single_holder');
    }
    // Jika topPct > 30% dan bundler_rate sedang → sangat mencurigakan
    if (topPct > 30 && bundRate > 0.10) {
      penalty += 15;
      flags.push('extreme_single_holder');
    }
    // Jika bundRate rendah DAN poolRatio tinggi → ini pool address → tidak penalty
  }

  // ─── CEK 3: Top-5 concentration (kecuali rank 1) ─────────────────────────
  // Hanya flag jika dikombinasikan dengan bundler_rate sedang-tinggi
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

  // ─── CEK 4: bundler_rate langsung ────────────────────────────────────────
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
```

---

### 1B — Tambah pemanggilan filter di `filterCandidate`

**Cari blok filter liquidity yang sudah ada dari implementasi sebelumnya:**
```javascript
  // Liquidity minimum — filter token yang praktis tidak bisa dijual
  if (strat.min_liquidity_usd > 0) {
    const liquidityUsd = Number(candidate.metrics?.liquidityUsd ?? 0);
    if (liquidityUsd < strat.min_liquidity_usd) {
      failures.push(`liquidity: $${liquidityUsd.toFixed(0)} < $${strat.min_liquidity_usd}`);
    }
  }
```

**Tambahkan blok baru SETELAH blok liquidity tersebut:**

```javascript
  // HQS — Holder Quality Score filter
  // Mendeteksi bundler cluster, dev wallet, konsentrasi tidak wajar
  // Tidak ada API call baru — semua dari data holder yang sudah ada
  if (strat.min_holder_quality_score > 0 && candidate.holders) {
    const hqs = computeHolderQualityScore(candidate);
    if (hqs.score < strat.min_holder_quality_score) {
      const flagStr = hqs.flags.length ? ` (${hqs.flags.join(', ')})` : '';
      failures.push(`holder quality: ${hqs.score}/100 < ${strat.min_holder_quality_score}${flagStr}`);
    }
  }
```

### Validasi
```bash
node --check src/pipeline/candidateBuilder.js
```

---

## LANGKAH 2 — `src/db/connection.js`

### Tujuan
Tambah field `min_holder_quality_score` ke seed strategi `graduate_immediate` dan UPDATE untuk DB lama.

### Perubahan — Tambah ke seed `graduate_immediate`

**Cari field ini di dalam seed `graduate_immediate` (pasti ada dari implementasi sebelumnya):**
```javascript
    min_liquidity_usd: 8_000,
```

**Tambahkan satu baris baru SETELAH baris `min_liquidity_usd`:**
```javascript
    min_holder_quality_score: 40,   // degen: hanya block bundler parah (CATTER~20, dev hold~35)
```

**Juga update statement SQL UPDATE yang ada (untuk DB lama).**

Cari baris ini di dalam blok UPDATE existing:
```javascript
  db.prepare(`
    UPDATE strategies
    SET config_json = ?, name = 'Graduate Immediate'
    WHERE id = 'graduate_immediate'
      AND config_json NOT LIKE '%"min_mcap_usd":35000%'
  `).run(JSON.stringify({
```

Di dalam JSON yang di-pass ke `.run(JSON.stringify({...}))`, tambahkan field baru:
```javascript
    min_holder_quality_score: 40,
```

Pastikan field ini masuk di antara field lain yang sudah ada, tidak perlu urutan tertentu.

### Validasi
```bash
node --check src/db/connection.js
```

---

## LANGKAH 3 — `src/telegram/commands.js`

### Tujuan
Daftarkan `min_holder_quality_score` ke `numKeys` agar user bisa mengubahnya via `/stratset graduate_immediate min_holder_quality_score 55`.

### Perubahan — Tambah ke numKeys Set

**Cari Set `numKeys` yang sudah ada (sudah ditambahkan dari implementasi sebelumnya):**
```javascript
'min_graduated_age_ms', 'max_graduated_age_ms', 'min_liquidity_usd',
```

**Tambahkan `'min_holder_quality_score'` ke baris tersebut:**
```javascript
'min_graduated_age_ms', 'max_graduated_age_ms', 'min_liquidity_usd', 'min_holder_quality_score',
```

### Validasi
```bash
node --check src/telegram/commands.js
```

---

## LANGKAH 4 — VALIDASI AKHIR

```bash
node --check src/pipeline/candidateBuilder.js
node --check src/db/connection.js
node --check src/telegram/commands.js
npm run check
```

---

## VERIFIKASI DI TELEGRAM SETELAH RESTART

```
/status
/stratset graduate_immediate min_holder_quality_score 40
```

**Log yang diharapkan saat ada kandidat dengan bundler cluster:**
```
[candidate] filtered AbCdEfGh... holder quality: 20/100 < 40 (uniform_cluster, high_bundler_rate)
```

**Log yang diharapkan saat kandidat lolos:**
```
[candidate] AbCdEfGh... passed all filters
```

---

## CARA TUNE THRESHOLD

Gunakan `/stratset` setelah melihat dry-run log:

```bash
# Degen (default) — hanya block yang jelas-jelas bundler
/stratset graduate_immediate min_holder_quality_score 40

# Lebih selektif — juga block dev hold yang lebih ringan
/stratset graduate_immediate min_holder_quality_score 50

# Strict — untuk strategi sniper/smart_money
/stratset graduate_immediate min_holder_quality_score 60

# Matikan filter (debug / semua masuk)
/stratset graduate_immediate min_holder_quality_score 0
```

---

## REFERENSI SCORE TIAP POLA

| Token | Pola | Score estimasi | Hasil dengan threshold 40 |
|-------|------|----------------|--------------------------|
| CATTER | Bundler cluster seragam | ~20 | BLOCKED |
| Dev hold | Satu wallet > 25% | ~35 | BLOCKED |
| bean | Pool 19.86% + bundler rendah | ~70 | PASS |
| Organik (Ayaan) | Tersebar merata | ~80 | PASS |
| Token baru tanpa data | Kurang dari 3 holder terdeteksi | 60 (netral) | PASS |

---

## RINGKASAN PERUBAHAN

| File | Baris ditambah | Jenis |
|------|----------------|-------|
| `src/pipeline/candidateBuilder.js` | ~65 baris | Additive — fungsi baru + 1 filter |
| `src/db/connection.js` | ~2 baris | Additive — 1 field di seed + 1 field di UPDATE |
| `src/telegram/commands.js` | ~1 baris | Additive — 1 key di numKeys |

**Total: ~68 baris. Tidak ada logika existing yang dihapus atau diubah.**
