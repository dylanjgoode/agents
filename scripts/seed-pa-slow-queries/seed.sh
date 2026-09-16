#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./seed.sh <cluster-domain-or-uri> <username>

Seeds an Atlas cluster with the highImpact Performance Advisor slow-query
dataset (collections dbA–dbD plus unindexed finds that generate high-impact
slow logs).

Examples:
  ./seed.sh cluster0.xxxxx.mongodb.net myDbUser
  ./seed.sh "mongodb+srv://cluster0.xxxxx.mongodb.net/" myDbUser

mongosh prompts for the password unless MONGODB_PASSWORD is set.
Requires mongosh on PATH.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 2 ]]; then
  usage
  exit 1
fi

if ! command -v mongosh >/dev/null 2>&1; then
  echo "error: mongosh is not installed or not on PATH" >&2
  exit 1
fi

cluster_or_uri=$1
username=$2

if [[ "$cluster_or_uri" == mongodb://* || "$cluster_or_uri" == mongodb+srv://* ]]; then
  uri=$cluster_or_uri
else
  uri="mongodb+srv://${cluster_or_uri}/"
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
js_file="${script_dir}/highImpactPAMockData.js"

if [[ ! -f "$js_file" ]]; then
  echo "error: missing seed script at ${js_file}" >&2
  exit 1
fi

cmd=(
  mongosh
  "$uri"
  --apiVersion 1
  --username "$username"
  --file "$js_file"
)

if [[ -n "${MONGODB_PASSWORD:-}" ]]; then
  cmd+=(--password "$MONGODB_PASSWORD")
fi

exec "${cmd[@]}"
