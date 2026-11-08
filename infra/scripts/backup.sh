#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir="${BACKUP_DIR:-$ROOT/.backups}/$stamp"
echo "Backing up to $dir"
if [ "$APPLY" = "1" ]; then
  mkdir -p "$dir"
  $COMPOSE exec -T postgres pg_dump -U inlet -d inlet --format=custom > "$dir/inlet.dump"
  $COMPOSE exec -T api tar -czf - -C /data artifacts > "$dir/artifacts.tar.gz"
  (cd "$dir" && shasum -a 256 inlet.dump artifacts.tar.gz > SHA256SUMS)
  echo "Backup complete."
else
  echo "would write inlet.dump, artifacts.tar.gz and SHA256SUMS"
fi
finish_note
