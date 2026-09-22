#!/usr/bin/env bash
# Nightly backup for Shorts Factory:
#   - a consistent copy of the SQLite database (sqlite3 .backup is safe while WAL is in use;
#     never copy the .db file with cp while the API or worker runs),
#   - the narration audio (expensive to regenerate: TTS quota).
# Renders are reproducible with a RENDER re-run and placeholder assets are regenerated, so they are
# not backed up here; add `renders/` to the rsync list if you want them too.
#
# Usage (cron, as the app user): deploy/backup.sh
# Override with environment variables: DATA_DIR, DB_FILE, BACKUP_DIR, KEEP_DAYS.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/shorts-factory}"
DATA_DIR="${DATA_DIR:-/var/lib/shorts-factory/data}"
DB_FILE="${DB_FILE:-$DATA_DIR/shorts-factory.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/shorts-factory}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%F)"

command -v sqlite3 >/dev/null || { echo "sqlite3 is required (apt install sqlite3)"; exit 1; }
[ -f "$DB_FILE" ] || { echo "database not found: $DB_FILE"; exit 1; }

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/audio"
sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/db/shorts-factory-$STAMP.db'"
if [ -d "$DATA_DIR/audio" ]; then
  rsync -a --delete "$DATA_DIR/audio/" "$BACKUP_DIR/audio/"
fi
find "$BACKUP_DIR/db" -name 'shorts-factory-*.db' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Is) backup done: $BACKUP_DIR/db/shorts-factory-$STAMP.db, audio mirrored (app dir: $APP_DIR)"
