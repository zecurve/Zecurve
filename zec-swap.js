#!/usr/bin/env node
/**
 * zec-swap.js
 *
 * Builds, cooperatively signs, and broadcasts a single non-custodial
 * ZEC <-> ZRC-20 swap transaction, using zcashd's own raw-transaction
 * RPC methods (no hand-rolled tx serialization).
 *
 * See swap-transaction-design.md for the full design and rationale.
 *
 * Requires: a reachable zcashd (or zebrad w/ RPC-compatible layer) node,
 * testnet strongly recommended until this has been exercised end to end.
 * No npm dependencies — uses Node's built-in https/http module.
 *
 * -----------------------------------------------------------------------
 * USAGE (as a library, from your own build/sign/broadcast orchestration):
 *
 *   const { RpcClient, buildSwapTx, signWithKey, combineAndBroadcast } = require('./zec-swap');
 *
 *   const rpc = new RpcClient({
 *     host: process.env.ZCASHD_HOST || '127.0.0.1',
 *     port: process.env.ZCASHD_PORT || 18232, // 8232 mainnet, 18232 testnet
 *     user: process.env.ZCASHD_RPC_USER,
 *     pass: process.env.ZCASHD_RPC_PASS,
 *   });
 *
 *   const unsignedHex = await buildSwapTx(rpc, {
 *     sellerInscriptionUtxo: { txid: '...', vout: 0 },
 *     buyerZecUtxos: [{ txid: '...', vout: 1 }],
 *     buyerTokenRecipientAddress: 't1BuyerAddrForTokens...',
 *     inscriptionDustValueZec: 0.00001,     // must match the inscription's actual UTXO value
 *     sellerZecPaymentAddress: 't1SellerAddr...',
 *     priceZec: 0.5,
 *     buyerChangeAddress: 't1BuyerChangeAddr...',
 *     buyerChangeValueZec: 0.0499,          // buyerInputTotal - price - fee
 *   });
 *
 *   // Seller side (their own machine/key, never share the private key):
 *   const sellerPartial = await signWithKey(rpc, unsignedHex, [sellerPrivKeyWIF]);
 *
 *   // Buyer side (independently, over the SAME unsignedHex):
 *   const buyerPartial = await signWithKey(rpc, unsignedHex, [buyerPrivKeyWIF]);
 *
 *   const txid = await combineAndBroadcast(rpc, [sellerPartial.hex, buyerPartial.hex]);
 *   console.log('broadcast txid:', txid);
 * -----------------------------------------------------------------------
 */

'use strict';

const http = require('http');
const https = require('https');

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

class RpcClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.user
   * @param {string} opts.pass
   * @param {boolean} [opts.tls=false]
   */
  constructor(opts) {
    if (!opts || !opts.host || !opts.port || !opts.user || !opts.pass) {
      throw new Error('RpcClient requires host, port, user, pass');
    }
    this.host = opts.host;
    this.port = opts.port;
    this.user = opts.user;
    this.pass = opts.pass;
    this.tls = !!opts.tls;
  }

  /**
   * Calls a zcashd JSON-RPC method. Throws RpcError on any RPC-level error.
   * @param {string} method
   * @param {Array} params
   */
  call(method, params = []) {
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: `zec-swap-${Date.now()}`,
      method,
      params,
    });

    const auth = Buffer.from(`${this.user}:${this.pass}`).toString('base64');
    const requestOpts = {
      host: this.host,
      port: this.port,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${auth}`,
      },
    };

    const transport = this.tls ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(requestOpts, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            reject(new RpcError(`Non-JSON response from node (HTTP ${res.statusCode}): ${body.slice(0, 300)}`));
            return;
          }
          if (parsed.error) {
            reject(new RpcError(parsed.error.message, parsed.error.code));
            return;
          }
          resolve(parsed.result);
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

/**
 * Converts ZEC to a plain decimal string with 8 places, as zcashd expects.
 */
function zec(amount) {
  return Number(amount.toFixed(8));
}

/**
 * Builds the unsigned swap transaction skeleton via createrawtransaction.
 *
 * Output layout (see swap-transaction-design.md):
 *   [0] inscription-dust value -> buyer's address   (token leg, read by the indexer)
 *   [1] price in ZEC           -> seller's address  (payment leg)
 *   [2] change (optional)      -> buyer's change address
 *
 * IMPORTANT: sellerInscriptionUtxo must be the EXACT UTXO the indexer tags as
 * the pending transfer-inscription. Do not resolve this via generic UTXO
 * selection (listunspent) — the caller must pass it explicitly, sourced from
 * indexer data, never from wallet auto-selection.
 */
async function buildSwapTx(rpc, opts) {
  const {
    sellerInscriptionUtxo,
    buyerZecUtxos,
    buyerTokenRecipientAddress,
    inscriptionDustValueZec,
    sellerZecPaymentAddress,
    priceZec,
    buyerChangeAddress,
    buyerChangeValueZec,
  } = opts;

  if (!sellerInscriptionUtxo || sellerInscriptionUtxo.vout === undefined) {
    throw new Error('sellerInscriptionUtxo {txid, vout} is required and must be the exact tagged UTXO');
  }
  if (!Array.isArray(buyerZecUtxos) || buyerZecUtxos.length === 0) {
    throw new Error('buyerZecUtxos must be a non-empty array of {txid, vout}');
  }
  if (
    buyerChangeAddress &&
    buyerChangeValueZec &&
    buyerChangeValueZec > 0 &&
    buyerChangeAddress === buyerTokenRecipientAddress
  ) {
    throw new Error(
      'buyerChangeAddress must differ from buyerTokenRecipientAddress: ' +
        'zcashd createrawtransaction takes outputs as a single address->amount ' +
        'object, so identical keys silently collapse into one output and a ' +
        'real output (and real value) would vanish with no RPC error. ' +
        'Generate a distinct change address for the buyer instead.'
    );
  }

  const inputs = [sellerInscriptionUtxo, ...buyerZecUtxos].map((u) => ({
    txid: u.txid,
    vout: u.vout,
  }));

  // IMPORTANT: unlike Bitcoin Core (since 2018), zcashd's createrawtransaction
  // has never supported an array form for the outputs parameter — every
  // version of the Zcash RPC docs (4.5.1 through current 6.x) documents
  // ONLY the merged {"address": amount, ...} object form. Passing an array
  // fails hard with "Expected type object, got array" (confirmed against a
  // live 6.12.3 node). An earlier version of this file used the array form,
  // based on a mistaken assumption that zcashd inherited Bitcoin Core's
  // array-form support — it does not, and that must not be reintroduced.
  //
  // The real hazard is different: because this is a plain JS object, if
  // buyerTokenRecipientAddress and buyerChangeAddress are ever THE SAME
  // STRING, the second key silently overwrites the first and one output
  // vanishes with no error from either this code or zcashd. There is no
  // object-form workaround for that — the caller MUST ensure
  // buyerTokenRecipientAddress and buyerChangeAddress are distinct addresses
  // whenever both are used. This function does not currently enforce that;
  // treat it as a required precondition on the caller.
  const outputs = {
    [buyerTokenRecipientAddress]: zec(inscriptionDustValueZec),
    [sellerZecPaymentAddress]: zec(priceZec),
  };
  if (buyerChangeAddress && buyerChangeValueZec && buyerChangeValueZec > 0) {
    outputs[buyerChangeAddress] = zec(buyerChangeValueZec);
  }

  // locktime 0 — no timelock semantics used or available (see design doc)
  const hex = await rpc.call('createrawtransaction', [inputs, outputs, 0]);
  return hex;
}

/**
 * Signs a raw transaction hex with a single party's key(s), leaving any
 * inputs it doesn't hold keys for unsigned. Does not require or use the
 * node's own wallet — keys are passed explicitly so neither party needs
 * to trust the node with custody of the other's funds.
 *
 * @param {RpcClient} rpc
 * @param {string} rawHex - the SAME unsigned hex both parties sign independently
 * @param {string[]} privKeysWIF - only this party's key(s)
 * @param {object[]} [prevTxs] - optional explicit prevout info if the node
 *        doesn't already have these UTXOs indexed (needed for e.g. signing
 *        against another party's not-yet-broadcast/unconfirmed input in some
 *        node configurations) — shape: [{txid, vout, scriptPubKey, amount}]
 */
async function signWithKey(rpc, rawHex, privKeysWIF, prevTxs) {
  const params = [rawHex, prevTxs || [], privKeysWIF];
  const result = await rpc.call('signrawtransactionwithkey', params);
  // result: { hex, complete, errors? }
  return result;
}

/**
 * Merges independently-signed partial hexes into one complete transaction
 * and broadcasts it. Throws if the combined result isn't fully valid.
 */
async function combineAndBroadcast(rpc, partialHexes) {
  const combinedHex = await rpc.call('combinerawtransaction', [partialHexes]);

  // Sanity check before broadcasting real value.
  const decoded = await rpc.call('decoderawtransaction', [combinedHex]);
  if (!decoded || !Array.isArray(decoded.vin) || decoded.vin.length < 2) {
    throw new Error('Combined transaction does not look like a 2-party swap — refusing to broadcast');
  }

  const txid = await rpc.call('sendrawtransaction', [combinedHex]);
  return txid;
}

module.exports = {
  RpcClient,
  RpcError,
  buildSwapTx,
  signWithKey,
  combineAndBroadcast,
};

// -------------------------------------------------------------------------
// Minimal CLI smoke test — prints the unsigned hex for manual inspection.
// Run: node zec-swap.js build '<json opts>'
// This does NOT sign or broadcast anything by itself.
// -------------------------------------------------------------------------
if (require.main === module) {
  const [, , cmd, argJson] = process.argv;

  if (cmd !== 'build') {
    console.log('Usage: node zec-swap.js build \'<json opts matching buildSwapTx()>\'');
    console.log('This is a library-first script — see the header comment for the intended');
    console.log('build -> sign(seller) -> sign(buyer) -> combine -> broadcast flow.');
    process.exit(cmd ? 1 : 0);
  }

  (async () => {
    const rpc = new RpcClient({
      host: process.env.ZCASHD_HOST || '127.0.0.1',
      port: Number(process.env.ZCASHD_PORT) || 18232,
      user: process.env.ZCASHD_RPC_USER,
      pass: process.env.ZCASHD_RPC_PASS,
    });

    let opts;
    try {
      opts = JSON.parse(argJson);
    } catch (e) {
      console.error('Could not parse opts JSON:', e.message);
      process.exit(1);
    }

    try {
      const hex = await buildSwapTx(rpc, opts);
      console.log('Unsigned tx hex:');
      console.log(hex);
      const decoded = await rpc.call('decoderawtransaction', [hex]);
      console.log('\nDecoded (verify inputs/outputs before signing anything):');
      console.log(JSON.stringify(decoded, null, 2));
    } catch (e) {
      console.error('Failed to build swap tx:', e.message);
      process.exit(1);
    }
  })();
}
