/**
 * inscription-lookup.js
 *
 * Resolves the EXACT pending transfer-inscription UTXO for a given
 * token/owner, so it never has to be hand-copied into swap opts.
 * That hand-copy step is the single riskiest part of the whole flow —
 * get the wrong UTXO and either the swap fails, or worse, a generic
 * wallet later coin-selects the same UTXO by accident and burns the
 * tokens (the exact failure mode Zecscriptions' own FAQ warns about).
 *
 * IMPORTANT — read before wiring this up:
 * Zecscriptions does not publish a documented public indexer API.
 * I did not find real endpoints to call, and I'm not going to guess at
 * URLs and hardcode them — a wrong guess here either fails loudly (fine)
 * or, worse, silently returns something that looks plausible and isn't.
 * This module is therefore written against a small pluggable interface
 * instead of a hardcoded API. Two ways to fill it in:
 *
 *   1. If Zecscriptions has an undocumented API their own frontend calls,
 *      find the real request (browser devtools network tab against
 *      zecscriptions.com while browsing your own wallet/token) and wire
 *      it into ZecscriptionsHttpIndexer below — currently a stub.
 *   2. Run your own minimal indexer (the feasibility report already
 *      flagged this as needed regardless — see "New components required").
 *      LocalIndexer below reads from a simple local store you control.
 *
 * Either implementation just needs to satisfy the IndexerClient interface.
 */

'use strict';

/**
 * @typedef {object} PendingTransfer
 * @property {string} txid
 * @property {number} vout
 * @property {string} tick        - ZRC-20 ticker
 * @property {string} amount      - transfer amount as inscribed (string, exact)
 * @property {string} ownerAddress
 * @property {number} [inscribedAtHeight]
 * @property {number} [valueZatoshis] - the UTXO's actual ZEC value (dust), needed
 *                                      to fill inscriptionDustValueZec in buildSwapTx
 */

/**
 * Interface every indexer backend implements. Throw, don't return null/undefined,
 * on ambiguous or missing data — a silent wrong answer here is worse than a crash.
 */
class IndexerClient {
  /**
   * @param {string} ownerAddress
   * @param {string} tick
   * @returns {Promise<PendingTransfer[]>} all currently-spendable transfer
   *          inscriptions this address owns for this ticker, unspent only.
   */
  async listPendingTransfers(ownerAddress, tick) {
    throw new Error('Not implemented — see class doc');
  }

  /**
   * @param {string} ownerAddress
   * @param {string} tick
   * @returns {Promise<string>} confirmed balance, as a decimal string
   */
  async getBalance(ownerAddress, tick) {
    throw new Error('Not implemented — see class doc');
  }
}

/**
 * Stub for a real Zecscriptions HTTP API, if/when real endpoints are found.
 * Every method below throws until baseUrl + real paths are filled in —
 * deliberately, so this fails loudly instead of silently returning nothing.
 */
class ZecscriptionsHttpIndexer extends IndexerClient {
  constructor({ baseUrl }) {
    super();
    if (!baseUrl) throw new Error('ZecscriptionsHttpIndexer requires baseUrl once real endpoints are confirmed');
    this.baseUrl = baseUrl;
  }

  async listPendingTransfers(ownerAddress, tick) {
    throw new Error(
      'ZecscriptionsHttpIndexer.listPendingTransfers is a stub — no confirmed public ' +
      'Zecscriptions API endpoint is known. Fill this in only after capturing the real ' +
      'request from their frontend, and verify the response shape matches PendingTransfer.'
    );
  }

  async getBalance(ownerAddress, tick) {
    throw new Error('ZecscriptionsHttpIndexer.getBalance is a stub — see listPendingTransfers comment.');
  }
}

/**
 * Minimal local indexer: reads pre-scanned inscription state from a JSON
 * store you maintain (e.g. produced by your own chain-scanning process).
 * This is intentionally simple — a real implementation should replace the
 * flat-file store with a proper DB once you're past the PoC stage, but the
 * interface it exposes stays the same either way.
 *
 * Expected store shape:
 * {
 *   "transfers": [
 *     { "txid": "...", "vout": 0, "tick": "MNGO", "amount": "1000",
 *       "ownerAddress": "t1...", "spent": false, "inscribedAtHeight": 123456,
 *       "valueZatoshis": 1000 }
 *   ]
 * }
 */
class LocalIndexer extends IndexerClient {
  constructor({ store }) {
    super();
    if (!store) throw new Error('LocalIndexer requires a store implementing get(): Promise<{transfers: []}>');
    this.store = store;
  }

  async listPendingTransfers(ownerAddress, tick) {
    const data = await this.store.get();
    return (data.transfers || []).filter(
      (t) => t.ownerAddress === ownerAddress && t.tick === tick && t.spent === false
    );
  }

  async getBalance(ownerAddress, tick) {
    const transfers = await this.listPendingTransfers(ownerAddress, tick);
    // NOTE: this only sums *pending transfer inscriptions*, not the address's
    // full confirmed ZRC-20 balance (which also includes untransferred mint
    // balance). A real indexer tracks both separately — don't conflate them
    // when this graduates past the PoC.
    return transfers.reduce((sum, t) => sum + BigInt(t.amount), 0n).toString();
  }
}

/**
 * Resolves the single UTXO to use as sellerInscriptionUtxo in buildSwapTx().
 * Throws on zero matches (nothing to sell) AND on multiple matches, rather
 * than silently picking one — silently picking is exactly the kind of
 * auto-selection behavior that causes accidental burns elsewhere in this
 * protocol. Caller must disambiguate explicitly if there's more than one.
 *
 * @param {IndexerClient} indexer
 * @param {object} opts
 * @param {string} opts.ownerAddress - seller's address
 * @param {string} opts.tick
 * @param {string} [opts.exactAmount] - required if the seller has multiple
 *        pending transfers of the same ticker, to disambiguate which one
 * @returns {Promise<{txid: string, vout: number, valueZatoshis: number, amount: string}>}
 */
async function resolveSellerInscriptionUtxo(indexer, opts) {
  const { ownerAddress, tick, exactAmount } = opts;
  if (!ownerAddress || !tick) {
    throw new Error('resolveSellerInscriptionUtxo requires ownerAddress and tick');
  }

  const candidates = await indexer.listPendingTransfers(ownerAddress, tick);

  if (candidates.length === 0) {
    throw new Error(
      `No pending transfer-inscription found for ${ownerAddress} / ${tick}. ` +
      `The seller needs to inscribe a transfer first — this UTXO doesn't exist until they do.`
    );
  }

  let matches = candidates;
  if (exactAmount !== undefined) {
    matches = candidates.filter((c) => c.amount === String(exactAmount));
    if (matches.length === 0) {
      throw new Error(
        `No pending transfer of exactly ${exactAmount} ${tick} for ${ownerAddress}. ` +
        `Available amounts: ${candidates.map((c) => c.amount).join(', ')}`
      );
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `Ambiguous: ${matches.length} pending transfer-inscriptions match ${ownerAddress} / ${tick}` +
      (exactAmount !== undefined ? ` / amount ${exactAmount}` : '') +
      `. Pass exactAmount, or a more specific selector, to disambiguate. Refusing to guess.`
    );
  }

  const chosen = matches[0];
  return {
    txid: chosen.txid,
    vout: chosen.vout,
    valueZatoshis: chosen.valueZatoshis,
    amount: chosen.amount,
  };
}

module.exports = {
  IndexerClient,
  ZecscriptionsHttpIndexer,
  LocalIndexer,
  resolveSellerInscriptionUtxo,
};
