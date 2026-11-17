#!/bin/sh
# Picks the config when none is given: a mounted openmeetings.config.yaml wins; otherwise the
# local profile when the Ollama service of `docker compose --profile local` is reachable, else
# cloud-cheap (which needs API keys in the environment).
set -e
if [ -z "$OM_CONFIG" ]; then
  if [ -f /app/openmeetings.config.yaml ]; then
    OM_CONFIG=/app/openmeetings.config.yaml
  elif getent hosts ollama >/dev/null 2>&1; then
    OM_CONFIG=/app/examples/local.yaml
  else
    OM_CONFIG=/app/examples/cloud-cheap.yaml
  fi
  export OM_CONFIG
fi
echo "open-meetings: config $OM_CONFIG" >&2
exec node /app/dist/main.js "$@"
