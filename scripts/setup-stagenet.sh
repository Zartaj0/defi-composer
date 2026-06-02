#!/usr/bin/env bash
# setup-stagenet.sh — Set up a test environment on the contract.dev Ethereum stagenet.
#
# Usage:
#   bash scripts/setup-stagenet.sh <your-wallet-address>
#
# What it does:
#   1. Funds your wallet with 1,000 ETH + 5,000,000 USDC (direct state write via dev_setBalance)
#   2. Takes over the Gitcoin DAO Treasury Safe (real mainnet Safe, ~448 ETH + ~$2M USDC)
#      → impersonates the Safe itself, adds you as owner with threshold=1
#   3. Funds the Safe with extra ETH + USDC for testing strategies at scale
#   4. Prints MetaMask + DeFi Composer setup instructions
#
# Prerequisites:
#   - curl + python3 (both standard on macOS/Linux)
#   - STAGENET_RPC_URL env var is optional; defaults to the project RPC
#
set -euo pipefail

RPC="${STAGENET_RPC_URL:-https://rpc.contract.dev/775c3bd2d7a94c2e426551614d6de126}"
CHAIN_ID=52638

USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
SAFE="0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6"

# ── Helpers ───────────────────────────────────────────────────────────────────
red()   { echo -e "\033[0;31m$*\033[0m"; }
green() { echo -e "\033[0;32m$*\033[0m"; }
yellow(){ echo -e "\033[0;33m$*\033[0m"; }
bold()  { echo -e "\033[1m$*\033[0m"; }

rpc_raw() {
  curl -s -X POST "$RPC" \
    -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"$1\",\"params\":$2,\"id\":1}"
}

rpc_ok() {
  local out
  out=$(rpc_raw "$1" "$2")
  if echo "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' not in d else 1)" 2>/dev/null; then
    echo "$out" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null
  else
    local err
    err=$(echo "$out" | python3 -c "import sys,json; print(json.load(sys.stdin)['error'])" 2>/dev/null)
    red "  RPC error on $1: $err" >&2
    return 1
  fi
}

dev_ok() { rpc_ok "$1" "$2"; }

send_tx() {
  local out txhash
  out=$(rpc_raw "eth_sendTransaction" "$1")
  if echo "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' not in d else 1)" 2>/dev/null; then
    txhash=$(echo "$out" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null)
    rpc_raw "evm_mine" "[]" > /dev/null 2>&1 || true
    echo "$txhash"
  else
    local err
    err=$(echo "$out" | python3 -c "import sys,json; print(json.load(sys.stdin)['error'])" 2>/dev/null)
    red "  Transaction failed: $err" >&2
    return 1
  fi
}

pad_addr() { printf '%064s' "${1#0x}" | tr ' ' '0'; }

# ── Validate input ────────────────────────────────────────────────────────────
if [[ -z "${1:-}" ]]; then
  red "Usage: bash scripts/setup-stagenet.sh <your-wallet-address>"
  echo "Example: bash scripts/setup-stagenet.sh 0xYourMetaMaskAddress"
  exit 1
fi

USER_ADDR="$1"

if [[ ! "$USER_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  red "Invalid address: $USER_ADDR (expected 0x-prefixed 40-char hex)"
  exit 1
fi

bold "═══════════════════════════════════════════════════════"
bold "  DeFi Composer — contract.dev Stagenet Setup"
bold "═══════════════════════════════════════════════════════"
echo ""
echo "  Wallet  : $USER_ADDR"
echo "  RPC     : $RPC"
echo "  Chain   : Ethereum fork (ID $CHAIN_ID)"
echo ""

# ── 1. Connectivity check ─────────────────────────────────────────────────────
echo "→ Checking connection…"
BLOCK_HEX=$(rpc_ok "eth_blockNumber" "[]")
BLOCK=$(python3 -c "print(int('$BLOCK_HEX', 16))")
green "  ✓ Connected — block $BLOCK"
echo ""

# ── 2. Fund wallet ─────────────────────────────────────────────────────────────
echo "→ Funding wallet with 1,000 ETH + 5,000,000 USDC…"

# dev_setBalance: amount as decimal string in wei
ETH_WEI="1000000000000000000000"   # 1000 ETH
dev_ok "dev_setBalance" "[\"$USER_ADDR\", \"$ETH_WEI\"]" > /dev/null

# dev_setERC20Balance: amount in token's smallest unit (USDC = 6 decimals)
USDC_UNITS="5000000000000"         # 5,000,000 USDC
dev_ok "dev_setERC20Balance" "[\"$USER_ADDR\", \"$USDC\", \"$USDC_UNITS\"]" > /dev/null

ETH_BAL=$(rpc_raw "eth_getBalance" "[\"$USER_ADDR\",\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'{int(r[\"result\"],16)/1e18:.2f}')")
PADDED_USER=$(pad_addr "$USER_ADDR")
USDC_BAL=$(rpc_raw "eth_call" "[{\"to\":\"$USDC\",\"data\":\"0x70a08231$PADDED_USER\"},\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'\${int(r[\"result\"],16)/1e6:,.0f}')")
green "  ✓ ETH: $ETH_BAL  |  USDC: $USDC_BAL"
echo ""

# ── 3. Take over Gitcoin DAO Treasury Safe ────────────────────────────────────
echo "→ Taking over Gitcoin DAO Treasury Safe…"
PADDED_SAFE=$(pad_addr "$SAFE")

SAFE_ETH_BEFORE=$(rpc_raw "eth_getBalance" "[\"$SAFE\",\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'{int(r[\"result\"],16)/1e18:.1f} ETH')")
SAFE_USDC_BEFORE=$(rpc_raw "eth_call" "[{\"to\":\"$USDC\",\"data\":\"0x70a08231$PADDED_SAFE\"},\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'\${int(r[\"result\"],16)/1e6:,.0f} USDC')")
THRESH_BEFORE=$(rpc_raw "eth_call" "[{\"to\":\"$SAFE\",\"data\":\"0xe75235b8\"},\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(int(r['result'],16))")
echo "  Before: $SAFE_ETH_BEFORE | $SAFE_USDC_BEFORE | threshold $THRESH_BEFORE"

# Give the Safe ETH for the addOwnerWithThreshold gas
dev_ok "dev_setBalance" "[\"$SAFE\", \"1000000000000000000000\"]" > /dev/null

# Impersonate the Safe itself — 'authorized' modifier = msg.sender == address(this)
rpc_ok "dev_impersonateAccount" "[\"$SAFE\"]" > /dev/null

# addOwnerWithThreshold(userAddr, 1) — selector 0x0d582f13
ADD_DATA="0x0d582f13$(pad_addr "$USER_ADDR")$(printf '%064x' 1)"
send_tx "[{\"from\":\"$SAFE\",\"to\":\"$SAFE\",\"data\":\"$ADD_DATA\",\"gas\":\"0x80000\",\"gasPrice\":\"0x0\"}]" > /dev/null

rpc_ok "dev_stopImpersonatingAccount" "[\"$SAFE\"]" > /dev/null

NEW_THRESH=$(rpc_raw "eth_call" "[{\"to\":\"$SAFE\",\"data\":\"0xe75235b8\"},\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(int(r['result'],16))")
green "  ✓ You are now a Safe owner — threshold is $NEW_THRESH"

# ── 4. Fund Safe ──────────────────────────────────────────────────────────────
echo "→ Funding Safe with 1,000 ETH + 5,000,000 USDC…"
dev_ok "dev_setBalance"      "[\"$SAFE\", \"1000000000000000000000\"]" > /dev/null
dev_ok "dev_setERC20Balance" "[\"$SAFE\", \"$USDC\", \"5000000000000\"]" > /dev/null

SAFE_ETH_FINAL=$(rpc_raw "eth_getBalance" "[\"$SAFE\",\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'{int(r[\"result\"],16)/1e18:.0f}')")
SAFE_USDC_FINAL=$(rpc_raw "eth_call" "[{\"to\":\"$USDC\",\"data\":\"0x70a08231$PADDED_SAFE\"},\"latest\"]" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(f'\${int(r[\"result\"],16)/1e6:,.0f}')")
green "  ✓ Safe funded: $SAFE_ETH_FINAL ETH + $SAFE_USDC_FINAL"
echo ""

# ── 5. Print instructions ─────────────────────────────────────────────────────
bold "═══════════════════════════════════════════════════════"
bold "  ✅  Setup complete!"
bold "═══════════════════════════════════════════════════════"
echo ""
bold "Your wallet:"
echo "  Address : $USER_ADDR"
echo "  ETH     : $ETH_BAL ETH"
echo "  USDC    : $USDC_BAL"
echo ""
bold "Your Safe (Gitcoin DAO Treasury):"
echo "  Address   : $SAFE"
echo "  ETH       : $SAFE_ETH_FINAL ETH"
echo "  USDC      : $SAFE_USDC_FINAL"
echo "  Threshold : $NEW_THRESH-of-8 (you are the solo executor)"
echo ""
bold "━━━━ Step 1 — Add network to MetaMask ━━━━━━━━━━━━━━━━━"
echo "  Network name   :  Ethereum (contract.dev)"
echo "  RPC URL        :  $RPC"
echo "  Chain ID       :  $CHAIN_ID"
echo "  Currency       :  ETH"
echo "  Block Explorer :  https://etherscan.io  (read-only, for context)"
echo ""
bold "━━━━ Step 2 — Open DeFi Composer ━━━━━━━━━━━━━━━━━━━━━"
echo "  https://frontend-ten-nu-24.vercel.app"
echo "  → Connect wallet → select 'Ethereum (contract.dev)'"
echo "  → Pick 'Safe treasury' → enter $SAFE"
echo "  → Your wallet has $ETH_BAL ETH + $USDC_BAL USDC"
echo "  → Your Safe has $SAFE_ETH_FINAL ETH + $SAFE_USDC_FINAL USDC"
echo ""
bold "━━━━ Step 3 — Point executor at the stagenet ━━━━━━━━━━"
echo "  Update services/executor/.env (or your local .env):"
echo "    SAFE_ADDRESS=$SAFE"
echo "    MAINNET_RPC_URL=$RPC"
echo "    CHAIN_ID=$CHAIN_ID"
echo ""
bold "━━━━ Mainnet DeFi protocol addresses ━━━━━━━━━━━━━━━━━━"
echo "  USDC              : $USDC"
echo "  Uniswap v3 Router : 0xE592427A0AEce92De3Edee1F18E0157C05861564"
echo "  Aave v3 Pool      : 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"
echo "  Compound cUSDC    : 0x39AA39c021dfbaE8faC545936693aC917d5E7563"
echo "  Curve 3pool       : 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"
echo ""
yellow "Tip: re-run this script any time to re-fund your wallet."
yellow "     The stagenet preserves state between runs."
