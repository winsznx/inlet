#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

echo "Deploying $(git -C "$ROOT" rev-parse --short HEAD) to ${INLET_DOMAIN:-<INLET_DOMAIN not set>}"
run sh "$ROOT/infra/scripts/check-prereqs.sh"
run $COMPOSE --profile images build runner-browser
run $COMPOSE --profile images build runner-repair
run $COMPOSE build fixture-host
run $COMPOSE build api
run $COMPOSE build worker
run $COMPOSE build web
run $COMPOSE up -d --wait
finish_note
