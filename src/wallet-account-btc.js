// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict'

import { crypto, initEccLib, payments, Psbt } from 'bitcoinjs-lib'
import { BIP32Factory } from 'bip32'
import BigNumber from 'bignumber.js'

import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha512'

import * as bip39 from 'bip39'

import * as ecc from '@bitcoinerlab/secp256k1'

// eslint-disable-next-line camelcase
import { sodium_memzero } from 'sodium-universal'

import ElectrumClient from './electrum-client.js'

/** @typedef {import('@wdk/wallet').KeyPair} KeyPair */
/** @typedef {import('@wdk/wallet').TransactionResult} TransactionResult */
/** @typedef {import('@wdk/wallet').TransferOptions} TransferOptions */
/** @typedef {import('@wdk/wallet').TransferResult} TransferResult */

/** @typedef {import('@wdk/wallet').IWalletAccount} IWalletAccount */

/**
 * @typedef {Object} BtcTransaction
 * @property {string} to - The transaction's recipient.
 * @property {number} value - The amount of bitcoins to send to the recipient (in satoshis).
 */

/**
 * @typedef {Object} BtcWalletConfig
 * @property {string} [host] - The electrum server's hostname (default: "electrum.blockstream.info").
 * @property {number} [port] - The electrum server's port (default: 50001).
 * @property {"bitcoin" | "regtest" | "testnet"} [network] The name of the network to use (default: "bitcoin").
 */

/**
 * @typedef {Object} BtcTransfer
 * @property {string} txid - The transaction's id.
 * @property {string} address - The user's own address.
 * @property {number} vout - The index of the output in the transaction.
 * @property {number} height - The block height (if unconfirmed, 0).
 * @property {number} value - The value of the transfer (in satoshis).
 * @property {"incoming" | "outgoing"} direction - The direction of the transfer.
 * @property {number} [fee] - The fee paid for the full transaction (in satoshis).
 * @property {string} [recipient] - The receiving address for outgoing transfers.
 */

const BIP_86_BTC_DERIVATION_PATH_PREFIX = "m/86'/0'"

const DUST_LIMIT = 546

const MASTER_SECRET = Buffer.from('Bitcoin seed', 'utf8')

// Network constants for BIP32 key derivation
// Note: This is only used for BIP32 derivation, not for address encoding.
// Address encoding (including Taproot/Bech32m) uses network objects from bitcoinjs-lib
// which are obtained via ElectrumClient and support Taproot addresses:
// - Mainnet: bc1p... (Bech32m for Taproot)
// - Testnet: tb1p... (Bech32m for Taproot)
// - Regtest: bcrt1p... (Bech32m for Taproot)
const BITCOIN = {
  wif: 0x80,
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4
  },
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  pubKeyHash: 0x00,
  scriptHash: 0x05
}

const bip32 = BIP32Factory(ecc)

initEccLib(ecc)

function derivePath (seed, path) {
  const masterKeyAndChainCodeBuffer = hmac(sha512, MASTER_SECRET, seed)

  const privateKey = masterKeyAndChainCodeBuffer.slice(0, 32)
  const chainCode = masterKeyAndChainCodeBuffer.slice(32)

  const masterNode = bip32.fromPrivateKey(Buffer.from(privateKey), Buffer.from(chainCode), BITCOIN)

  const account = masterNode.derivePath(path)

  sodium_memzero(privateKey)

  sodium_memzero(chainCode)

  return { masterNode, account }
}

/** @implements {IWalletAccount} */
export default class WalletAccountBtc {
  /**
   * Creates a new bitcoin wallet account.
   *
   * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
   * @param {string} path - The BIP-86 derivation path (e.g. "0'/0/0").
   * @param {BtcWalletConfig} [config] - The configuration object.
   */
  constructor (seed, path, config) {
    if (typeof seed === 'string') {
      if (!bip39.validateMnemonic(seed)) {
        throw new Error('The seed phrase is invalid.')
      }

      seed = bip39.mnemonicToSeedSync(seed)
    }

    /** @private */
    this._path = `${BIP_86_BTC_DERIVATION_PATH_PREFIX}/${path}`

    /** @private */
    this._electrumClient = new ElectrumClient(config)

    const { masterNode, account } = derivePath(seed, this._path)

    /** @private */
    this._masterNode = masterNode

    /** @private */
    this._account = account

    // For BIP-86 single-key Taproot, use the internal public key (32-byte x-coordinate)
    // The publicKey from BIP32 is compressed (33 bytes), so we extract the 32-byte x-coordinate
    const internalPubkey = this._account.publicKey.slice(1)

    /** @private */
    this._internalPubkey = internalPubkey

    const { address } = payments.p2tr({
      internalPubkey,
      network: this._electrumClient.network
    })

    /** @private */
    this._address = address
  }

  /**
   * The derivation path's index of this account.
   *
   * @type {number}
   */
  get index () {
    return +this._path.split('/').pop()
  }

  /**
   * The derivation path of this account (see [BIP-86](https://bips.xyz/86)).
   *
   * @type {string}
   */
  get path () {
    return this._path
  }

  /**
   * The account's key pair.
   *
   * @type {KeyPair}
   */
  get keyPair () {
    return {
      privateKey: new Uint8Array(this._account.privateKey),
      publicKey: new Uint8Array(this._account.publicKey)
    }
  }

  /**
   * Returns the account's Taproot address (Bech32m format).
   *
   * Address formats:
   * - Mainnet: bc1p... (Bech32m)
   * - Testnet: tb1p... (Bech32m)
   * - Regtest: bcrt1p... (Bech32m)
   *
   * @returns {Promise<string>} The account's Taproot address.
   */
  async getAddress () {
    return this._address
  }

  /**
   * Signs a message using ECDSA signatures.
   *
   * Note: This method uses ECDSA for message signing. Transaction signing
   * uses Schnorr signatures (BIP-340) for Taproot transactions.
   *
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The message's signature (hex encoded).
   */
  async sign (message) {
    const messageHash = crypto.sha256(Buffer.from(message, 'utf8'))
    return this._account.sign(messageHash).toString('hex')
  }

  /**
   * Verifies a message's signature.
   *
   * @param {string} message - The original message.
   * @param {string} signature - The signature to verify.
   * @returns {Promise<boolean>} True if the signature is valid.
   */
  async verify (message, signature) {
    const messageHash = crypto.sha256(Buffer.from(message, 'utf8'))
    const signatureBuffer = Buffer.from(signature, 'hex')
    return this._account.verify(messageHash, signatureBuffer)
  }

  /**
   * Returns the account's bitcoin balance.
   *
   * @returns {Promise<number>} The bitcoin balance (in satoshis).
   */
  async getBalance () {
    const address = await this.getAddress()

    const { confirmed } = await this._electrumClient.getBalance(address)

    return +confirmed
  }

  /**
   * Returns the account balance for a specific token.
   *
   * @param {string} tokenAddress - The smart contract address of the token.
   * @returns {Promise<number>} The token balance (in base unit).
   */
  async getTokenBalance (tokenAddress) {
    throw new Error("The 'getTokenBalance' method is not supported on the bitcoin blockchain.")
  }

  /**
   * Sends a transaction from this Taproot address.
   *
   * Transactions are signed using Schnorr signatures (BIP-340) for Taproot inputs.
   * Taproot transactions typically have lower fees due to smaller witness sizes.
   *
   * @param {BtcTransaction} tx - The transaction.
   * @returns {Promise<TransactionResult>} The transaction's result.
   */
  async sendTransaction ({ to, value }) {
    const tx = await this._getTransaction({ recipient: to, amount: value })

    await this._electrumClient.broadcastTransaction(tx.hex)

    return {
      hash: tx.txid,
      fee: +tx.fee
    }
  }

  /**
   * Quotes the costs of a send transaction operation.
   *
   * @see {@link sendTransaction}
   * @param {BtcTransaction} tx - The transaction.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction ({ to, value }) {
    const tx = await this._getTransaction({ recipient: to, amount: value })

    return {
      fee: +tx.fee
    }
  }

  /**
   * Transfers a token to another address.
   *
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<TransferResult>} The transfer's result.
   */
  async transfer (options) {
    throw new Error("The 'transfer' method is not supported on the bitcoin blockchain.")
  }

  /**
   * Quotes the costs of a transfer operation.
   *
   * @see {@link transfer}
   * @param {TransferOptions} options - The transfer's options.
   * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
   */
  async quoteTransfer (options) {
    throw new Error("The 'quoteTransfer' method is not supported on the bitcoin blockchain.")
  }

  /**
  * Returns the bitcoin transfers history of the account.
  *
  * Only parses Taproot (P2TR) transaction outputs. Non-Taproot outputs are skipped.
  *
   * @param {Object} [options] - The options.
   * @param {"incoming" | "outgoing" | "all"} [options.direction] - If set, only returns transfers with the given direction (default: "all").
   * @param {number} [options.limit] - The number of transfers to return (default: 10).
   * @param {number} [options.skip] - The number of transfers to skip (default: 0).
   * @returns {Promise<BtcTransfer[]>} The bitcoin transfers.
  */
  async getTransfers (options = {}) {
    const { direction = 'all', limit = 10, skip = 0 } = options
    const address = await this.getAddress()
    const history = await this._electrumClient.getHistory(address)

    // Helper function to decode script as P2TR (Taproot)
    // Returns the address if successful, null otherwise
    // Only supports Taproot addresses (P2TR) - P2WPKH is not supported
    const decodeScriptAddress = (script) => {
      if (!script) return null
      try {
        const p2tr = payments.p2tr({
          output: script,
          network: this._electrumClient.network
        })
        if (p2tr.address) return p2tr.address
      } catch (_) {
        // Not a Taproot script
      }
      return null
    }

    const extractAddress = (scriptPubKey) => {
      if (!scriptPubKey) return null
      if (scriptPubKey.address) return scriptPubKey.address
      if (Array.isArray(scriptPubKey.addresses)) return scriptPubKey.addresses[0]
      return null
    }

    // now works with bitcoinjs-lib Transaction.ins
    const getInputValue = async (ins) => {
      let total = 0
      for (const input of ins) {
        try {
          const prevId = Buffer.from(input.hash).reverse().toString('hex')
          const prevTx = await this._electrumClient.getTransaction(prevId)
          total += prevTx.outs[input.index].value
        } catch (_) {}
      }
      return total
    }

    const isOutgoingTx = async (ins) => {
      for (const input of ins) {
        try {
          const prevId = Buffer.from(input.hash).reverse().toString('hex')
          const prevTx = await this._electrumClient.getTransaction(prevId)
          const script = prevTx.outs[input.index].script
          const addr = decodeScriptAddress(script)
          if (addr && addr === address) return true
        } catch (_) {}
      }
      return false
    }

    const transfers = []

    for (const item of history.slice(skip)) {
      if (transfers.length >= limit) break

      const tx = await this._electrumClient.getTransaction(item.tx_hash)

      const totalInput = await getInputValue(tx.ins)
      const totalOutput = tx.outs.reduce((sum, o) => sum + o.value, 0)
      const fee = totalInput > 0 ? +(totalInput - totalOutput).toFixed(8) : null
      const outgoing = await isOutgoingTx(tx.ins)

      for (const [index, out] of tx.outs.entries()) {
        const hex = out.script.toString('hex')
        // Decode script as P2TR (Taproot) - only Taproot addresses are supported
        const addr = decodeScriptAddress(out.script)
        if (!addr) continue // Skip outputs that are not Taproot (P2TR) addresses
        const spk = { hex, address: addr }
        const recipient = extractAddress(spk)
        const isToSelf = addr === address

        let directionType = null
        if (isToSelf && !outgoing) directionType = 'incoming'
        else if (!isToSelf && outgoing) directionType = 'outgoing'
        else if (isToSelf && outgoing) directionType = 'change'
        else continue

        if (directionType === 'change') continue
        if (direction !== 'all' && direction !== directionType) continue
        if (transfers.length >= limit) break

        transfers.push({
          txid: item.tx_hash,
          height: item.height,
          value: out.value,
          vout: index,
          direction: directionType,
          recipient,
          fee,
          address
        })
      }
    }

    return transfers
  }

  /**
  * Returns a read-only copy of the account.
  *
  * @returns {Promise<never>} The read-only account.
  */
  async toReadOnlyAccount () {
    throw new Error('Read-only accounts are not supported for the bitcoin blockchain.')
  }

  /**
   * Disposes the wallet account, erasing the private key from the memory and closing the connection with the electrum server.
   */
  dispose () {
    sodium_memzero(this._account.privateKey)

    this._account = undefined

    this._electrumClient.disconnect()
  }

  /** @private */
  async _getTransaction ({ recipient, amount }) {
    const address = await this.getAddress()
    const utxoSet = await this._getUtxos(amount, address)
    let feeRate = await this._electrumClient.getFeeEstimateInSatsPerVb()

    if (feeRate.lt(1)) {
      feeRate = new BigNumber(1)
    }

    const transaction = await this._getRawTransaction(utxoSet, amount, recipient, feeRate)

    return transaction
  }

  /** @private */
  async _getUtxos (amount, address) {
    const unspent = await this._electrumClient.getUnspent(address)
    if (!unspent || unspent.length === 0) throw new Error('No unspent outputs available.')

    const utxos = []
    let totalCollected = new BigNumber(0)

    for (const utxo of unspent) {
      const tx = await this._electrumClient.getTransaction(utxo.tx_hash)
      const vout = tx.outs[utxo.tx_pos]
      const scriptHex = vout.script.toString('hex')
      const collectedVout = {
        value: vout.value,
        scriptPubKey: {
          hex: scriptHex
        }
      }

      utxos.push({ ...utxo, vout: collectedVout })
      totalCollected = totalCollected.plus(utxo.value)
      if (totalCollected.isGreaterThanOrEqualTo(amount)) break
    }
    return utxos
  }

  /** @private */
  async _getRawTransaction (utxoSet, amount, recipient, feeRate) {
    if (+amount <= DUST_LIMIT) throw new Error(`The amount must be bigger than the dust limit (= ${DUST_LIMIT}).`)
    const totalInput = utxoSet.reduce((sum, utxo) => sum.plus(utxo.value), new BigNumber(0))

    const createPsbt = async (fee) => {
      const psbt = new Psbt({ network: this._electrumClient.network })
      utxoSet.forEach((utxo, index) => {
        // For Taproot (P2TR) inputs, use tapInternalKey and tapBip32Derivation
        // instead of bip32Derivation. The signInputHD method will automatically
        // use Schnorr signatures for Taproot inputs.
        // For Taproot inputs, we need tapInternalKey and tapBip32Derivation
        // witnessUtxo is still needed for SegWit outputs (including Taproot)
        const inputData = {
          hash: utxo.tx_hash,
          index: utxo.tx_pos,
          witnessUtxo: { script: Buffer.from(utxo.vout.scriptPubKey.hex, 'hex'), value: utxo.value },
          tapInternalKey: this._internalPubkey,
          tapBip32Derivation: [{
            masterFingerprint: this._masterNode.fingerprint, // Already a Buffer
            path: this._path,
            pubkey: this._account.publicKey, // Already a Buffer (compressed public key)
            leafHashes: [] // Empty array for key path spends (BIP86 Taproot)
          }]
        }
        psbt.addInput(inputData)
      })
      psbt.addOutput({ address: recipient, value: amount })
      const change = totalInput.minus(amount).minus(fee)
      if (change.isGreaterThan(DUST_LIMIT)) psbt.addOutput({ address: await this.getAddress(), value: change.toNumber() })
      else if (change.isLessThan(0)) throw new Error('Insufficient balance to send the transaction.')
      // For Taproot inputs, use signTaprootInput which handles Schnorr signatures (BIP-340)
      // signInputHD doesn't support Taproot, so we use the Taproot-specific signing method
      // We need to use a BIP32 node that matches the derivation path in tapBip32Derivation
      // The node must implement signSchnorr for Taproot signing
      const accountPath = this._path.replace(/^m\//, '')
      const accountNode = this._masterNode.derivePath(accountPath)
      // Add signSchnorr method to the BIP32 node for Taproot signing
      accountNode.signSchnorr = (hash) => {
        return ecc.signSchnorr(hash, this._account.privateKey)
      }
      utxoSet.forEach((_, index) => {
        // signTaprootInput automatically uses Schnorr signatures for Taproot key path spends
        // For key path spends (BIP-86), tapLeafHashToSign is undefined (defaults to key path)
        psbt.signTaprootInput(index, accountNode)
      })
      psbt.finalizeAllInputs()
      return psbt
    }

    // Create a dummy transaction to estimate fee
    // virtualSize() automatically accounts for Taproot's different witness sizes
    // Taproot inputs have smaller witnesses (~57 bytes) compared to P2WPKH (~107 bytes)
    let psbt = await createPsbt(0)
    const dummyTx = psbt.extractTransaction()
    let estimatedFee = new BigNumber(feeRate).multipliedBy(dummyTx.virtualSize()).integerValue(BigNumber.ROUND_CEIL)
    estimatedFee = BigNumber.max(estimatedFee, new BigNumber(141))
    psbt = await createPsbt(estimatedFee)
    const tx = psbt.extractTransaction()
    return { txid: tx.getId(), hex: tx.toHex(), fee: estimatedFee }
  }
}
