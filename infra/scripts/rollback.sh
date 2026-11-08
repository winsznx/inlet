#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

ref=""
for arg in "$@"; do
  [ "$arg" = "--apply" ] || ref="$arg"
done
[ -n "$ref" ] || { echo "Usage: rollback.sh [--apply] <git-ref>"; exit 2; }

git -C "$ROOT" rev-parse --verify "$ref^{commit}" >/dev/null
echo "Rolling back to $ref. Database migrations are not reversed, so check $ROOT/packages/database/drizzle first."
run git -C "$ROOT" checkout "$ref"
run sh "$ROOT/infra/scripts/deploy.sh" --apply
finish_note
