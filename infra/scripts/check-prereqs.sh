#!/bin/sh
set -eu
. "$(dirname "$0")/lib.sh"

failures=0
check() {
  if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}

check "docker engine" "docker info"
check "compose plugin" "docker compose version"
check "gVisor runtime" "docker info --format '{{json .Runtimes}}' | grep -q runsc"
check "production env file" "test -f '$ROOT/infra/production.env'"
check "INLET_DOMAIN set" "test -n '${INLET_DOMAIN:-}'"
check "ACME_EMAIL set" "test -n '${ACME_EMAIL:-}'"
check "POSTGRES_PASSWORD set" "test -n '${POSTGRES_PASSWORD:-}'"
check "FIXTURE_CONTROL_TOKEN set" "test -n '${FIXTURE_CONTROL_TOKEN:-}'"
check "EGRESS_CONTROL_TOKEN set" "test -n '${EGRESS_CONTROL_TOKEN:-}'"
check "DOCKER_GID set" "test -n '${DOCKER_GID:-}'"
check "inference key present" "grep -qE '^VULTR_INFERENCE_API_KEY=.+' '$ROOT/infra/production.env'"
[ -e /dev/kvm ] && echo "note  /dev/kvm is present" || echo "note  /dev/kvm is absent, gVisor uses its systrap platform"

[ "$failures" -eq 0 ] || { echo "$failures prerequisite(s) missing."; exit 1; }
echo "All prerequisites met."
