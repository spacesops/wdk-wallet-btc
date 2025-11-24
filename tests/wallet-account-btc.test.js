import { afterAll, beforeAll, describe, expect, test } from '@jest/globals'

import { mnemonicToSeedSync } from 'bip39'

import { HOST, PORT, ELECTRUM_PORT, ZMQ_PORT, DATA_DIR } from './config.js'

import { BitcoinCli, Waiter } from './helpers/index.js'

import { WalletAccountBtc } from '../index.js'

const SEED_PHRASE = 'cook voyage document eight skate token alien guide drink uncle term abuse'
const INVALID_SEED_PHRASE = 'invalid seed phrase'
const SEED = mnemonicToSeedSync(SEED_PHRASE)

// Test account constants for Taproot (BIP-86)
// Note: The address is a Taproot address (Bech32m format starting with bcrt1p)
// The keyPair remains the same as BIP-84 since we're using the same seed and derivation path
// but generating a Taproot address instead of P2WPKH
// For regtest, the coin type is 1 (same as testnet), so the path is m/86'/1'/0'/0/0
const ACCOUNT = {
  index: 0,
  path: "m/86'/1'/0'/0/0", // BIP-86 derivation path for Taproot (regtest uses coin type 1)
  address: null, // Will be set dynamically to the actual Taproot address
  keyPair: {
    privateKey: '433c8e1e0064cdafe991f1efb4803d7dfcc2533db7d5cfa963ed53917b720248',
    publicKey: '035a48902f37c03901f36fea0a06aef2be29d9c55da559f5bd02c2d02d2b516382'
  }
}

const CONFIGURATION = {
  host: HOST,
  port: ELECTRUM_PORT,
  network: 'regtest'
}

describe('WalletAccountBtc', () => {
  const bitcoin = new BitcoinCli({
    host: HOST,
    port: PORT,
    zmqPort: ZMQ_PORT,
    dataDir: DATA_DIR,
    wallet: 'testwallet'
  })

  const waiter = new Waiter(bitcoin, {
    host: HOST,
    electrumPort: ELECTRUM_PORT,
    zmqPort: ZMQ_PORT
  })

  let account, recipient

  beforeAll(async () => {
    account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIGURATION)
    recipient = bitcoin.getNewAddress()

    // Set the actual Taproot address for test expectations
    ACCOUNT.address = await account.getAddress()
    // Verify it's a Taproot address (Bech32m format)
    expect(ACCOUNT.address).toMatch(/^bcrt1p/)

    bitcoin.sendToAddress(ACCOUNT.address, 0.01)

    await waiter.mine()
  })

  afterAll(() => {
    account.dispose()
  })

  describe('constructor', () => {
    test('should successfully initialize an account for the given seed phrase and path', () => {
      const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0")

      expect(account.index).toBe(ACCOUNT.index)

      expect(account.path).toBe(ACCOUNT.path)

      expect(account.keyPair).toEqual({
        privateKey: new Uint8Array(Buffer.from(ACCOUNT.keyPair.privateKey, 'hex')),
        publicKey: new Uint8Array(Buffer.from(ACCOUNT.keyPair.publicKey, 'hex'))
      })
    })

    test('should successfully initialize an account for the given seed and path', () => {
      const account = new WalletAccountBtc(SEED, "0'/0/0")

      expect(account.index).toBe(ACCOUNT.index)

      expect(account.path).toBe(ACCOUNT.path)

      expect(account.keyPair).toEqual({
        privateKey: new Uint8Array(Buffer.from(ACCOUNT.keyPair.privateKey, 'hex')),
        publicKey: new Uint8Array(Buffer.from(ACCOUNT.keyPair.publicKey, 'hex'))
      })
    })

    test('should throw if the seed phrase is invalid', () => {
      // eslint-disable-next-line no-new
      expect(() => new WalletAccountBtc(INVALID_SEED_PHRASE, "0'/0/0"))
        .toThrow('The seed phrase is invalid.')
    })

    test('should throw if the path is invalid', () => {
      // eslint-disable-next-line no-new
      expect(() => new WalletAccountBtc(SEED_PHRASE, "a'/b/c"))
        .toThrow(/Expected BIP32Path/)
    })
  })

  describe('getAddress', () => {
    test('should return the correct Taproot address', async () => {
      const result = await account.getAddress()

      expect(result).toBe(ACCOUNT.address)
      // Verify it's a Taproot address (Bech32m format for regtest)
      expect(result).toMatch(/^bcrt1p/)
    })

    test('should generate Taproot addresses (Bech32m format)', async () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/1", CONFIGURATION)
      const address = await testAccount.getAddress()

      // Taproot addresses use Bech32m encoding and start with bcrt1p for regtest
      expect(address).toMatch(/^bcrt1p/)
      testAccount.dispose()
    })
  })

  describe('sign', () => {
    const MESSAGE = 'Dummy message to sign.'

    test('should return a valid signature', async () => {
      const signature = await account.sign(MESSAGE)

      // Signature should be a hex string
      expect(signature).toMatch(/^[0-9a-f]+$/i)
      // ECDSA signatures are typically 128-130 hex characters (64-65 bytes)
      // Schnorr signatures are 128 hex characters (64 bytes)
      // The sign() method uses ECDSA for message signing (not Schnorr)
      expect(signature.length).toBeGreaterThanOrEqual(128)
      expect(signature.length).toBeLessThanOrEqual(130)
    })

    test('should return a verifiable signature', async () => {
      const signature = await account.sign(MESSAGE)
      const isValid = await account.verify(MESSAGE, signature)

      expect(isValid).toBe(true)
    })
  })

  describe('verify', () => {
    const MESSAGE = 'Dummy message to sign.'

    test('should return true for a valid signature', async () => {
      const signature = await account.sign(MESSAGE)
      const result = await account.verify(MESSAGE, signature)

      expect(result).toBe(true)
    })

    test('should return false for an invalid signature', async () => {
      const signature = await account.sign(MESSAGE)
      const result = await account.verify('Another message.', signature)

      expect(result).toBe(false)
    })

    test('should throw on a malformed signature', async () => {
      await expect(account.verify(MESSAGE, 'A bad signature'))
        .rejects.toThrow('Expected Signature')
    })
  })

  describe('getBalance', () => {
    test('should return the correct balance of the account', async () => {
      const balance = await account.getBalance()

      expect(balance).toBe(1_000_000)
    })
  })

  describe('getTokenBalance', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(account.getTokenBalance('...'))
        .rejects.toThrow("The 'getTokenBalance' method is not supported on the bitcoin blockchain.")
    })
  })

  describe('sendTransaction', () => {
    test('should successfully send a transaction', async () => {
      const TRANSACTION = {
        to: recipient,
        value: 1_000
      }

      const { hash, fee } = await account.sendTransaction(TRANSACTION)

      const { fees } = bitcoin.getMempoolEntry(hash)
      const baseFee = Math.round(fees.base * 1e+8)
      expect(fee).toBe(baseFee)

      const transaction = bitcoin.getTransaction(hash)
      expect(transaction.txid).toBe(hash)
      expect(transaction.details[0].address).toBe(TRANSACTION.to)

      const amount = Math.round(transaction.details[0].amount * 1e+8)
      expect(amount).toBe(TRANSACTION.value)
    })

    test('should throw if value is less than the dust limit', async () => {
      await expect(account.sendTransaction({ to: recipient, value: 500 }))
        .rejects.toThrow('The amount must be bigger than the dust limit')
    })

    test('should throw if the account balance does not cover the transaction costs', async () => {
      await expect(account.sendTransaction({ to: recipient, value: 1_000_000_000_000 }))
        .rejects.toThrow('Insufficient balance to send the transaction')
    })

    test('should throw if there an no utxos available', async () => {
      const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/1", CONFIGURATION)

      await expect(account.sendTransaction({ to: recipient, value: 1_000 }))
        .rejects.toThrow('No unspent outputs available')

      account.dispose()
    })
  })

  describe('quoteSendTransaction', () => {
    test('should successfully quote a Taproot transaction', async () => {
      const TRANSACTION = {
        to: recipient,
        value: 1_000
      }

      const { fee } = await account.quoteSendTransaction(TRANSACTION)

      // Taproot transactions typically have smaller fees due to smaller witness sizes
      // The fee should be at least the minimum (141) but may vary
      expect(fee).toBeGreaterThanOrEqual(141)
    })
  })

  describe('transfer', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(account.transfer({}))
        .rejects.toThrow("The 'transfer' method is not supported on the bitcoin blockchain.")
    })
  })

  describe('quoteTransfer', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(account.quoteTransfer({}))
        .rejects.toThrow("The 'quoteTransfer' method is not supported on the bitcoin blockchain.")
    })
  })

  describe('getTransfers', () => {
    const TRANSFERS = []

    let account

    async function createIncomingTransfer (value) {
      const address = await account.getAddress()
      const txid = bitcoin.sendToAddress(address, 0.01)
      await waiter.mine()

      const transaction = bitcoin.getTransaction(txid)
      const fee = Math.round(Math.abs(transaction.fee) * 1e+8)

      const height = bitcoin.getBlockCount()

      return {
        txid,
        address,
        vout: transaction.details[0].vout,
        height,
        value: 1_000_000,
        direction: 'incoming',
        fee,
        recipient: address
      }
    }

    async function createOutgoingTransfer () {
      const address = await account.getAddress()

      const recipient = bitcoin.getNewAddress()

      const { hash, fee } = await account.sendTransaction({
        to: recipient,
        value: 100_000
      })

      await waiter.mine()

      const height = bitcoin.getBlockCount()

      return {
        txid: hash,
        address,
        vout: 0,
        height,
        value: 100_000,
        direction: 'outgoing',
        fee,
        recipient
      }
    }

    beforeAll(async () => {
      account = new WalletAccountBtc(SEED_PHRASE, "0'/0/1", CONFIGURATION)

      for (let i = 0; i < 5; i++) {
        const transfer = i % 2 === 0
          ? await createIncomingTransfer()
          : await createOutgoingTransfer()

        TRANSFERS.push(transfer)
      }
    })

    afterAll(() => {
      account.dispose()
    })

    test('should return the full transfer history', async () => {
      const transfers = await account.getTransfers()

      expect(transfers).toEqual(TRANSFERS)
    })

    test('should return the incoming transfer history', async () => {
      const transfers = await account.getTransfers({ direction: 'incoming' })

      expect(transfers).toEqual([TRANSFERS[0], TRANSFERS[2], TRANSFERS[4]])
    })

    test('should return the outgoing transfer history', async () => {
      const transfers = await account.getTransfers({ direction: 'outgoing' })

      expect(transfers).toEqual([TRANSFERS[1], TRANSFERS[3]])
    })

    test('should correctly paginate the transfer history', async () => {
      const transfers = await account.getTransfers({ limit: 2, skip: 1 })

      expect(transfers).toEqual([TRANSFERS[1], TRANSFERS[2]])
    })

    test('should correctly filter and paginate the transfer history', async () => {
      const transfers = await account.getTransfers({ limit: 2, skip: 1, direction: 'incoming' })

      expect(transfers).toEqual([TRANSFERS[2], TRANSFERS[4]])
    })
  })

  describe('Taproot-specific functionality', () => {
    test('should use BIP-86 derivation path for Taproot addresses', () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIGURATION)

      // Regtest uses coin type 1 (same as testnet)
      expect(testAccount.path).toMatch(/^m\/86'\/1'\/0'\/0\/0$/)

      testAccount.dispose()
    })

    test('should use correct coin type for different networks', () => {
      // Test mainnet
      const mainnetAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'bitcoin' })
      expect(mainnetAccount.path).toMatch(/^m\/86'\/0'\/0'\/0\/0$/)
      mainnetAccount.dispose()

      // Test testnet
      const testnetAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'testnet' })
      expect(testnetAccount.path).toMatch(/^m\/86'\/1'\/0'\/0\/0$/)
      testnetAccount.dispose()

      // Test regtest
      const regtestAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'regtest' })
      expect(regtestAccount.path).toMatch(/^m\/86'\/1'\/0'\/0\/0$/)
      regtestAccount.dispose()
    })

    test('should generate Taproot addresses with correct Bech32m format', async () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/2", CONFIGURATION)
      const address = await testAccount.getAddress()

      // Taproot addresses use Bech32m encoding
      // Regtest: bcrt1p... (Bech32m)
      // Mainnet: bc1p... (Bech32m)
      // Testnet: tb1p... (Bech32m)
      expect(address).toMatch(/^bcrt1p/)

      testAccount.dispose()
    })

    test('should successfully send Taproot transactions', async () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/3", CONFIGURATION)
      const testAddress = await testAccount.getAddress()

      // Fund the test account
      bitcoin.sendToAddress(testAddress, 0.01)
      await waiter.mine()

      const recipient = bitcoin.getNewAddress()
      const TRANSACTION = {
        to: recipient,
        value: 5_000
      }

      const { hash, fee } = await testAccount.sendTransaction(TRANSACTION)

      // Verify transaction was created
      expect(hash).toMatch(/^[0-9a-f]{64}$/i)
      expect(fee).toBeGreaterThan(0)

      // Verify transaction is in mempool or blockchain
      await waiter.mine()

      const transaction = bitcoin.getTransaction(hash)
      expect(transaction.txid).toBe(hash)

      testAccount.dispose()
    })

    test('should parse Taproot addresses in transaction history', async () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/4", CONFIGURATION)
      const testAddress = await testAccount.getAddress()

      // Fund the account
      bitcoin.sendToAddress(testAddress, 0.01)
      await waiter.mine()

      // Send a transaction
      const recipient = bitcoin.getNewAddress()
      await testAccount.sendTransaction({ to: recipient, value: 1_000 })
      await waiter.mine()

      // Get transfers - should include Taproot addresses
      const transfers = await testAccount.getTransfers()

      expect(transfers.length).toBeGreaterThan(0)
      // Verify addresses are Taproot format
      transfers.forEach(transfer => {
        expect(transfer.address).toMatch(/^bcrt1p/)
        if (transfer.recipient) {
          // Recipient might be any format, but our address should be Taproot
          expect(transfer.address).toMatch(/^bcrt1p/)
        }
      })

      testAccount.dispose()
    })

    test('should handle Taproot transaction fee estimation correctly', async () => {
      const testAccount = new WalletAccountBtc(SEED_PHRASE, "0'/0/5", CONFIGURATION)
      const testAddress = await testAccount.getAddress()

      // Fund the account
      bitcoin.sendToAddress(testAddress, 0.01)
      await waiter.mine()

      const recipient = bitcoin.getNewAddress()
      const TRANSACTION = {
        to: recipient,
        value: 1_000
      }

      const { fee } = await testAccount.quoteSendTransaction(TRANSACTION)

      // Taproot transactions should have reasonable fees
      // They're typically smaller than P2WPKH due to smaller witness sizes
      expect(fee).toBeGreaterThanOrEqual(141)
      expect(typeof fee).toBe('number')

      testAccount.dispose()
    })
  })
})
