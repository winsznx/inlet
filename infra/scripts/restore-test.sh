#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

base="${BACKUP_DIR:-$ROOT/.backups}"
latest=$(ls -1 "$base" 2>/dev/null | sort | tail -1)
[ -n "$latest" ] || { echo "No backups found in $base"; exit 1; }
echo "Restoring $latest into a throwaway database. The live database is not touched."
if [ "$APPLY" = "1" ]; then
  $COMPOSE exec -T postgres psql -U inlet -d postgres -c 'DROP DATABASE IF EXISTS inlet_restore_test'
  $COMPOSE exec -T postgres psql -U inlet -d postgres -c 'CREATE DATABASE inlet_restore_test'
  $COMPOSE exec -T postgres pg_restore -U inlet -d inlet_restore_test --no-owner < "$base/$latest/inlet.dump"
  tables=$($COMPOSE exec -T postgres psql -U inlet -d inlet_restore_test -Atc "select count(*) from information_schema.tables where table_schema='public'")
  $COMPOSE exec -T postgres psql -U inlet -d postgres -c 'DROP DATABASE inlet_restore_test'
  [ "$tables" -gt 0 ] || { echo "Restore produced no tables."; exit 1; }
  echo "Restore verified: $tables tables."
fi
finish_note
