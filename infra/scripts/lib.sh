APPLY=0
for arg in "$@"; do
  [ "$arg" = "--apply" ] && APPLY=1
done

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
COMPOSE="docker compose -f $ROOT/infra/docker-compose.prod.yml"

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "would run: $*"
  fi
}

finish_note() {
  [ "$APPLY" = "1" ] || echo "Dry run. Add --apply to make these changes."
}
