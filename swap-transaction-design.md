# Atomic ZEC ↔ ZRC-20 Swap — Transaction Design

Companion to `zecscriptions-launchpad-feasibility.md`. This covers exactly how the 1:1 non-custodial swap (Architecture A) is constructed, signed, and broadcast.

## Correction from the feasibility report

The report mentioned multisig for the swap itself — that's not needed. Multisig (`OP_CHECKMULTISIG`, P2SH) is only required later for **shared pool custody** (multiple people/keys jointly controlling reserve funds). For a plain 1:1 swap between two known parties, each party just signs their **own input** with their **own key**, over a transaction both have agreed on. Standard P2PKH, no multisig address involved. Simpler, fewer moving parts, less to get wrong.

## Why this doesn't need CLTV/CSV

Confirmed in the last research pass: no timelocks on Zcash Script. This design doesn't need them — it's not an HTLC. It's a **single transaction with multiple independently-signed inputs**, which either broadcasts complete (both legs happen) or never exists at all (nothing happens). There's no intermediate locked state to time out of. The only failure mode is "counterparty never sends their signature back" — which just means the trade never happened, not that funds are stuck.

## Transaction shape

```
INPUTS:
  [0] Seller's transfer-inscription UTXO   (the specific UTXO tagged by the
                                             indexer as carrying N tokens)
  [1..k] Buyer's ZEC UTXO(s)                (enough to cover price + fee)

OUTPUTS:
  [0] value = inscription-dust value  → scriptPubKey = buyer's address
      (this is what the indexer reads as "tokens transferred to buyer")
  [1] value = agreed price in ZEC     → scriptPubKey = seller's address
  [2] value = buyer's change (if any) → scriptPubKey = buyer's change address
```

Order matters for output [0] only insofar as your indexer's convention for reading transfer-inscription spends needs to be consistent — confirm against the actual Zecscriptions indexer rules (or your own, if you build a parallel one) exactly which output position / address it treats as the recipient of a spent transfer-inscription UTXO before relying on this.

## Sighash choice

Use **SIGHASH_ALL** for both inputs. This is deliberate: it commits each signer to the *entire* transaction — every input and every output. Neither party can swap out an output address or change an amount after the other has signed, because doing so invalidates the first signature. This is the correct choice for a fixed-price trade where both sides need certainty about the whole deal, not just their own leg.

(SIGHASH_SINGLE|ANYONECANPAY is the right tool for order-book-style trades where a maker pre-signs an offer against *any* eventual taker — worth revisiting once you build a listing/order-book UI, but not needed for the first direct-swap PoC.)

## RPC-driven build flow (no hand-rolled serialization)

Zcash transparent transactions use the same UTXO/Script model as Bitcoin, and `zcashd` exposes the same raw-transaction RPC surface. Building the swap through RPC avoids re-implementing wire-format encoding (v5/NU5 transaction encoding is non-trivial — sapling/orchard fields exist even in transparent-only txs and are easy to get subtly wrong by hand).

1. **`createrawtransaction`** — either party (or a coordinating service) builds the unsigned skeleton: the two inputs (seller's inscription UTXO, buyer's ZEC UTXO(s)) and the three outputs above.
2. **Seller runs `signrawtransactionwithkey`** on that raw hex, supplying only their own private key. Result: their input's scriptSig is filled in; the buyer's input is left empty. `complete: false` in the response — expected.
3. **Buyer runs `signrawtransactionwithkey`** on the *same original unsigned hex* (not the seller's partially-signed copy), supplying only their key.
4. **`combinerawtransaction`** — merge the two partial signatures into one fully-signed transaction.
5. **`sendrawtransaction`** — broadcast. If both signatures are valid and every input's referenced UTXO is still unspent, it confirms like any normal transaction.

If instead you sign sequentially (buyer signs the seller's already-partially-signed hex rather than the original), `signrawtransactionwithkey` will simply leave the existing scriptSig alone and fill in its own — either order works, `combinerawtransaction` isn't strictly required if signing sequentially, but doing it in parallel (both sign the original independently, then combine) means neither party needs to trust the other with an intermediate signed copy, which is the better default.

## Practical concerns before running this on real value

- **UTXO selection must be exact** on the seller's side — it must select *specifically* the transfer-inscription UTXO, never let generic coin selection touch it. This is the same footgun Zecscriptions' own FAQ warns about, now on the build side instead of the wallet side.
- **Confirm the indexer's read rule** for which output of a multi-output transaction counts as "recipient of the transferred tokens" — get this wrong and the swap broadcasts fine but the indexer doesn't credit the buyer.
- **Fee** must be covered by the buyer's ZEC input beyond the agreed price (or split by convention) — decide and document this before building the UI so quoted prices match what actually gets broadcast.
- Test entirely on **testnet** first, with your own or the public Zecscriptions indexer (if it indexes testnet) before any mainnet value touches this code path.

## Next artifact

`zec-swap.js` in the same output — a small Node script implementing steps 1–5 above against a `zcashd` RPC endpoint (testnet by default), so this can be run directly from your Codespaces terminal against a node you control.
