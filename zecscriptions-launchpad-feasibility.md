# Zecscriptions Token Launchpad + AMM — Technical Feasibility Report

**Scope:** A standalone project, independent of any other codebase. No existing repo was provided to inspect, so this report is built from the public Zecscriptions protocol (zecscriptions.com) and Zcash's transparent-pool transaction model.

---

## 1–4. How Zecscriptions actually works

Zecscriptions is a **BRC-20-style meta-protocol**, not a smart contract system. The mechanics:

- An "inscription" is arbitrary JSON data committed inside a Zcash **transparent** transaction (t-addr only — shielded envelopes aren't supported; the data has to be plaintext-readable by every indexer).
- `deploy` inscriptions define a ticker, max supply, and per-tx mint limit. `mint` inscriptions claim supply against that limit. `transfer` inscriptions move balance between addresses.
- Critically: **a transfer inscription doesn't move value by itself.** It creates a specific, indexer-recognized UTXO. The actual transfer happens when that *specific UTXO* is later spent — the indexer watches which address receives the spent output and credits that address with the token amount. This is exactly the BRC-20/Ordinals model, inherited wholesale.
- **Zcash consensus enforces nothing about token semantics.** A node validates that ZEC UTXOs are spent correctly; it has no idea "ZRC-20" exists. The entire ledger — balances, valid transfers, valid mints — is a convention computed by an off-chain indexer replaying the chain and applying protocol rules.
- This is why Zecscriptions' own FAQ warns: if a wallet blindly coin-selects and spends a pending transfer-inscription UTXO in an unrelated payment, the tokens silently route to whoever that payment was for and are effectively burned. That's not a bug — it's the direct consequence of token state living in interpretation, not consensus.

**Answering the report's numbered questions directly:**

1. Covered above.
2. ZRC-20 balances are reconstructed by an indexer scanning transparent transactions in order, from genesis (or a snapshot), applying deploy/mint/transfer rules deterministically.
3. Transfers are two-step: inscribe a transfer intent (creates a spendable, indexer-tagged UTXO of a specific token amount), then spend that UTXO — the recipient of that spend is credited by the indexer.
4. **Enforced only by the indexer/protocol convention**, not by Zcash. Zcash enforces UTXO ownership and signatures; it does not enforce that spending a particular UTXO means "the ZRC-20 balance moves." Two independent indexers using different rule interpretations could, in principle, disagree — the "canonical" indexer is a trust point.

---

## 5. Can ZEC + ZRC-20 swaps be atomic?

This is the load-bearing question for the whole product, so the honest answer needs to be direct: **partially, with real limitations, not "no" and not "yes" without caveats.**

Zcash transparent addresses support Bitcoin-derived Script, including **P2SH and multisig** (t3 addresses, `OP_CHECKMULTISIG`) — confirmed working, real multisig transactions broadcast on Zcash mainnet today.

**CLTV and CSV are not available, confirmed directly from source.** In `zcash/src/script/script.h`, `OP_CHECKLOCKTIMEVERIFY` is literally defined as `OP_NOP2` — i.e. it's wired as a plain no-op, not the BIP65 timelock opcode. And the tracking issue for CSV/relative-timelocks (BIP68/112/113, zcash/zcash#2237, opened 2017) is **still open, never implemented** — the maintainers noted it would need a hard fork since Zcash doesn't have Bitcoin's BIP9 version-bits mechanism, and it was never prioritized. Practically: **no `nLockTime`-enforced timelocks, no relative-timelock covenants, no HTLC-style hash-timelock contracts on Zcash transparent Script.** Any design that assumed CLTV/CSV (refund timeouts, HTLC atomic-swap patterns copied from Bitcoin/Lightning) is off the table — this isn't a "verify before building," it's now a settled constraint to design around.

This actually simplifies the design in one sense: since HTLC-style swaps aren't available anyway, the multisig/co-signed-transaction pattern below (no timelock needed, just N-of-N or threshold cooperative signing) is the *only* real option, not one of several. It also means there's no trustless refund path if a co-signing counterparty goes offline mid-swap — that has to be handled by the pool signer's own operational design (e.g. a quorum that can always produce M-of-N without waiting on a single party), not by a chain-enforced timeout.

Assuming standard multisig/P2SH scripting is available (which the docs do confirm), here's what's actually achievable:

**What true atomicity would require:** a single Zcash transaction that simultaneously (a) spends the buyer's ZEC UTXO to the seller/pool, and (b) spends the specific ZRC-20 transfer-inscription UTXO to the buyer, such that either both legs execute or neither does. Standard Bitcoin-model UTXO transactions support exactly this *if* you can construct one transaction with multiple inputs from different parties, each authorizing only their own input via their own signature (a classic PSBT-style collaborative transaction). Zcash transparent transactions support multi-input, multi-signer transactions the same way Bitcoin does.

**So a peer-to-peer atomic swap (one buyer, one specific seller, one specific inscription) is achievable** using a partially-signed transaction flow:
1. Seller's transfer-inscription UTXO (token side) and buyer's ZEC UTXO are combined into one transaction.
2. Seller signs their input, sending the token UTXO's spend to the buyer's address.
3. Buyer signs their input, sending ZEC to the seller.
4. Either party broadcasts the fully-signed tx. If either refuses to sign, nothing moves — no custody, no counterparty risk, no partial execution.

This is the same trust-minimized swap pattern Ordinals/BRC-20 marketplaces use (PSBT swaps), and it maps directly onto Zcash transparent transactions.

**What this does *not* give you: an AMM.** Atomic 1:1 swaps work when there's a specific counterparty UTXO to match against. An AMM needs a *pool* that can serve arbitrary buyers against a shared reserve, continuously, without a human counterparty signing each trade. That requires either:
- A **live signer** (hot wallet or threshold/MPC signer) that co-signs pool-side inputs on demand — which reintroduces a trust/custody assumption, even if minimized via multisig/threshold signing, or
- Off-chain intent matching where the "AMM" is really an automated market maker *bot* that behaves like one counterparty in a PSBT swap, continuously re-signing against its own reserve UTXO.

There is no way to make an unattended, always-available liquidity pool fully non-custodial on a UTXO chain without contract-level state and covenants (which Zcash's transparent Script does not have — no OP_CTV, no recursive covenants, no smart-contract VM). This is a hard architectural boundary, not a implementation gap.

## 6–8. One-sided liquidity, concentrated liquidity, non-custodial control

- **One-sided token liquidity (entire supply seeded, ZEC flows in via buys):** Representable, but the "pool" is necessarily a UTXO (or UTXO set) controlled by *some* key. Whoever holds that key can move the funds. It can be a 2-of-3 multisig (protocol admin + a second party + a recovery key), reducing single-party custody risk, but it cannot be trustless in the way a Uniswap contract is trustless, because there's no contract — there's a keyholder.
- **Concentrated liquidity (Uniswap v3-style, price ranges/ticks):** This requires programmable state transitions enforced by consensus (a contract computing tick math on every swap). Zcash transparent Script cannot express this. It could be *simulated* by an indexer that computes virtual tick/price state off-chain and only settles net ZEC/token movements on-chain — but then "concentrated liquidity" is a database abstraction the indexer maintains, not something Zcash enforces. Anyone trusting the displayed price is trusting the indexer's math, not the chain.
- **Non-custodial liquidity control:** Best achievable is **threshold-signed pool custody** (e.g., 2-of-3 or t-of-n multisig where signers are protocol-controlled but distributed, plus a timelocked recovery path) combined with the atomic-swap pattern above so individual trades are self-executing once co-signed. This is "minimally trusted," not trustless.

## 9–10. Reuse vs. new components

**Reusable from Zecscriptions:** the ZRC-20 inscription standard itself (deploy/mint/transfer JSON schema), the indexer's balance-reconstruction logic, and the transparent-address wallet model.

**New components required, none of which exist today:**
- A swap-transaction constructor that builds valid multi-input PSBT-equivalent Zcash transactions pairing a ZEC input against a specific transfer-inscription UTXO.
- A pool-signer service (the trust-minimized custody piece — threshold/multisig signer that co-signs pool-side legs against a rate curve you define, e.g. constant-product math computed off-chain from current reserves).
- An extended indexer that also tracks pool reserve UTXOs, computes price/liquidity/volume, and exposes a swap-quote API.
- Chain-monitoring/reorg handling — Zcash transparent transactions can still be reorged pre-finality, so the indexer needs confirmation depth before crediting balances, meaning "instant" launch/trade UX has to be honestly represented as pending until confirmed (~75s per the Zecscriptions front end, longer for finality-sensitive amounts).

## 11–14. Security, custody, attack vectors, failure modes

- **Custody risk:** any pool design here has a keyholder (even if threshold-distributed). If Anthropic-adjacent phrasing aside — plainly: whoever controls signing quorum can theoretically drain reserves. This must be disclosed to users, not hidden behind AMM branding.
- **UTXO race/burn risk:** the same accidental-spend burn bug Zecscriptions warns about for user wallets applies doubly to a pool wallet — any tooling touching the pool's UTXOs must never let generic coin selection touch a tagged transfer-inscription UTXO.
- **Indexer-fork risk:** if two indexers disagree on state (a bug, a reorg, an ambiguous transaction), your displayed price/balances can diverge from another indexer's. There's no consensus arbitration.
- **Front-running:** because the "AMM" price is computed by a centralized-ish quote service before a swap tx is built and signed, a malicious operator (or someone who compromises the signer) could reorder or requote. Genuine trustlessness here needs published, verifiable quote logic and ideally a commit-reveal or time-bounded quote signature.
- **Failure scenario:** signer service downtime = trading halts entirely (no fallback path the way an on-chain contract keeps running). This should be planned for explicitly (e.g., a documented emergency multisig recovery process).

## 15. What is currently impossible

- A fully trustless, always-live AMM pool with no keyholder — impossible without Zcash gaining covenant/contract capability it doesn't have.
- True Uniswap-v3-style concentrated liquidity enforced by the chain — impossible for the same reason; only simulable off-chain.
- Shielded (private) inscriptions or private swaps — the Zecscriptions team's own FAQ says this is unsolved; token activity is necessarily transparent.
- Instant finality — Zcash transparent transactions need confirmation depth like any UTXO chain; "instant launch → instant trading" UX claims would be misleading without a pending/confirming state shown honestly.

---

## Architecture comparison

| | A. Native UTXO atomic swap | B. Indexer-computed deterministic AMM | C. Hybrid (recommended) |
|---|---|---|---|
| Balance tracking | Zcash UTXOs directly | Off-chain indexer state | Indexer state, anchored to real UTXO movements |
| Liquidity representation | A specific counterparty's UTXO per trade | Virtual reserves in indexer DB | Real ZEC+token reserve UTXOs, controlled by threshold signer |
| ZEC in / tokens out | Multi-input signed tx, both legs same tx | Off-chain ledger update, on-chain settlement optional/batched | Same-tx swap co-signed by pool signer against live reserve |
| Price calc | N/A (matched, not curve-priced) | Off-chain constant-product formula | Off-chain formula, but reserves are the real on-chain UTXO amounts, so price is auditable |
| Custody | None — true P2P | Full custodial (backend just credits balances) | Threshold-signed pool, not single-party custodial |
| Indexer-reconstructable | Yes, fully | No — depends on private ledger | Yes — reserves and every swap are on-chain, only the *quote curve* is off-chain math anyone can replicate |
| What's chain-enforced | Signatures, UTXO ownership | Nothing | Signatures, UTXO ownership, real reserve balances |
| What's protocol-only | N/A | Everything | Price curve, slippage math, aggregate stats |

**C is the only one that's both buildable and honest.** A is real but only supports peer-matched trades, not an always-on market. B is what "fake decentralization" looks like if you're not careful — worth naming explicitly since you flagged wanting to avoid it.

## Launch mechanism comparison

1. **Pump.fun-style bonding curve** — natural fit for architecture C: curve math lives off-chain, but every buy/sell still moves real reserve UTXOs, so it's auditable even though the curve isn't chain-enforced.
2. **Constant-product AMM** — same trust model as bonding curve, just a different formula; fine for V1 once bonding-curve graduation is reached, mirroring what you already know from AMM design elsewhere.
3. **Concentrated liquidity (v3-style)** — not worth building for V1; the complexity buys you nothing extra in trust model (still off-chain math) while adding real engineering risk and UX complexity for a UTXO-chain product.
4. **One-sided launch liquidity** — compatible with either curve above; full supply into the pool at launch, ZEC-only buy-in. This matches your stated goal and works cleanly under architecture C.
5. **Zcash-native new mechanism** — the interesting option is a bonding curve *seeded directly as a real UTXO*, where "buying" literally is the atomic swap transaction described in Architecture A/C, just quoted by a bonding-curve formula instead of a fixed price. This is really options 1+4 implemented honestly rather than a fundamentally new mechanism — that's a feature, not a shortcoming.

**Recommendation for V1:** Architecture C, bonding curve, one-sided full-supply liquidity, threshold-signed pool custody (start with 2-of-3, one key cold/offline as recovery), transparent on-chain reserves so any third party can independently verify pool state matches displayed price. Ship the trust model disclosure prominently — "reserves are held in a threshold-signed address, not a smart contract" — rather than implying full non-custodial AMM parity with Ethereum-style DEXes, since that would misrepresent what's actually enforced by Zcash versus by your backend.

---

## Suggested proof-of-concept sequence

Before any frontend work: deploy a test ZRC-20 token via the existing Zecscriptions flow (or Zcash testnet equivalent), then hand-build one raw multi-input transaction that atomically swaps a transfer-inscription UTXO for ZEC between two wallets you control, without any backend in the loop. Since CLTV/CSV are confirmed unavailable, this transaction is a straightforward N-of-N cooperative-signing construction (no timelock branch) — verify multisig/P2SH signing and broadcast behaves as expected on current mainnet before committing to the pool-signer design. If that transaction confirms and the Zecscriptions indexer (or your own minimal indexer) credits the balance correctly, you've proven Architecture A works end to end — everything else (pool custody, curve math, UI) is additive from there.

**Note on the confirmed CLTV/CSV gap:** because there's no chain-enforced timeout, the pool-signer quorum design needs its own operational safeguard against a stuck cooperative swap (e.g. a swap that's half-signed and abandoned). Since the pool side isn't waiting on an external counterparty's cooperation the way a true P2P swap is — the pool signer can always complete its own leg on demand — this mainly matters for the P2P swap pattern (Architecture A), where a counterparty could sign then vanish. Worth deciding early whether V1 needs a lightweight off-chain escrow/timeout convention (e.g., an inscription order book with expiry, enforced by the indexer/UI rather than the chain) for that case.
