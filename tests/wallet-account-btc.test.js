import { afterAll, beforeAll, describe, expect, test } from '@jest/globals'

import { HOST, PORT, ELECTRUM_PORT, ZMQ_PORT, DATA_DIR, ACCOUNT_CONFIG } from './config.js'
import accountFixtures, { BitcoinCli, Waiter } from './helpers/index.js'

import { WalletAccountBtc, WalletAccountReadOnlyBtc } from '../index.js'

const {
  SEED_PHRASE,
  SEED,
  getExpectedSignature,
  ACCOUNT_BIP44,
  ACCOUNT_BIP84
} = accountFixtures

const DUST_LIMIT = 546

const bipVariants = [
  {
    bip: 44,
    expectedAccount: ACCOUNT_BIP44,
    getSignature: (msg) => getExpectedSignature(0, msg, 44)
  },
  {
    bip: 84,
    expectedAccount: ACCOUNT_BIP84,
    getSignature: (msg) => getExpectedSignature(0, msg, 84)
  }
]

for (const { bip, expectedAccount, getSignature } of bipVariants) {
  describe(`WalletAccountBtc (BIP${bip})`, () => {
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
      account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { ...ACCOUNT_CONFIG, bip })
      recipient = bitcoin.getNewAddress()

      bitcoin.sendToAddress(expectedAccount.address, 0.01)
      await waiter.mine()
    })

    afterAll(() => {
      account.dispose()
    })

    describe('constructor', () => {
      test('should successfully initialize an account for the given seed phrase and path', () => {
        const acc = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { ...ACCOUNT_CONFIG, bip })
        expect(acc.index).toBe(expectedAccount.index)
        expect(acc.path).toBe(expectedAccount.path)
        expect(acc.keyPair).toEqual({
          privateKey: new Uint8Array(Buffer.from(expectedAccount.keyPair.privateKey, 'hex')),
          publicKey: new Uint8Array(Buffer.from(expectedAccount.keyPair.publicKey, 'hex'))
        })
        acc.dispose()
      })

      test('should successfully initialize an account for the given seed and path', () => {
        const acc = new WalletAccountBtc(SEED, "0'/0/0", { ...ACCOUNT_CONFIG, bip })
        expect(acc.index).toBe(expectedAccount.index)
        expect(acc.path).toBe(expectedAccount.path)
        expect(acc.keyPair).toEqual({
          privateKey: new Uint8Array(Buffer.from(expectedAccount.keyPair.privateKey, 'hex')),
          publicKey: new Uint8Array(Buffer.from(expectedAccount.keyPair.publicKey, 'hex'))
        })
        acc.dispose()
      })

      test('should throw if the seed phrase is invalid', () => {
        const INVALID_SEED_PHRASE = 'invalid seed phrase'
        expect(() => new WalletAccountBtc(INVALID_SEED_PHRASE, "0'/0/0", { ...ACCOUNT_CONFIG, bip }))
          .toThrow('The seed phrase is invalid.')
      })

      test('should throw if the path is invalid', () => {
        expect(() => new WalletAccountBtc(SEED_PHRASE, "a'/b/c", { ...ACCOUNT_CONFIG, bip }))
          .toThrow(/Expected BIP32Path/)
      })

      test('should throw for unsupported bip type', () => {
        expect(() => new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { bip: 33 }))
          .toThrow(/Unsupported BIP type/)
      })
    })

    describe('sign', () => {
      const MESSAGE = 'Dummy message to sign.'
      const EXPECTED_SIG = getSignature(MESSAGE)

      test('should return the correct signature', async () => {
        const signature = await account.sign(MESSAGE)
        expect(signature).toBe(EXPECTED_SIG)
      })
    })

    describe('verify', () => {
      const MESSAGE = 'Dummy message to sign.'
      const EXPECTED_SIG = getSignature(MESSAGE)

      test('should return true for a valid signature', async () => {
        const result = await account.verify(MESSAGE, EXPECTED_SIG)
        expect(result).toBe(true)
      })

      test('should return false for an invalid signature', async () => {
        const result = await account.verify('Another message.', EXPECTED_SIG)
        expect(result).toBe(false)
      })

      test('should throw on a malformed signature', async () => {
        await expect(account.verify(MESSAGE, 'A bad signature'))
          .rejects.toThrow('Expected Signature')
      })
    })

    describe('sendTransaction', () => {
      test('should successfully send a transaction', async () => {
        const TRANSACTION = { to: recipient, value: 1_000 }
        const { hash, fee } = await account.sendTransaction(TRANSACTION)

        await waiter.mine()

        const tx = bitcoin.getTransaction(hash)
        expect(tx.txid).toBe(hash)
        expect(tx.details[0].address).toBe(TRANSACTION.to)
        const amount = Math.round(tx.details[0].amount * 1e8)
        expect(amount).toBe(TRANSACTION.value)

        const baseFee = bitcoin.getTransactionFeeSats(hash)
        expect(fee).toBe(baseFee)
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
        const unfunded = new WalletAccountBtc(SEED_PHRASE, "0'/0/18", { ...ACCOUNT_CONFIG, bip })
        await expect(unfunded.sendTransaction({ to: recipient, value: 1_000 }))
          .rejects.toThrow('No unspent outputs available')
        unfunded.dispose()
      })

      test('should create a change output when leftover > dust limit', async () => {
        const funded = new WalletAccountBtc(SEED_PHRASE, "0'/0/20", { ...ACCOUNT_CONFIG, bip })
        const addr = await funded.getAddress()
        bitcoin.sendToAddress(addr, 0.02)
        await waiter.mine()

        const TRANSACTION = { to: recipient, value: 500_000 }
        const { hash } = await funded.sendTransaction(TRANSACTION)
        await waiter.mine()

        const raw = bitcoin.getRawTransaction(hash)
        const outputs = raw.vout.map(v =>
          v.scriptPubKey.address || (v.scriptPubKey.addresses && v.scriptPubKey.addresses[0])
        )

        expect(outputs).toContain(TRANSACTION.to)
        expect(outputs).toContain(addr)

        funded.dispose()
      })

      test('should collapse dust change into fee when leftover <= dust limit', async () => {
        const funded = new WalletAccountBtc(SEED_PHRASE, "0'/0/21", { ...ACCOUNT_CONFIG, bip })
        const addr = await funded.getAddress()
        bitcoin.sendToAddress(addr, 0.001)
        await waiter.mine()

        const balance = await funded.getBalance()

        const nearMaxAmount = Math.max(1, balance - 2_000)
        const { fee: estFee } = await funded.quoteSendTransaction({ to: recipient, value: nearMaxAmount })

        const spend = Math.max(1, balance - estFee - (DUST_LIMIT - 1))

        const { hash, fee } = await funded.sendTransaction({ to: recipient, value: spend })
        await waiter.mine()

        const raw = bitcoin.getRawTransaction(hash)
        const outputs = raw.vout.map(v =>
          v.scriptPubKey.address || (v.scriptPubKey.addresses && v.scriptPubKey.addresses[0])
        )

        expect(outputs).toContain(recipient)
        expect(outputs).not.toContain(addr)
        expect(fee).toBe(balance - spend)

        funded.dispose()
      })
    })

    describe('toReadOnlyAccount', () => {
      test('should return a read-only copy of the account', async () => {
        const readOnlyAccount = await account.toReadOnlyAccount()
        expect(readOnlyAccount).toBeInstanceOf(WalletAccountReadOnlyBtc)
        expect(await readOnlyAccount.getAddress()).toBe(expectedAccount.address)
        readOnlyAccount._electrumClient.close()
      })
    })
  })
}
