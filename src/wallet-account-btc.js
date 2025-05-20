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

import { crypto, Psbt } from 'bitcoinjs-lib'
import BigNumber from 'bignumber.js'

const DUST_LIMIT = 546

/**
 * @typedef {Object} KeyPair
 * @property {string} publicKey - The public key.
 * @property {string} privateKey - The private key.
 */

/**
 * @typedef {Object} BtcTransaction
 * @property {string} to - The transaction's recipient.
 * @property {number} value - The amount of bitcoins to send to the recipient (in satoshis).
 */

/**
 * @typedef {Object} BtcTransfer
 * @property {string} txid - The transaction ID.
 * @property {number} vout - The index of the output in the transaction.
 * @property {"incoming"|"outgoing"} direction - Direction of the transfer.
 * @property {number} value - The value of the transfer in BTC.
 * @property {?number} fee - The fee paid for the full transaction (in BTC).
 * @property {?string} recipient - The receiving address for outgoing transfers.
 * @property {number} height - The block height (0 if unconfirmed).
 * @property {string} address - The user's own address.
 */

export default class WalletAccountBtc {
  #path
  #index
  #address
  #keyPair

  #electrumClient
  #bip32

  constructor (config) {
    this.#path = config.path
    this.#index = config.index
    this.#address = config.address
    this.#keyPair = config.keyPair

    this.#electrumClient = config.electrumClient

    this.#bip32 = config.bip32
  }

  /**
   * The derivation path of this account (see [BIP-84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)).
   *
   * @type {number}
   */
  get path () {
    return this.#path
  }

  /**
   * The derivation path's index of this account.
   *
   * @type {number}
   */
  get index () {
    return this.#index
  }

  /**
   * The account's key pair.
   *
   * @type {KeyPair}
   */
  get keyPair () {
    return this.#keyPair
  }

  /**
   * Returns the account's address.
   *
   * @returns {Promise<string>} The account's address.
   */
  async getAddress () {
    return this.#address
  }

  /**
   * Signs a message.
   *
   * @param {string} message - The message to sign.
   * @returns {Promise<string>} The message's signature.
   */
  async sign (message) {
    const messageHash = crypto.sha256(Buffer.from(message))

    return this.#bip32.sign(messageHash).toString('base64')
  }

  /**
   * Verifies a message's signature.
   *
   * @param {string} message - The original message.
   * @param {string} signature - The signature to verify.
   * @returns {Promise<boolean>} True if the signature is valid.
   */
  async verify (message, signature) {
    try {
      const messageHash = crypto.sha256(Buffer.from(message))
      const signatureBuffer = Buffer.from(signature, 'base64')
      const result = this.#bip32.verify(messageHash, signatureBuffer)

      return result
    } catch (_) {
      return false
    }
  }

  /**
   * Quote transactions
   *
   * @param {BtcTransaction} tx - The transaction to send.
   * @returns {Promise<number>} The fee in satoshis
   */
  async quoteTransaction ({ to, value }) {
    const tx = await this.#createTransaction({ recipient: to, amount: value })
    return tx.fee
  }

  /**
   * Sends a transaction with arbitrary data.
   *
   * @param {BtcTransaction} tx - The transaction to send.
   * @returns {Promise<string>} The transaction's hash.
   */
  async sendTransaction ({ to, value }) {
    const tx = await this.#createTransaction({ recipient: to, amount: value })
    try {
      await this.#broadcastTransaction(tx.hex)
    } catch (err) {
      console.log(err)
      throw new Error('failed to broadcast tx')
    }
    return tx.txid
  }

  /**
   * Returns the account's native token balance.
   * 
   * @returns {Promise<number>} The native token balance.
   */
  async getBalance() {
    const addr = await this.getAddress()
    const { confirmed } = await this.#electrumClient.getBalance(addr)
    return confirmed
  }

  /**
   * Returns the balance of the account for a specific token.
   * 
   * @param {string} tokenAddress - The smart contract address of the token.
   * @returns {Promise<number>} The token balance.
   */
  async getTokenBalance(tokenAddress) {
    throw new Error("Not supported on the bitcoin blockchain.")
  }

  async #createTransaction ({ recipient, amount }) {
    let feeRate
    try {
      const feeEstimate = await this.#electrumClient.getFeeEstimate(1)
      feeRate = new BigNumber(feeEstimate).multipliedBy(100000)
    } catch (err) {
      console.error('Electrum client error:', err)
      throw new Error('Failed to estimate fee: ' + err.message)
    }

    const addr = await this.getAddress()
    const utxoSet = await this.#collectUtxos(amount, addr)
    return await this.#generateRawTx(
      utxoSet,
      amount,
      recipient,
      feeRate
    )
  }

  async #collectUtxos (amount, address) {
    let unspent
    try {
      unspent = await this.#electrumClient.getUnspent(address)
    } catch (err) {
      console.error('Electrum client error:', err)
      throw new Error('Failed to fetch UTXOs: ' + err.message)
    }

    if (!unspent || unspent.length === 0) {
      throw new Error('No unspent outputs available')
    }

    const collected = []
    let totalCollected = new BigNumber(0)

    for (const utxo of unspent) {
      try {
        const tx = await this.#electrumClient.getTransaction(utxo.tx_hash)
        const vout = tx.vout[utxo.tx_pos]
        collected.push({
          ...utxo,
          vout
        })
        totalCollected = totalCollected.plus(utxo.value)

        if (totalCollected.isGreaterThanOrEqualTo(amount)) {
          break
        }
      } catch (err) {
        console.error('Electrum client error:', err)
        throw new Error('Failed to fetch transaction: ' + err.message)
      }
    }

    return collected
  }

  async #generateRawTx (utxoSet, sendAmount, recipient, feeRate) {
    if (+sendAmount <= DUST_LIMIT) {
      throw new Error(
        'send amount must be bigger than dust limit ' +
          DUST_LIMIT +
          ' got: ' +
          sendAmount
      )
    }

    let totalInput = new BigNumber(0)
    for (const utxo of utxoSet) {
      totalInput = totalInput.plus(utxo.value)
    }

    const createPsbt = async (fee) => {
      const psbt = new Psbt({ network: this.#electrumClient.network })

      utxoSet.forEach((utxo, index) => {
        psbt.addInput({
          hash: utxo.tx_hash,
          index: utxo.tx_pos,
          witnessUtxo: {
            script: Buffer.from(utxo.vout.scriptPubKey.hex, 'hex'),
            value: utxo.value
          },
          bip32Derivation: [
            {
              masterFingerprint: this.#bip32.fingerprint,
              path: this.path,
              pubkey: Buffer.from(this.keyPair.publicKey, 'hex')
            }
          ]
        })
      })

      psbt.addOutput({
        address: recipient,
        value: sendAmount
      })

      const change = totalInput.minus(sendAmount).minus(fee)
      const addr = await this.getAddress()
      if (change.isGreaterThan(DUST_LIMIT)) {
        psbt.addOutput({
          address: addr,
          value: change.toNumber()
        })
      } else if (change.isLessThan(0)) {
        throw new Error('Insufficient balance.')
      }

      utxoSet.forEach((utxo, index) => {
        psbt.signInputHD(index, this.#bip32)
      })

      psbt.finalizeAllInputs()
      return psbt
    }

    let psbt = await createPsbt(0)
    const dummyTx = psbt.extractTransaction()
    let estimatedFee = new BigNumber(feeRate)
      .multipliedBy(dummyTx.virtualSize())
      .integerValue(BigNumber.ROUND_CEIL)

    const minRelayFee = new BigNumber(141)
    estimatedFee = BigNumber.max(estimatedFee, minRelayFee)

    psbt = await createPsbt(estimatedFee)
    const tx = psbt.extractTransaction()
    const txHex = tx.toHex()
    const txId = tx.getId()
    return {
      txid: txId,
      hex: txHex,
      fee: estimatedFee
    }
  }

  #satsToBtc (sats) {
    const SATOSHIS_PER_BTC = new BigNumber('100000000')
    return new BigNumber(sats).dividedBy(SATOSHIS_PER_BTC).toFixed(8)
  }

  async getBalance () {
    const addr = await this.getAddress()
    const res = await this.#electrumClient.getBalance(addr)
    const btc = this.#satsToBtc(res.confirmed)
    return +btc
  }

  async #broadcastTransaction (txHex) {
    try {
      return await this.#electrumClient.broadcastTransaction(txHex)
    } catch (err) {
      console.error('Electrum broadcast error:', err)
      throw new Error('Failed to broadcast transaction: ' + err.message)
    }
  }

  /**
  * Returns per-output transfer records (one per vout) for this wallet.
  * @param {Object} [options] - Optional filters and pagination.
  * @param {"incoming"|"outgoing"|"all"} [options.direction="all"] - Direction filter.
  * @param {number} [options.limit=10] - Max number of transfers to return.
  * @param {number} [options.skip=0] - Number of transactions to skip.
  * @returns {Promise<BtcTransfers>} A list of transfers (one per vout).
  */
  async getTransfers (options = {}) {
    const direction = options.direction || 'all'
    const limit = options.limit ?? 10
    const skip = options.skip ?? 0
    const address = await this.getAddress()

    const history = await this.#electrumClient.getHistory(address)
    const transfers = []

    const isAddressMatch = (scriptPubKey, addr) => {
      if (!scriptPubKey) return false
      if (scriptPubKey.address) return scriptPubKey.address === addr
      if (Array.isArray(scriptPubKey.addresses)) return scriptPubKey.addresses.includes(addr)
      return false
    }

    const extractAddress = (scriptPubKey) => {
      if (!scriptPubKey) return null
      if (scriptPubKey.address) return scriptPubKey.address
      if (Array.isArray(scriptPubKey.addresses)) return scriptPubKey.addresses[0]
      return null
    }

    const getInputValue = async (vinList) => {
      let total = 0
      for (const vin of vinList) {
        try {
          const prevTx = await this.#electrumClient.getTransaction(vin.txid)
          const prevVout = prevTx.vout[vin.vout]
          total += prevVout.value
        } catch (_) {}
      }
      return total
    }

    const isOutgoingTx = async (vinList) => {
      for (const vin of vinList) {
        try {
          const prevTx = await this.#electrumClient.getTransaction(vin.txid)
          const prevVout = prevTx.vout[vin.vout]
          if (isAddressMatch(prevVout.scriptPubKey, address)) return true
        } catch (_) {}
      }
      return false
    }

    for (const item of history.slice(skip)) {
      if (transfers.length >= limit) break

      const tx = await this.#electrumClient.getTransaction(item.tx_hash)
      const totalInput = await getInputValue(tx.vin)
      const totalOutput = tx.vout.reduce((sum, vout) => sum + vout.value, 0)
      const fee = totalInput > 0 ? +(totalInput - totalOutput).toFixed(8) : null
      const isOutgoing = await isOutgoingTx(tx.vin)

      for (const [index, vout] of tx.vout.entries()) {
        const recipientAddr = extractAddress(vout.scriptPubKey)
        const isToSelf = isAddressMatch(vout.scriptPubKey, address)

        let directionType = null
        if (isToSelf && !isOutgoing) directionType = 'incoming'
        else if (!isToSelf && isOutgoing) directionType = 'outgoing'
        else if (isToSelf && isOutgoing) directionType = 'change'
        else continue // skip dust/irrelevant output

        // we ignore change tx
        if (directionType === 'change') continue
        if (direction !== 'all' && direction !== directionType) continue
        if (transfers.length >= limit) break

        transfers.push({
          txid: item.tx_hash,
          vout: index,
          direction: directionType,
          value: vout.value,
          fee,
          recipient: recipientAddr,
          height: item.height,
          address
        })
      }
    }

    return transfers
  }
}
