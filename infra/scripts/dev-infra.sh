#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."

COMPOSE="docker compose --env-file .env.local -f infra/docker-compose.local.yml"

$COMPOSE --profile images build runner-browser runner-repair
$COMPOSE up -d --wait --build

echo "Infrastructure is healthy:"
echo "  Mailpit        http://localhost:8025"
echo "  Working site   http://localhost:3110/contact"
echo "  Broken site    http://localhost:3111/contact"
