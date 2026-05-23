#!/usr/bin/env bash
# Graduate screening smoke test on VPS (survives SSH disconnect).
# Usage:
#   chmod +x scripts/vps-screening-smoke.sh
#   ./scripts/vps-screening-smoke.sh start
#   ./scripts/vps-screening-smoke.sh status
#   ./scripts/vps-screening-smoke.sh logs
#   ./scripts/vps-screening-smoke.sh stop

set -euo pipefail
cd "$(dirname "$0")/.."

CMD="${1:-help}"

case "$CMD" in
  start)
    git pull
    node scripts/sync-graduate-immediate-config.mjs --rugcheck-only
    node scripts/graduate-screening-daemon.mjs stop 2>/dev/null || true
    node scripts/graduate-screening-daemon.mjs start -- \
      --interval 5000 \
      --verbose \
      --confirm-pass \
      --telegram
    node scripts/graduate-screening-daemon.mjs status
    echo ""
    echo "Screening running in background. Safe to close terminal."
    echo "Logs: tail -f data/graduate-screening/collector.log"
    ;;
  status)
    node scripts/graduate-screening-daemon.mjs status
    ;;
  logs)
    tail -f data/graduate-screening/collector.log
    ;;
  stop)
    node scripts/graduate-screening-daemon.mjs stop
    echo "Screening stopped."
    ;;
  *)
    echo "Usage: $0 {start|status|logs|stop}"
    exit 1
    ;;
esac
