#!/bin/bash
set -e

UNSIGNED_HEX=$(cat unsigned-tx.hex)
SELLER_WIF=$(cat ~/secrets/seller.wif | tr -d '[:space:]')
SELLER_SCRIPTPUBKEY="76a914d6c1b74d45429e6b14f00af3143fb49d5e53365188ac"
BUYER_SCRIPTPUBKEY="76a9149c7da21625638f55b78b0e2c088e2a3098d5fd4188ac"

echo "Key length: ${#SELLER_WIF}"
echo "First char: ${SELLER_WIF:0:1}"

zcash-cli signrawtransaction "$UNSIGNED_HEX" \
  "[{\"txid\":\"feb7e3e90eac244db4707d9aaafe74d212e4f6fddc692fabb1bd2c0beb4916f2\",\"vout\":0,\"scriptPubKey\":\"$SELLER_SCRIPTPUBKEY\"},{\"txid\":\"a169d568724bed30ed4c18816be77baf363cbb738a6c1dfb483c1173b352c4d2\",\"vout\":0,\"scriptPubKey\":\"$BUYER_SCRIPTPUBKEY\"}]" \
  "[\"$SELLER_WIF\"]" \
  > seller-signed.json

cat seller-signed.json
