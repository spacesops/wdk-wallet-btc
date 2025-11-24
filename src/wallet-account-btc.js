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

import { crypto, initEccLib, payments, Psbt, script } from 'bitcoinjs-lib'
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

const DUST_LIMIT = 546

/**
 * Gets the coin type for BIP-86 derivation path based on the network.
 * According to BIP-44:
 * - Bitcoin mainnet: coin type 0
 * - Bitcoin testnet: coin type 1
 * - Regtest: coin type 1 (same as testnet)
 *
 * @param {string} network - The network name ('bitcoin', 'testnet', or 'regtest').
 * @returns {number} The coin type (0 for mainnet, 1 for testnet/regtest).
 */
function getCoinType (network) {
  return network === 'bitcoin' ? 0 : 1
}

/**
 * Gets the BIP-86 derivation path prefix based on the network.
 *
 * @param {string} network - The network name ('bitcoin', 'testnet', or 'regtest').
 * @returns {string} The derivation path prefix (e.g., "m/86'/0'" for mainnet, "m/86'/1'" for testnet).
 */
function getBip86DerivationPathPrefix (network) {
  const coinType = getCoinType(network)
  return `m/86'/${coinType}'`
}

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
    this._electrumClient = new ElectrumClient(config)

    // Get the network from config (defaults to 'bitcoin' in ElectrumClient)
    const network = config?.network || 'bitcoin'
    const derivationPathPrefix = getBip86DerivationPathPrefix(network)

    /** @private */
    this._path = `${derivationPathPrefix}/${path}`

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
   * Creates an OP_RETURN script for embedding data in transactions.
   *
   * OP_RETURN outputs are provably unspendable and can store up to 80 bytes of data.
   * They must have value 0.
   *
   * @param {string | Buffer | Uint8Array} data - The data to embed (max 80 bytes for standardness).
   * @returns {Buffer} The compiled OP_RETURN script.
   */
  createOpReturnScript (data) {
    if (typeof data === 'string') {
      data = Buffer.from(data, 'utf8')
    } else if (!Buffer.isBuffer(data)) {
      data = Buffer.from(data)
    }
    
    if (data.length > 80) {
      throw new Error('OP_RETURN data cannot exceed 80 bytes for standard transactions')
    }
    
    // OP_RETURN (0x6a) followed by data push
    // For data <= 75 bytes, use OP_PUSHBYTES_<n> (0x01-0x4b)
    // For larger data, use OP_PUSHDATA1/2/4
    const parts = []
    parts.push(Buffer.from([0x6a])) // OP_RETURN
    
    if (data.length <= 75) {
      parts.push(Buffer.from([data.length])) // OP_PUSHBYTES_<n>
    } else if (data.length <= 0xff) {
      const lenBuf = Buffer.allocUnsafe(2)
      lenBuf.writeUInt8(0x4c, 0) // OP_PUSHDATA1
      lenBuf.writeUInt8(data.length, 1)
      parts.push(lenBuf)
    } else if (data.length <= 0xffff) {
      const lenBuf = Buffer.allocUnsafe(3)
      lenBuf.writeUInt8(0x4d, 0) // OP_PUSHDATA2
      lenBuf.writeUInt16LE(data.length, 1)
      parts.push(lenBuf)
    } else {
      const lenBuf = Buffer.allocUnsafe(5)
      lenBuf.writeUInt8(0x4e, 0) // OP_PUSHDATA4
      lenBuf.writeUInt32LE(data.length, 1)
      parts.push(lenBuf)
    }
    
    parts.push(data)
    return Buffer.concat(parts)
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
  async _getTransaction ({ recipient, amount, feeRate: customFeeRate, additionalOutputs = [] }) {
    const address = await this.getAddress()
    // Calculate total output amount including additional outputs
    const additionalOutputsTotal = additionalOutputs.reduce((sum, out) => sum.plus(out.value || 0), new BigNumber(0))
    const totalOutputAmount = new BigNumber(amount).plus(additionalOutputsTotal)
    const utxoSet = await this._getUtxos(totalOutputAmount.toNumber(), address)
    let feeRate = customFeeRate
      ? new BigNumber(customFeeRate)
      : await this._electrumClient.getFeeEstimateInSatsPerVb()

    if (feeRate.lt(1)) {
      feeRate = new BigNumber(1)
    }

    const transaction = await this._getRawTransaction(utxoSet, amount, recipient, feeRate, additionalOutputs)

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
  async _getRawTransaction (utxoSet, amount, recipient, feeRate, additionalOutputs = []) {
    if (+amount <= DUST_LIMIT) throw new Error(`The amount must be bigger than the dust limit (= ${DUST_LIMIT}).`)
    const totalInput = utxoSet.reduce((sum, utxo) => sum.plus(utxo.value), new BigNumber(0))

    const createPsbt = async (fee) => {
      const psbt = new Psbt({ network: this._electrumClient.network })
      utxoSet.forEach((utxo, index) => {
        // For Taproot (P2TR) inputs, use tapInternalKey and tapBip32Derivation
        // instead of bip32Derivation. The signInputHD method will automatically
        // use Schnorr signatures for Taproot inputs.
        // For Taproot inputs, we need tapInternalKey
        // witnessUtxo is still needed for SegWit outputs (including Taproot)
        // Note: We're omitting tapBip32Derivation to work around a validation bug in bitcoinjs-lib v6.1.7
        // We'll sign manually using signTaprootInput with a custom signer
        const inputData = {
          hash: utxo.tx_hash,
          index: utxo.tx_pos,
          witnessUtxo: { 
            script: Buffer.from(utxo.vout.scriptPubKey.hex, 'hex'), 
            value: utxo.value 
          },
          tapInternalKey: this._internalPubkey
          // tapBip32Derivation omitted due to validation bug - we'll sign manually
        }
        psbt.addInput(inputData)
        // Workaround: Directly modify PSBT internal data to bypass validation bug
        // This is non-standard but works around the validation issue in bitcoinjs-lib v6.1.7
        // We access the internal data structure and add tapBip32Derivation directly
        const inputIndex = psbt.inputCount - 1
        const input = psbt.data.inputs[inputIndex]
        if (input) {
          input.tapBip32Derivation = [{
            masterFingerprint: this._masterNode.fingerprint,
            path: this._path,
            pubkey: Buffer.from(this._internalPubkey), // Use internal pubkey (32 bytes) to match signer's publicKey
            leafHashes: [] // Empty array for key path spends (BIP86 Taproot)
          }]
        }
      })
      // Add primary recipient output
      psbt.addOutput({ address: recipient, value: amount })
      // Add any additional outputs (can be regular address outputs or OP_RETURN outputs)
      const additionalOutputsTotal = additionalOutputs.reduce((sum, out) => {
        if (out.script) {
          // OP_RETURN output: use script directly, value should be 0
          if (out.value !== undefined && out.value !== 0) {
            throw new Error('OP_RETURN outputs must have value 0')
          }
          psbt.addOutput({ script: out.script, value: 0 })
          return sum // OP_RETURN outputs don't count toward total output value
        } else if (out.address) {
          // Regular address output
          if (out.value <= DUST_LIMIT) {
            throw new Error(`Additional output amount ${out.value} is below dust limit (= ${DUST_LIMIT})`)
          }
          psbt.addOutput({ address: out.address, value: out.value })
          return sum.plus(out.value)
        } else {
          throw new Error('Additional output must have either "address" or "script" property')
        }
      }, new BigNumber(0))
      // Calculate change (total input - primary amount - additional outputs - fee)
      const change = totalInput.minus(amount).minus(additionalOutputsTotal).minus(fee)
      if (change.isGreaterThan(DUST_LIMIT)) psbt.addOutput({ address: await this.getAddress(), value: change.toNumber() })
      else if (change.isLessThan(0)) throw new Error('Insufficient balance to send the transaction.')
      // For Taproot inputs, use signTaprootInput which handles Schnorr signatures (BIP-340)
      // signInputHD doesn't support Taproot, so we use the Taproot-specific signing method
      // For Taproot key path spends, we need to tweak the private key for signing
      // Get the tweaked output key from the address (p2tr payment)
      const { output } = payments.p2tr({
        internalPubkey: this._internalPubkey,
        network: this._electrumClient.network
      })
      // Calculate tapTweak hash (BIP-341): HashTapTweak(internal_pubkey || merkle_root)
      // For key path spends, merkle_root is empty (32 zero bytes)
      const tapTweakHash = crypto.taggedHash('TapTweak', Buffer.concat([Buffer.from(this._internalPubkey), Buffer.alloc(32)]))
      // Tweak the private key: tweaked_privkey = internal_privkey + tapTweakHash
      const tweakedPrivKey = ecc.privateAdd(this._account.privateKey, tapTweakHash)
      if (!tweakedPrivKey) {
        throw new Error('Failed to tweak private key')
      }
      // Extract the x-coordinate from the output script (last 32 bytes of P2TR output)
      const tweakedOutputPubkey = output.slice(2, 34) // Skip OP_1 (0x51) and 32-byte pubkey
      const taprootSigner = {
        publicKey: tweakedOutputPubkey, // Tweaked output public key (32-byte x-coordinate)
        network: this._electrumClient.network,
        signSchnorr: (hash) => {
          // Sign with Schnorr signature using the tweaked private key
          return ecc.signSchnorr(hash, tweakedPrivKey)
        }
      }
      utxoSet.forEach((_, index) => {
        // signTaprootInput automatically uses Schnorr signatures for Taproot key path spends
        // For key path spends (BIP-86), tapLeafHashToSign is undefined (defaults to key path)
        psbt.signTaprootInput(index, taprootSigner)
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
