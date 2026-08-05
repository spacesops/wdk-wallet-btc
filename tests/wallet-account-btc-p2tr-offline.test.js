import { describe, expect, test } from '@jest/globals'

import { Transaction } from 'bitcoinjs-lib'

import { WalletAccountBtc } from '../index.js'

const SEED_PHRASE = 'cook voyage document eight skate token alien guide drink uncle term abuse'

const CONFIG = {
  network: 'regtest',
  bip: 86,
  script_type: 'P2TR'
}

function mockClient (account, { value = 200_000 } = {}) {
  const address = account._address
  const scriptHex = account.getScriptPubKeyHex(address)
  const prevTxid = '33'.repeat(32)

  account._client = {
    connect: async () => {},
    estimateFee: async () => 0.00001,
    listUnspent: async () => [{ tx_hash: prevTxid, tx_pos: 0, value, height: 1 }],
    getTransaction: async () => { throw new Error('unexpected getTransaction') },
    broadcast: async (hex) => hex,
    getBalance: async () => ({ confirmed: value, unconfirmed: 0 }),
    getHistory: async () => [],
    close: () => {}
  }

  return { prevTxid, scriptHex, address }
}

describe('WalletAccountBtc P2TR offline', () => {
  test('constructor enforces bip 86 ⇔ P2TR', () => {
    expect(() => new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { bip: 86, script_type: 'P2WPKH' }))
      .toThrow('BIP 86 requires script_type to be "P2TR"')
    expect(() => new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { bip: 84, script_type: 'P2TR' }))
      .toThrow('script_type "P2TR" requires bip to be 86')
  })

  test('infers script_type and bip from each other', async () => {
    const fromBip = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'regtest', bip: 86 })
    expect(fromBip.scriptType).toBe('P2TR')
    expect((await fromBip.getAddress()).startsWith('bcrt1p')).toBe(true)
    fromBip.dispose()

    const fromScript = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'regtest', script_type: 'P2TR' })
    expect(fromScript.path.startsWith("m/86'/")).toBe(true)
    fromScript.dispose()
  })

  test('createOpReturnScript helpers', () => {
    const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIG)
    expect(Buffer.from(account.createOpReturnScript('hi')).toString('hex')).toBe('6a026869')
    expect(Buffer.from(account.createOpReturnScriptFromHex('dead')).toString('hex')).toBe('6a02dead')
    expect(() => account.createOpReturnScriptFromHex('zz')).toThrow(/hexadecimal/)
    account.dispose()
  })

  test('getTaprootKeyMaterialHex exports sensitive key material', () => {
    const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIG)
    const material = account.getTaprootKeyMaterialHex()
    expect(material.internalPubKeyHex).toHaveLength(64)
    expect(material.privateKeyHex).toHaveLength(64)
    expect(material.tweakedPrivateKeyHex).toHaveLength(64)

    const segwit = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", { network: 'regtest', bip: 84 })
    expect(segwit.getTaprootKeyMaterialHex()).toBeNull()
    account.dispose()
    segwit.dispose()
  })

  test('quoteSendTransactionWithMemo rejects non-taproot recipients', async () => {
    const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIG)
    mockClient(account)

    await expect(account.quoteSendTransactionWithMemo({
      to: 'bcrt1q8dqnpagwt9rtl7k38nuaa2ahf690avzkm74nhn',
      value: 5_000,
      memo: 'x',
      feeRate: 1
    })).rejects.toThrow(/Taproot/)

    account.dispose()
  })

  test('quoteSendTransactionWithMemoTX builds an OP_RETURN output', async () => {
    const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIG)
    const { address } = mockClient(account)

    const hex = await account.quoteSendTransactionWithMemoTX({
      to: address,
      value: 5_000,
      memo: 'memo',
      feeRate: 1
    })
    const tx = Transaction.fromHex(hex)
    expect(tx.outs.some(out => out.script[0] === 0x6a && BigInt(out.value) === 0n)).toBe(true)

    account.dispose()
  })

  test('quoteUpdateTransactionWithHexTX signs a two-input compose path', async () => {
    const account = new WalletAccountBtc(SEED_PHRASE, "0'/0/0", CONFIG)
    const prior = new WalletAccountBtc(SEED_PHRASE, "0'/0/1", CONFIG)
    const { address, prevTxid } = mockClient(account)
    const priorAddress = await prior.getAddress()
    const priorScript = prior.getScriptPubKeyHex(priorAddress)
    const accountScript = account.getScriptPubKeyHex(address)

    const priorTx = new Transaction()
    priorTx.version = 2
    priorTx.addInput(Buffer.alloc(32), 0)
    priorTx.addOutput(Buffer.from(priorScript, 'hex'), 1077n)
    priorTx.addOutput(Buffer.from(accountScript, 'hex'), 50_000n)
    const priorHex = priorTx.toHex()
    const priorId = priorTx.getId()

    account._client.getTransaction = async (txid) => {
      if (txid === priorId) return priorHex
      throw new Error(`unexpected ${txid}`)
    }
    account._client.listUnspent = async () => [{ tx_hash: prevTxid, tx_pos: 0, value: 200_000, height: 1 }]

    const { hex, fee } = await account.quoteUpdateTransactionWithHexTX({
      to: address,
      hex: 'cafebabe',
      priorTx: priorId,
      priorAcct: prior,
      value: 1077,
      feeRate: 1
    })

    const tx = Transaction.fromHex(hex)
    expect(tx.ins).toHaveLength(2)
    expect(tx.outs.some(out => out.script[0] === 0x6a)).toBe(true)
    expect(fee).toBeGreaterThan(0n)

    account.dispose()
    prior.dispose()
  })
})
