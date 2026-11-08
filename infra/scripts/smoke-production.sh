#!/bin/sh
set -eu

domain="${INLET_DOMAIN:?set INLET_DOMAIN}"
base="https://$domain"

expect_ok() {
  code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$1")
  if [ "$code" = "200" ]; then echo "ok    $1"; else echo "FAIL  $1 returned $code"; exit 1; fi
}

expect_ok "$base/"
expect_ok "$base/demo"
expect_ok "$base/api/v1/health/live"
expect_ok "$base/api/v1/health/ready"
expect_ok "$base/api/v1/demo/scenarios"

headers=$(curl -sI -m 15 "$base/")
echo "$headers" | grep -qi '^strict-transport-security' || { echo "FAIL  HSTS header missing"; exit 1; }
echo "$headers" | grep -qi '^content-security-policy' || { echo "FAIL  CSP header missing"; exit 1; }
for port in 5432 6379 8025 1025 3190 3191; do
  if nc -z -w 3 "$domain" "$port" 2>/dev/null; then echo "FAIL  port $port is publicly reachable"; exit 1; fi
done
echo "Read-only production smoke passed."
