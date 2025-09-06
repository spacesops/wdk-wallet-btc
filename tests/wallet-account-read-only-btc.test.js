import { afterAll, beforeAll, describe, expect, test } from '@jest/globals'

import { HOST, PORT, ELECTRUM_PORT, ZMQ_PORT, DATA_DIR } from './config.js'

import { BitcoinCli, Waiter } from './helpers/index.js'

import { WalletAccountReadOnlyBtc } from '../index.js'

const ADDRESSES = {
  44: 'mfXn8RBVY9dNiggLAX8oFdjbYk8UNZi8La',
  84: 'bcrt1q56sfepv68sf2xfm2kgk3ea2mdjzswljl3r3tdx'
}

const FEES = {
  44: 223n,
  84: 141n
}

describe.each([44, 84])('WalletAccountReadOnlyBtc', (bip) => {
  const CONFIGURATION = {
    host: HOST,
    port: ELECTRUM_PORT,
    network: 'regtest',
    bip
  }

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
    account = new WalletAccountReadOnlyBtc(ADDRESSES[bip], CONFIGURATION)
    recipient = bitcoin.getNewAddress()

    bitcoin.sendToAddress(ADDRESSES[bip], 0.01)

    await waiter.mine()
  })

  afterAll(async () => {
    account._electrumClient.close()
  })

  describe('getBalance', () => {
    test('should return the correct balance of the account', async () => {
      const balance = await account.getBalance()

      expect(balance).toBe(1_000_000n)
    })
  })

  describe('getTokenBalance', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(account.getTokenBalance('...'))
        .rejects.toThrow("The 'getTokenBalance' method is not supported on the bitcoin blockchain.")
    })
  })

  describe('quoteSendTransaction', () => {
    test('should successfully quote a transaction', async () => {
      const TRANSACTION = {
        to: recipient,
        value: 1_000
      }

      const { fee } = await account.quoteSendTransaction(TRANSACTION)

      expect(fee).toBe(FEES[bip])
    })
  })

  describe('quoteTransfer', () => {
    test('should throw an unsupported operation error', async () => {
      await expect(account.quoteTransfer({}))
        .rejects.toThrow("The 'quoteTransfer' method is not supported on the bitcoin blockchain.")
    })
  })
})
