# Graduate Immediate — exit & speed (implemented)

## Exit (diskusi Sonnet + preferensi user)

| Setting | Nilai | Efek |
|---------|-------|------|
| `partial_tp_at_percent` | 50 | Jual sebagian saat +50% |
| `partial_tp_sell_percent` | 65 | Ambil modal (~65% posisi) |
| `moonbag_on_partial_tp` | true | Setelah partial TP, posisi **ditutup** (`MOONBAG`), bot **tidak** monitor sisa |
| `trailing_enabled` + `early_trail_arm_pct` | true / 15 | Trailing 20% aktif dari +15% **sebelum** partial TP (kurangi roundtrip $40–50K → SL) |
| `max_mcap_usd` | 0 | Tanpa plafon mcap (OG runner) |

Sisa ~35% token tetap di wallet — pantau manual (GMGN). Notif Telegram menyertakan link mint.

## Kecepatan migrate → swap

- `buildCandidate` route `migrate_immediate`: Jupiter asset + holders **parallel**, skip chart/Twitter/saved wallets.
- `filterCandidate`: sync only (~ms), tidak memblok swap.
- `handleApprovedBuy`: skip re-enrichment jika kandidat &lt; `SKIP_FRESH_REENRICHMENT_MS` (default 8s).

Bottleneck utama tetap Jupiter HTTP + konfirmasi Solana, bukan filter JS.

## DB lama

Saat `initDb()`, `patchGraduateImmediateStrategyConfig()` meng-update baris `graduate_immediate` yang sudah ada.

Restart bot sekali setelah `git pull`.
