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

import { hmac } from '@noble/hashes/hmac'
import { sha512 } from '@noble/hashes/sha2'
import { address as btcAddress, initEccLib, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import { tapTweakHash, tweakKey } from 'bitcoinjs-lib/src/payments/bip341'
import { BIP32Factory } from 'bip32'
import bitcoinMessageModule from '@bitcoinerlab/btcmessage'
import pLimit from 'p-limit'
import { LRUCache } from 'lru-cache'
import { compare, fromHex, toBase64, toHex } from 'uint8array-tools'

import * as bip39 from 'bip39'
import * as ecc from '@bitcoinerlab/secp256k1'

// eslint-disable-next-line camelcase
import { sodium_memzero } from 'sodium-universal'

import WalletAccountReadOnlyBtc from './wallet-account-read-only-btc.js'

const { MessageFactory } = bitcoinMessageModule.default ?? bitcoinMessageModule
const bitcoinMessage = MessageFactory(ecc)

/** @typedef {import('@tetherto/wdk-wallet').IWalletAccount} IWalletAccount */

/** @typedef {import('@tetherto/wdk-wallet').KeyPair} KeyPair */
/** @typedef {import('@tetherto/wdk-wallet').TransactionResult} TransactionResult */
/** @typedef {import('@tetherto/wdk-wallet').TransferOptions} TransferOptions */
/** @typedef {import('@tetherto/wdk-wallet').TransferResult} TransferResult */

/** @typedef {import('./wallet-account-read-only-btc.js').BtcTransaction} BtcTransaction */
/** @typedef {import('./wallet-account-read-only-btc.js').BtcWalletConfig} BtcWalletConfig */

/**
 * @typedef {Object} BtcTransfer
 * @property {string} txid - The transaction's id.
 * @property {string} address - The user's own address.
 * @property {number} vout - The index of the output in the transaction.
 * @property {number} height - The block height (if unconfirmed, 0).
 * @property {bigint} value - The value of the transfer (in satoshis).
 * @property {"incoming" | "outgoing"} direction - The direction of the transfer.
 * @property {bigint} [fee] - The fee paid for the full transaction (in satoshis).
 * @property {string} [recipient] - The receiving address for outgoing transfers.
 */

/**
 * @typedef {Object} TaprootKeyMaterialHex
 * @property {string} internalPubKeyHex - The 32-byte Taproot internal public key (hex).
 * @property {string} privateKeyHex - The BIP-32 account private key (hex). Sensitive.
 * @property {string} tweakedPrivateKeyHex - The tweaked Taproot private key used for Schnorr signing (hex). Sensitive.
 */

const MASTER_SECRET = Uint8Array.from('Bitcoin seed', char => char.charCodeAt(0))

const BITCOIN = {
  wif: 0x80,
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  pubKeyHash: 0x00,
  scriptHash: 0x05
}

const MAX_CONCURRENT_REQUESTS = 8
const MAX_CACHE_ENTRIES = 1000
const REQUEST_BATCH_SIZE = 64

const POLLING_INTERVAL = 300

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

const bip32 = BIP32Factory(ecc)

initEccLib(ecc)

/**
 * Encode data as a Bitcoin script push (direct push / OP_PUSHDATA1/2/4).
 * @param {Uint8Array} dataBuffer
 * @returns {Uint8Array}
 */
function encodeScriptPush (dataBuffer) {
  const n = dataBuffer.length
  if (n === 0) {
    return Uint8Array.of(0x00)
  }
  if (n <= 75) {
    const buf = new Uint8Array(1 + n)
    buf[0] = n
    buf.set(dataBuffer, 1)
    return buf
  }
  if (n <= 255) {
    const buf = new Uint8Array(2 + n)
    buf[0] = 0x4c
    buf[1] = n
    buf.set(dataBuffer, 2)
    return buf
  }
  if (n <= 65535) {
    const buf = new Uint8Array(3 + n)
    buf[0] = 0x4d
    buf[1] = n & 0xff
    buf[2] = (n >> 8) & 0xff
    buf.set(dataBuffer, 3)
    return buf
  }
  const buf = new Uint8Array(5 + n)
  buf[0] = 0x4e
  buf[1] = n & 0xff
  buf[2] = (n >> 8) & 0xff
  buf[3] = (n >> 16) & 0xff
  buf[4] = (n >> 24) & 0xff
  buf.set(dataBuffer, 5)
  return buf
}

function negatePrivKey (privKey) {
  const asBigInt = BigInt('0x' + toHex(privKey))
  const negated = (SECP256K1_ORDER - asBigInt) % SECP256K1_ORDER
  return fromHex(negated.toString(16).padStart(64, '0'))
}

function derivePath (seed, path) {
  const masterKeyAndChainCodeBuffer = hmac(sha512, MASTER_SECRET, seed)

  const privateKey = masterKeyAndChainCodeBuffer.slice(0, 32)
  const chainCode = masterKeyAndChainCodeBuffer.slice(32)

  const masterNode = bip32.fromPrivateKey(Uint8Array.from(privateKey), Uint8Array.from(chainCode), BITCOIN)
  const account = masterNode.derivePath(path)

  sodium_memzero(masterKeyAndChainCodeBuffer)
  sodium_memzero(privateKey)
  sodium_memzero(chainCode)

  return { masterNode, account }
}

function isTaprootAddress (address) {
  const toLower = address.toLowerCase()
  return toLower.startsWith('bc1p') || toLower.startsWith('tb1p') || toLower.startsWith('bcrt1p')
}

function assertTaprootRecipient (to) {
  if (!isTaprootAddress(to)) {
    throw new Error('Recipient address must be a Taproot (P2TR) address. Taproot addresses start with bc1p (mainnet), tb1p (testnet), or bcrt1p (regtest).')
  }
}

/** @implements {IWalletAccount<string>} */
export default class WalletAccountBtc extends WalletAccountReadOnlyBtc {
  /**
   * Creates a new bitcoin wallet account.
   * Supports P2PKH (BIP-44), P2WPKH (BIP-84), and P2TR Taproot (BIP-86).
   *
   * @param {string | Uint8Array} seed - The wallet's BIP-39 seed phrase.
   * @param {string} path - The derivation path suffix (e.g. "0'/0/0").
   * @param {BtcWalletConfig} [config] - The configuration object.
   */
  constructor (seed, path, config = {}) {
    if (typeof seed === 'string') {
      if (!bip39.validateMnemonic(seed)) {
        throw new Error('The seed phrase is invalid.')
      }

      seed = bip39.mnemonicToSeedSync(seed)
    }

    let bip = config.bip
    if (bip === undefined) {
      bip = config.script_type === 'P2TR' ? 86 : 84
    }

    let scriptType = config.script_type
    if (scriptType === undefined) {
      if (bip === 86) scriptType = 'P2TR'
      else if (bip === 44) scriptType = 'P2PKH'
      else scriptType = 'P2WPKH'
    }

    if (![44, 84, 86].includes(bip)) {
      throw new Error('Invalid bip specification. Supported bips: 44, 84, 86.')
    }

    if (bip === 86 && scriptType !== 'P2TR') {
      throw new Error('BIP 86 requires script_type to be "P2TR".')
    }
    if (scriptType === 'P2TR' && bip !== 86) {
      throw new Error('script_type "P2TR" requires bip to be 86.')
    }

    const netdp = config.network === 'bitcoin' ? 0 : 1
    const fullPath = `m/${bip}'/${netdp}'/${path}`

    const { masterNode, account } = derivePath(seed, fullPath)

    const network = networks[config.network] || networks.bitcoin

    let address
    if (scriptType === 'P2TR') {
      const { address: p2trAddress } = payments.p2tr({
        internalPubkey: account.publicKey.slice(1),
        network
      })
      address = p2trAddress
    } else if (bip === 44) {
      const { address: p2pkhAddress } = payments.p2pkh({ pubkey: account.publicKey, network })
      address = p2pkhAddress
    } else {
      const { address: p2wpkhAddress } = payments.p2wpkh({ pubkey: account.publicKey, network })
      address = p2wpkhAddress
    }

    super(address, config)

    /**
     * The wallet account configuration.
     *
     * @protected
     * @type {BtcWalletConfig}
     */
    this._config = config

    /** @private */
    this._path = fullPath

    /** @private */
    this._bip = bip

    /** @private */
    this._scriptType = scriptType

    /** @private */
    this._masterNode = masterNode

    /** @private */
    this._account = account

    if (scriptType === 'P2TR') {
      if (!account?.publicKey || account.publicKey.length !== 33) {
        throw new Error('Invalid account public key for P2TR initialization.')
      }
      /** @private */
      this._internalPubkey = Uint8Array.from(account.publicKey.slice(1))
    } else {
      /** @private */
      this._internalPubkey = undefined
    }
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
   * The derivation path of this account.
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
      privateKey: this._account.privateKey ?? null,
      publicKey: this._account.publicKey
    }
  }

  /**
   * The script type of this account (`P2TR`, `P2WPKH`, or `P2PKH`).
   *
   * @type {string}
   */
  get scriptType () {
    return this._scriptType
  }

  /**
   * Exports Taproot key material as hex.
   * Returns private key material — treat as sensitive. Intended for Koine/Satochip-adjacent tooling.
   *
   * @returns {TaprootKeyMaterialHex | null} Key material, or null when this account is not P2TR.
   */
  getTaprootKeyMaterialHex () {
    if (this._scriptType !== 'P2TR' || !this._account || !this._internalPubkey) {
      return null
    }

    const { tweakedPrivKey } = this._deriveTweakedTaprootKeys()

    return {
      internalPubKeyHex: toHex(this._internalPubkey),
      privateKeyHex: toHex(this._account.privateKey),
      tweakedPrivateKeyHex: toHex(tweakedPrivKey)
    }
  }

  /**
   * Signs a message.
   * For P2WPKH (BIP-84) and P2TR (BIP-86), uses SegWit message signing format.
   *
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The message's signature.
   */
  async sign (message) {
    const segwit = this._bip === 84 || this._bip === 86
      ? { segwitType: 'p2wpkh' }
      : undefined

    return toBase64(bitcoinMessage.sign(
      message,
      this._account.privateKey,
      true,
      segwit
    ))
  }

  /**
   * Signs a transaction.
   *
   * @param {BtcTransaction} tx - The transaction to sign.
   * @returns {Promise<string>} The signed raw transaction as a hex string.
   * @throws {Error} If the transaction's cost exceeds the maximum transaction fee option.
   */
  async signTransaction ({ to, value, feeRate, confirmationTarget = 1 }) {
    const { tx } = await this._buildSignedTransaction({ to, value, feeRate, confirmationTarget })

    if (this._config.transactionMaxFee !== undefined && tx.fee > this._config.transactionMaxFee) {
      throw new Error('Exceeded maximum fee cost for transaction operation.')
    }

    return tx.hex
  }

  /**
   * Quotes the costs of a send transaction operation.
   * When given a signed hex string, fee-quotes that transaction without rebuilding it.
   * Distinct from {@link WalletAccountBtc#quoteSendTransactionTX}, which builds a signed hex from `{to,value}`.
   *
   * @param {BtcTransaction | string} tx - The transaction, or a signed raw transaction as a hex string.
   * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
   */
  async quoteSendTransaction (tx) {
    if (typeof tx === 'string') {
      await this._ensureConnected()

      const transaction = Transaction.fromHex(tx)
      const fee = await this._getSignedTransactionFee(transaction)

      return { fee }
    }

    return await super.quoteSendTransaction(tx)
  }

  /**
   * Sends a transaction.
   *
   * @param {BtcTransaction | string} tx - The transaction, or a signed raw transaction as a hex string.
   * @param {number} [timeoutMs] - Maximum milliseconds to poll for spent inputs to disappear from unspent outputs after broadcast.
   * @returns {Promise<TransactionResult>} The transaction's result.
   * @throws {Error} If the transaction's cost exceeds the maximum transaction fee option.
   */
  async sendTransaction (tx, timeoutMs = 10000) {
    await this._ensureConnected()

    let hex, txid, fee, spentOutpoints

    if (typeof tx === 'string') {
      const transaction = Transaction.fromHex(tx)

      hex = tx
      txid = transaction.getId()
      fee = await this._getSignedTransactionFee(transaction)
      spentOutpoints = new Set(
        transaction.ins.map((input) => `${Buffer.from(input.hash).reverse().toString('hex')}:${input.index}`)
      )
    } else {
      const { to, value, feeRate, confirmationTarget = 1 } = tx
      const { tx: builtTx, utxos } = await this._buildSignedTransaction({ to, value, feeRate, confirmationTarget })

      hex = builtTx.hex
      txid = builtTx.txid
      fee = builtTx.fee
      spentOutpoints = new Set(utxos.map(({ tx_hash: txHash, tx_pos: txPos }) => `${txHash}:${txPos}`))
    }

    if (this._config.transactionMaxFee !== undefined && fee > this._config.transactionMaxFee) {
      throw new Error('Exceeded maximum fee cost for transaction operation.')
    }

    const address = await this.getAddress()
    let retries = Math.ceil(timeoutMs / POLLING_INTERVAL)

    await this._client.broadcast(hex)

    while (retries > 0) {
      retries -= 1

      await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL))

      const currentUtxos = await this._client.listUnspent(address)
      const hasSpentOutpoints = currentUtxos
        .some(({ tx_hash: txHash, tx_pos: txPos }) => spentOutpoints.has(`${txHash}:${txPos}`))

      if (!hasSpentOutpoints) break
    }

    return { hash: txid, fee }
  }

  /**
   * Sends a transaction with a memo (OP_RETURN output).
   * Requires the recipient address to be a Taproot (P2TR) address.
   *
   * @param {Object} options - Transaction options.
   * @param {string} options.to - The recipient's Taproot Bitcoin address.
   * @param {number | bigint} options.value - The amount to send (in satoshis).
   * @param {string} options.memo - The memo string to embed in OP_RETURN (max 75 bytes UTF-8).
   * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
   * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
   * @returns {Promise<TransactionResult>} The transaction result.
   */
  async sendTransactionWithMemo ({ to, value, memo, feeRate, confirmationTarget = 1 }) {
    assertTaprootRecipient(to)
    await this._ensureConnected()

    const address = await this.getAddress()

    if (!feeRate) {
      const feeEstimate = await this._client.estimateFee(confirmationTarget)
      feeRate = this._toBigInt(Math.max(feeEstimate * 100_000, 1))
    }

    const { utxos, fee, changeValue } = await this._planSpendWithMemo({
      fromAddress: address,
      toAddress: to,
      amount: value,
      memo,
      feeRate
    })

    if (this._config.transactionMaxFee !== undefined && fee > this._config.transactionMaxFee) {
      throw new Error('Exceeded maximum fee cost for transaction operation.')
    }

    const opReturnScript = this.createOpReturnScript(memo)
    const tx = await this._getRawTransaction({
      utxos,
      to,
      value,
      fee,
      feeRate,
      changeValue,
      additionalOutputs: [{ script: opReturnScript, value: 0n }]
    })

    await this._client.broadcast(tx.hex)

    return { hash: tx.txid, fee: tx.fee }
  }

  /**
   * Builds and signs a transaction from `{to,value}` and returns the raw hex without broadcasting.
   * Distinct from {@link WalletAccountBtc#quoteSendTransaction} when given a hex string (fee-only quote).
   *
   * @param {BtcTransaction} tx - The transaction options.
   * @returns {Promise<string>} The signed raw transaction hex.
   */
  async quoteSendTransactionTX ({ to, value, feeRate, confirmationTarget = 1 }) {
    const { tx } = await this._buildSignedTransaction({ to, value, feeRate, confirmationTarget })
    return tx.hex
  }

  /**
   * Builds and signs a memo transaction and returns the raw hex without broadcasting.
   * Requires a Taproot recipient.
   *
   * @param {Object} options - Transaction options.
   * @param {string} options.to - The recipient's Taproot Bitcoin address.
   * @param {number | bigint} options.value - The amount to send (in satoshis).
   * @param {string} options.memo - The memo string (max 75 bytes UTF-8).
   * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
   * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
   * @returns {Promise<string>} The signed raw transaction hex.
   */
  async quoteSendTransactionWithMemoTX ({ to, value, memo, feeRate, confirmationTarget = 1 }) {
    assertTaprootRecipient(to)
    await this._ensureConnected()

    const address = await this.getAddress()

    if (!feeRate) {
      const feeEstimate = await this._client.estimateFee(confirmationTarget)
      feeRate = this._toBigInt(Math.max(feeEstimate * 100_000, 1))
    }

    const { utxos, fee, changeValue } = await this._planSpendWithMemo({
      fromAddress: address,
      toAddress: to,
      amount: value,
      memo,
      feeRate
    })

    const opReturnScript = this.createOpReturnScript(memo)
    const tx = await this._getRawTransaction({
      utxos,
      to,
      value,
      fee,
      feeRate,
      changeValue,
      additionalOutputs: [{ script: opReturnScript, value: 0n }]
    })

    return tx.hex
  }

  /**
   * Creates an OP_RETURN script from a UTF-8 string.
   *
   * @param {string} data - The UTF-8 data to embed.
   * @returns {Uint8Array} The OP_RETURN script.
   */
  createOpReturnScript (data) {
    const dataBuffer = Buffer.from(data, 'utf8')
    const pushPart = encodeScriptPush(dataBuffer)
    const script = new Uint8Array(1 + pushPart.length)
    script[0] = 0x6a
    script.set(pushPart, 1)
    return script
  }

  /**
   * Creates an OP_RETURN script from hex-encoded data.
   *
   * @param {string} hexData - The hex-encoded data to embed.
   * @returns {Uint8Array} The OP_RETURN script.
   */
  createOpReturnScriptFromHex (hexData) {
    if (!/^[0-9a-fA-F]*$/.test(hexData)) {
      throw new Error('Hex data must be a valid hexadecimal string')
    }

    const dataBuffer = fromHex(hexData)
    const pushPart = encodeScriptPush(dataBuffer)
    const script = new Uint8Array(1 + pushPart.length)
    script[0] = 0x6a
    script.set(pushPart, 1)
    return script
  }

  /**
   * Builds (without broadcasting) a two-input update transaction that spends a 1077-sat
   * output from `priorTx` (signed by `priorAcct`) plus a funding UTXO from this account,
   * embeds `hex` in OP_RETURN, and pays `value` (default 1077) to `to`.
   *
   * @param {Object} options - Transaction options.
   * @param {string} options.to - The recipient's Bitcoin address.
   * @param {string} options.hex - Hex-encoded OP_RETURN payload.
   * @param {string} options.priorTx - Prior transaction id containing a 1077-sat output.
   * @param {WalletAccountBtc} options.priorAcct - Account that owns the prior UTXO.
   * @param {number | bigint} [options.value] - Amount to send (default: 1077).
   * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
   * @param {number} [options.confirmationTarget] - Optional confirmation target (default: 1).
   * @returns {Promise<{hex: string, fee: bigint}>} The signed hex and fee.
   */
  async quoteUpdateTransactionWithHexTX (options) {
    const tx = await this._composeUpdateTransactionWithHex(options)
    return { hex: tx.hex, fee: tx.fee }
  }

  /**
   * Same as {@link WalletAccountBtc#quoteUpdateTransactionWithHexTX}, but broadcasts the result.
   *
   * @param {Object} options - See quoteUpdateTransactionWithHexTX.
   * @returns {Promise<TransactionResult>} The transaction result.
   */
  async updateTransactionWithHex (options) {
    await this._ensureConnected()
    const tx = await this._composeUpdateTransactionWithHex(options)

    if (this._config.transactionMaxFee !== undefined && tx.fee > this._config.transactionMaxFee) {
      throw new Error('Exceeded maximum fee cost for transaction operation.')
    }

    await this._client.broadcast(tx.hex)
    return { hash: tx.txid, fee: tx.fee }
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
   * Returns the bitcoin transfers history of the account.
   *
   * @param {Object} [options] - The options.
   * @param {"incoming" | "outgoing" | "all"} [options.direction] - If set, only returns transfers with the given direction (default: "all").
   * @param {number} [options.limit] - The number of transfers to return (default: 10).
   * @param {number} [options.skip] - The number of transfers to skip (default: 0).
   * @returns {Promise<BtcTransfer[]>} The bitcoin transfers.
   */
  async getTransfers (options = {}) {
    await this._ensureConnected()

    const {
      direction = 'all',
      limit = 10,
      skip = 0
    } = options

    const network = this._network
    const address = await this.getAddress()
    const history = await this._client.getHistory(address)

    const myScript = btcAddress.toOutputScript(address, network)

    const txCache = new LRUCache({ max: MAX_CACHE_ENTRIES })
    const prevUtxoCache = new LRUCache({ max: MAX_CACHE_ENTRIES })
    const limitConcurrency = pLimit(MAX_CONCURRENT_REQUESTS)

    const fetchTransaction = async (txid) => {
      const cached = txCache.get(txid)
      if (cached) return cached
      const hex = await limitConcurrency(() =>
        this._client.getTransaction(txid)
      )
      const tx = Transaction.fromHex(hex)
      txCache.set(txid, tx)
      return tx
    }

    const getPrevUtxo = async (input) => {
      const prevTxId = toHex(Uint8Array.from(input.hash).reverse())
      const prevKey = `${prevTxId}:${input.index}`
      const cached = prevUtxoCache.get(prevKey)
      if (cached !== undefined) return cached
      const isCoinbasePrevUtxo = prevTxId === '0'.repeat(64)
      if (isCoinbasePrevUtxo) { prevUtxoCache.set(prevKey, null); return null }
      const prevTx = await fetchTransaction(prevTxId)
      const prevTxUtxo = prevTx.outs[input.index] || null
      const prevUtxo = prevTxUtxo ? { script: prevTxUtxo.script, value: BigInt(prevTxUtxo.value) } : null
      prevUtxoCache.set(prevKey, prevUtxo)
      return prevUtxo
    }

    const processHistoryItem = async (item) => {
      let tx
      try {
        tx = await fetchTransaction(item.tx_hash)
      } catch (err) {
        console.warn('Failed to fetch transaction', item.tx_hash, err)
        return []
      }
      const prevUtxos = await Promise.all(
        tx.ins.map((input) => getPrevUtxo(input).catch((err) => {
          console.warn('Failed to fetch prevUtxo', input, err)
          return null
        }))
      )

      let totalInputValue = 0n
      let isOutgoingTx = false
      for (const prevUtxo of prevUtxos) {
        if (!prevUtxo || typeof prevUtxo.value !== 'bigint') continue
        totalInputValue += prevUtxo.value
        const isOurPrevUtxo = prevUtxo.script && compare(prevUtxo.script, myScript) === 0
        isOutgoingTx = isOutgoingTx || isOurPrevUtxo
      }

      const utxos = tx.outs
      let totalUtxoValue = 0n
      for (const utxo of utxos) totalUtxoValue += BigInt(utxo.value)

      const fee = totalInputValue > 0n ? totalInputValue - totalUtxoValue : null

      const rows = []
      for (let vout = 0; vout < utxos.length; vout++) {
        const utxo = utxos[vout]
        const utxoValue = BigInt(utxo.value)
        const isSelfUtxo = compare(utxo.script, myScript) === 0
        let directionType = null
        if (isSelfUtxo && !isOutgoingTx) directionType = 'incoming'
        else if (!isSelfUtxo && isOutgoingTx) directionType = 'outgoing'
        else if (isSelfUtxo && isOutgoingTx) directionType = 'change'
        else continue
        if (directionType === 'change') continue
        if (direction !== 'all' && direction !== directionType) continue

        let recipient = null
        try {
          recipient = btcAddress.fromOutputScript(utxo.script, network)
        } catch (err) {
          console.warn('Failed to decode recipient address', utxo, err)
        }

        rows.push({
          txid: item.tx_hash,
          height: item.height,
          value: utxoValue,
          vout,
          direction: directionType,
          recipient,
          fee,
          address
        })
      }
      return rows
    }

    const transfers = []
    const filteredHistory = history.slice(skip)
    for (let i = 0; i < filteredHistory.length && transfers.length < limit; i += REQUEST_BATCH_SIZE) {
      const window = filteredHistory.slice(i, i + REQUEST_BATCH_SIZE)
      const settled = await Promise.allSettled(
        window.map((item) =>
          processHistoryItem(item).catch((err) => {
            console.warn('Failed to process history item', item, err)
            return []
          })
        )
      )
      for (const res of settled) {
        if (transfers.length >= limit) break
        if (res.status !== 'fulfilled') continue
        const rows = res.value || []
        for (const row of rows) {
          transfers.push(row)
          if (transfers.length >= limit) break
        }
      }
    }

    return transfers
  }

  /**
   * Returns a read-only copy of the account.
   *
   * @returns {Promise<WalletAccountReadOnlyBtc>} The read-only account.
   */
  async toReadOnlyAccount () {
    if (!this._btcReadOnlyAccount) {
      this._btcReadOnlyAccount = new WalletAccountReadOnlyBtc(this._address, {
        ...this._config,
        client: this._client
      })
    }

    return this._btcReadOnlyAccount
  }

  /**
   * Disposes the wallet account, erasing the private key from memory and closing the connection with the server.
   */
  dispose () {
    sodium_memzero(this._account.privateKey)
    sodium_memzero(this._account.chainCode)

    sodium_memzero(this._masterNode.privateKey)
    sodium_memzero(this._masterNode.chainCode)

    this._masterNode = undefined

    Object.defineProperty(this._account, 'privateKey', {
      get: () => null
    })

    super.dispose()
  }

  /**
   * @private
   * @param {Transaction} transaction
   * @returns {Promise<bigint>}
   */
  async _getSignedTransactionFee (transaction) {
    let totalInput = 0n

    for (const input of transaction.ins) {
      const prevTxId = Buffer.from(input.hash).reverse().toString('hex')
      const prevHex = await this._client.getTransaction(prevTxId)
      const prevTx = Transaction.fromHex(prevHex)

      totalInput += BigInt(prevTx.outs[input.index].value)
    }

    let totalOutput = 0n

    for (const output of transaction.outs) {
      totalOutput += BigInt(output.value)
    }

    return totalInput - totalOutput
  }

  /**
   * @private
   * @returns {{ tweakedOutputPubkey: Uint8Array, tweakedPrivKey: Uint8Array }}
   */
  _deriveTweakedTaprootKeys () {
    return WalletAccountBtc._deriveTweakedTaprootKeysForAccount(this)
  }

  /**
   * @private
   * @param {WalletAccountBtc} account
   * @returns {{ tweakedOutputPubkey: Uint8Array, tweakedPrivKey: Uint8Array }}
   */
  static _deriveTweakedTaprootKeysForAccount (account) {
    const { output } = payments.p2tr({
      internalPubkey: account._internalPubkey,
      network: account._network
    })
    const tweakedOutputPubkey = output.slice(2, 34)

    const tapTweakHashValue = tapTweakHash(Uint8Array.from(account._internalPubkey), undefined)
    const verifiedTweakedResult = tweakKey(Uint8Array.from(account._internalPubkey), undefined)
    if (!verifiedTweakedResult?.x || verifiedTweakedResult.x.length !== 32) {
      throw new Error('Failed to verify tapTweak calculation using bitcoinjs-lib tweakKey')
    }
    if (compare(verifiedTweakedResult.x, tweakedOutputPubkey) !== 0) {
      throw new Error('tapTweak calculation mismatch against p2tr output key')
    }

    let internalPrivKey = Uint8Array.from(account._account.privateKey)
    const internalPubKeyFull = Uint8Array.from(account._account.publicKey)
    if ((internalPubKeyFull[0] & 1) === 1) {
      internalPrivKey = negatePrivKey(internalPrivKey)
    }

    const tweakedPrivKeyDirect = Uint8Array.from(ecc.privateAdd(internalPrivKey, tapTweakHashValue))
    const tweakedPrivKey = verifiedTweakedResult.parity === 1
      ? negatePrivKey(tweakedPrivKeyDirect)
      : tweakedPrivKeyDirect

    return { tweakedOutputPubkey, tweakedPrivKey }
  }

  /**
   * @private
   * @param {WalletAccountBtc} account
   * @param {import('bitcoinjs-lib').Psbt} psbt
   * @param {Object} utxo
   */
  static async _addAccountInput (account, psbt, utxo, getPrevTxHex) {
    if (account._scriptType === 'P2TR') {
      const inputData = {
        hash: utxo.tx_hash,
        index: utxo.tx_pos,
        witnessUtxo: {
          script: fromHex(utxo.vout.scriptPubKey.hex),
          value: account._toBigInt(utxo.vout.value ?? utxo.value)
        },
        tapInternalKey: account._internalPubkey
      }
      psbt.addInput(inputData)
      const inputIndex = psbt.inputCount - 1
      const input = psbt.data.inputs[inputIndex]
      if (input) {
        input.tapBip32Derivation = [{
          masterFingerprint: account._masterNode.fingerprint,
          path: account._path,
          pubkey: Uint8Array.from(account._internalPubkey),
          leafHashes: []
        }]
      }
      return
    }

    const baseInput = {
      hash: utxo.tx_hash,
      index: utxo.tx_pos,
      bip32Derivation: [{
        masterFingerprint: account._masterNode.fingerprint,
        path: account._path,
        pubkey: account._account.publicKey
      }]
    }

    if (account._bip === 84) {
      psbt.addInput({
        ...baseInput,
        witnessUtxo: {
          script: fromHex(utxo.vout.scriptPubKey.hex),
          value: account._toBigInt(utxo.vout.value ?? utxo.value)
        }
      })
    } else {
      const prevHex = await getPrevTxHex(utxo.tx_hash)
      psbt.addInput({
        ...baseInput,
        nonWitnessUtxo: fromHex(prevHex)
      })
    }
  }

  /**
   * @private
   * @param {WalletAccountBtc} account
   * @param {import('bitcoinjs-lib').Psbt} psbt
   * @param {number} index
   */
  static _signAccountInput (account, psbt, index) {
    if (account._scriptType === 'P2TR') {
      const { tweakedOutputPubkey, tweakedPrivKey } = WalletAccountBtc._deriveTweakedTaprootKeysForAccount(account)
      const taprootSigner = {
        publicKey: tweakedOutputPubkey,
        network: account._network,
        signSchnorr: (hash) => ecc.signSchnorr(hash, tweakedPrivKey)
      }
      psbt.signInput(index, taprootSigner)
      return
    }

    psbt.signInputHD(index, account._masterNode)
  }

  /**
   * @private
   */
  async _composeUpdateTransactionWithHex ({ to, hex, priorTx, priorAcct, value, feeRate, confirmationTarget = 1 }) {
    const sendValue = value !== undefined ? this._toBigInt(value) : 1077n

    await this._ensureConnected()

    const address = await this.getAddress()
    const network = this._network

    if (!feeRate) {
      const feeEstimate = await this._client.estimateFee(confirmationTarget)
      feeRate = this._toBigInt(Math.max(feeEstimate * 100_000, 1))
    }

    feeRate = this._toBigInt(feeRate)
    if (feeRate < 1n) feeRate = 1n

    if (!priorAcct) {
      throw new Error('priorAcct parameter is required to sign the prior transaction UTXO')
    }

    const priorTxHex = await this._client.getTransaction(priorTx)
    const priorTransaction = Transaction.fromHex(priorTxHex)

    let priorUtxoIndex = -1
    let priorUtxoScript = null
    for (let i = 0; i < priorTransaction.outs.length; i++) {
      const output = priorTransaction.outs[i]
      if (BigInt(output.value) === 1077n) {
        priorUtxoIndex = i
        priorUtxoScript = output.script
        break
      }
    }

    if (priorUtxoIndex === -1) {
      throw new Error(`No output with value 1077 sats found in transaction ${priorTx}`)
    }

    const unspent = await this._client.listUnspent(address)
    if (!unspent || unspent.length === 0) {
      throw new Error(`No unspent outputs available for address ${address}`)
    }

    const fromAddressScriptHex = toHex(btcAddress.toOutputScript(address, network))

    const priorAcctAddress = await priorAcct.getAddress()
    if (priorAcct._network.name !== network.name) {
      throw new Error('priorAcct network must match the current account network')
    }

    const priorAcctScriptHex = toHex(btcAddress.toOutputScript(priorAcctAddress, network))
    const priorUtxoScriptHex = toHex(priorUtxoScript)
    if (priorUtxoScriptHex !== priorAcctScriptHex) {
      throw new Error('Prior transaction UTXO script does not match priorAcct address. Cannot sign this input.')
    }

    const opReturnScript = this.createOpReturnScriptFromHex(hex)

    const addrLower = address.toLowerCase()
    const isP2TR = isTaprootAddress(address)
    const isP2WPKH = addrLower.startsWith('bc1q') || addrLower.startsWith('tb1q') || addrLower.startsWith('bcrt1q')
    const inputVBytes = isP2TR ? 58 : isP2WPKH ? 68 : 148
    const outputVBytes = isP2TR ? 43 : isP2WPKH ? 31 : 34
    const estimatedVSize = 11 + (2 * inputVBytes) + (3 * outputVBytes)
    const estimatedFee = BigInt(estimatedVSize) * feeRate
    const totalNeeded = sendValue + estimatedFee

    let selectedUtxo = unspent.find(u => BigInt(u.value) >= totalNeeded)
    if (!selectedUtxo) {
      const sortedUtxos = [...unspent].sort((a, b) => Number(b.value) - Number(a.value))
      selectedUtxo = sortedUtxos[0]
    }

    if (!selectedUtxo) {
      throw new Error(`Insufficient balance to fund transaction. Need at least ${totalNeeded.toString()} sats.`)
    }

    const utxos = [
      {
        tx_hash: priorTx,
        tx_pos: priorUtxoIndex,
        value: 1077,
        vout: {
          value: 1077n,
          scriptPubKey: { hex: priorUtxoScriptHex }
        }
      },
      {
        tx_hash: selectedUtxo.tx_hash,
        tx_pos: selectedUtxo.tx_pos,
        value: selectedUtxo.value,
        vout: {
          value: this._toBigInt(selectedUtxo.value),
          scriptPubKey: { hex: fromAddressScriptHex }
        }
      }
    ]

    const totalInput = utxos.reduce((sum, u) => sum + this._toBigInt(u.value), 0n)
    const changeValue = totalInput - sendValue - estimatedFee

    return await this._buildMultiAccountTransaction({
      utxos,
      to,
      value: sendValue,
      fee: estimatedFee,
      feeRate,
      changeValue: changeValue > 0n ? changeValue : 0n,
      additionalOutputs: [{ script: opReturnScript, value: 0n }],
      priorAcct
    })
  }

  /**
   * @private
   */
  async _buildMultiAccountTransaction ({ utxos, to, value, fee, feeRate, changeValue, additionalOutputs = [], priorAcct }) {
    feeRate = this._toBigInt(feeRate)
    if (feeRate < 1n) feeRate = 1n
    value = this._toBigInt(value)
    changeValue = this._toBigInt(changeValue)
    fee = this._toBigInt(fee)

    const legacyPrevTxCache = new Map()
    const getPrevTxHex = async (txid) => {
      if (legacyPrevTxCache.has(txid)) return legacyPrevTxCache.get(txid)
      const hex = await this._client.getTransaction(txid)
      legacyPrevTxCache.set(txid, hex)
      return hex
    }

    const buildAndSign = async (rcptVal, chgVal) => {
      if (!this._masterNode || !this._account) {
        throw new Error('Wallet account has been disposed or not properly initialized. Cannot build transaction.')
      }
      if (!priorAcct._masterNode || !priorAcct._account) {
        throw new Error('Prior account has been disposed or not properly initialized. Cannot build transaction.')
      }

      const psbt = new Psbt({ network: this._network })

      for (let i = 0; i < utxos.length; i++) {
        const account = i === 0 ? priorAcct : this
        await WalletAccountBtc._addAccountInput(account, psbt, utxos[i], getPrevTxHex)
      }

      psbt.addOutput({ address: to, value: rcptVal })

      for (const output of additionalOutputs) {
        if (output.script) {
          if (output.value !== 0 && output.value !== 0n) {
            throw new Error('OP_RETURN outputs must have value 0')
          }
          psbt.addOutput({ script: output.script, value: 0n })
        } else if (output.address) {
          psbt.addOutput({
            address: output.address,
            value: this._toBigInt(output.value)
          })
        } else {
          throw new Error('Additional output must have either "script" or "address" property')
        }
      }

      if (chgVal > 0n) psbt.addOutput({ address: await this.getAddress(), value: chgVal })

      for (let i = 0; i < utxos.length; i++) {
        const account = i === 0 ? priorAcct : this
        WalletAccountBtc._signAccountInput(account, psbt, i)
      }

      psbt.finalizeAllInputs()
      return psbt.extractTransaction()
    }

    let currentRecipientAmnt = value
    let currentChange = changeValue

    let tx = await buildAndSign(currentRecipientAmnt, currentChange)
    let vsize = tx.virtualSize()
    let requiredFee = BigInt(vsize) * feeRate

    if (requiredFee <= fee) {
      return { txid: tx.getId(), hex: tx.toHex(), fee, vsize }
    }

    const dustLimit = this._dustLimit
    const delta = requiredFee - fee
    fee = requiredFee

    if (currentChange > 0n) {
      let newChange = currentChange - delta
      if (newChange <= dustLimit) newChange = 0n
      currentChange = newChange
      tx = await buildAndSign(currentRecipientAmnt, currentChange)
    } else {
      const newRecipientAmnt = currentRecipientAmnt - delta
      if (newRecipientAmnt <= dustLimit) {
        throw new Error(`The amount after fees must be bigger than the dust limit (= ${dustLimit}).`)
      }
      currentRecipientAmnt = newRecipientAmnt
      tx = await buildAndSign(currentRecipientAmnt, currentChange)
    }

    vsize = tx.virtualSize()
    requiredFee = BigInt(vsize) * feeRate
    if (requiredFee > fee) throw new Error('Fee shortfall after output rebalance.')

    return { txid: tx.getId(), hex: tx.toHex(), fee, vsize }
  }

  /** @private */
  async _getRawTransaction ({ utxos, to, value, fee, feeRate, changeValue, additionalOutputs = [] }) {
    feeRate = this._toBigInt(feeRate)
    if (feeRate < 1n) feeRate = 1n
    value = this._toBigInt(value)
    changeValue = this._toBigInt(changeValue)
    fee = this._toBigInt(fee)

    const legacyPrevTxCache = new Map()
    const getPrevTxHex = async (txid) => {
      if (legacyPrevTxCache.has(txid)) return legacyPrevTxCache.get(txid)
      const hex = await this._client.getTransaction(txid)
      legacyPrevTxCache.set(txid, hex)
      return hex
    }

    const buildAndSign = async (rcptVal, chgVal) => {
      if (!this._masterNode || !this._account) {
        throw new Error('Wallet account has been disposed or not properly initialized. Cannot build transaction.')
      }

      if (this._scriptType === 'P2TR') {
        if (!this._internalPubkey || this._internalPubkey.length !== 32) {
          throw new Error('P2TR wallet not properly initialized. Internal public key is missing or invalid.')
        }
      }

      const psbt = new Psbt({ network: this._network })

      for (const utxo of utxos) {
        await WalletAccountBtc._addAccountInput(this, psbt, utxo, getPrevTxHex)
      }

      psbt.addOutput({ address: to, value: rcptVal })

      for (const output of additionalOutputs) {
        if (output.script) {
          if (output.value !== 0 && output.value !== 0n) {
            throw new Error('OP_RETURN outputs must have value 0')
          }
          psbt.addOutput({ script: output.script, value: 0n })
        } else if (output.address) {
          psbt.addOutput({
            address: output.address,
            value: this._toBigInt(output.value)
          })
        } else {
          throw new Error('Additional output must have either "script" or "address" property')
        }
      }

      if (chgVal > 0n) psbt.addOutput({ address: await this.getAddress(), value: chgVal })

      for (let index = 0; index < utxos.length; index++) {
        WalletAccountBtc._signAccountInput(this, psbt, index)
      }

      psbt.finalizeAllInputs()
      return psbt.extractTransaction()
    }

    let currentRecipientAmnt = value
    let currentChange = changeValue

    let tx = await buildAndSign(currentRecipientAmnt, currentChange)
    let vsize = tx.virtualSize()
    let requiredFee = BigInt(vsize) * feeRate

    if (requiredFee <= fee) {
      return { txid: tx.getId(), hex: tx.toHex(), fee, vsize }
    }

    const dustLimit = this._dustLimit

    const delta = requiredFee - fee
    fee = requiredFee

    if (currentChange > 0n) {
      let newChange = currentChange - delta
      if (newChange <= dustLimit) newChange = 0n
      currentChange = newChange
      tx = await buildAndSign(currentRecipientAmnt, currentChange)
    } else {
      const newRecipientAmnt = currentRecipientAmnt - delta
      if (newRecipientAmnt <= dustLimit) {
        throw new Error(`The amount after fees must be bigger than the dust limit (= ${dustLimit}).`)
      }
      currentRecipientAmnt = newRecipientAmnt
      tx = await buildAndSign(currentRecipientAmnt, currentChange)
    }

    vsize = tx.virtualSize()
    requiredFee = BigInt(vsize) * feeRate
    if (requiredFee > fee) throw new Error('Fee shortfall after output rebalance.')

    return { txid: tx.getId(), hex: tx.toHex(), fee, vsize }
  }

  /** @private */
  async _buildSignedTransaction ({ to, value, feeRate, confirmationTarget = 1 }) {
    await this._ensureConnected()
    const address = await this.getAddress()
    if (!feeRate) {
      const feeEstimate = await this._client.estimateFee(confirmationTarget)
      feeRate = this._toBigInt(Math.max(feeEstimate * 100_000, 1))
    }
    const { utxos, fee, changeValue } = await this._planSpend({
      fromAddress: address, toAddress: to, amount: value, feeRate
    })
    const tx = await this._getRawTransaction({ utxos, to, value, fee, feeRate, changeValue })
    return { tx, utxos }
  }
}
