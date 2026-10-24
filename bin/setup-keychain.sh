#!/usr/bin/env bash
# One-time setup for the local factory: store its two credentials in the macOS keychain, never in files.
#   1. a Claude subscription token, from `claude setup-token` (the sandbox can't use your Mac's login)
#   2. the factory GitHub App's private key (.pem), so the factory can open PRs as the app
# The keychain item names must match "keychain" in factory.yml (defaults: factory-claude-token, factory-app-key).
# Usage: setup-keychain.sh            both
#        setup-keychain.sh --token    only the Claude token
#        setup-keychain.sh --app-key  only the app key
set -euo pipefail
what=${1:-both}
token_item=${FACTORY_TOKEN_ITEM:-factory-claude-token}
key_item=${FACTORY_KEY_ITEM:-factory-app-key}

if [[ "$what" == both || "$what" == --token ]]; then
  echo "Claude token: run 'claude setup-token' in another terminal and paste the token it prints (starts with sk-ant-)."
  read -rsp "Token: " token
  echo
  if [[ ! "$token" =~ ^sk-ant-[A-Za-z0-9_-]+$ ]]; then
    echo "That doesn't look like a Claude token (expected sk-ant-...). Nothing was stored." >&2
    exit 1
  fi
  security add-generic-password -U -a "$USER" -s "$token_item" -w "$token"
  unset token
  echo "Stored the Claude token."
fi

if [[ "$what" == both || "$what" == --app-key ]]; then
  read -rp "Path to the factory app's private key (.pem): " pem
  pem=${pem/#\~/$HOME}
  if ! grep -q 'PRIVATE KEY' "$pem" 2>/dev/null; then
    echo "$pem isn't a private key file. Nothing was stored." >&2
    exit 1
  fi
  security add-generic-password -U -a "$USER" -s "$key_item" -w "$(base64 <"$pem" | tr -d '\n')"
  echo "Stored the app key. Delete $pem now; GitHub can generate a new key if you ever need one."
fi
