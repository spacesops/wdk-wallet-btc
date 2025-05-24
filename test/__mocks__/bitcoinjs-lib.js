const mockedAddress = 'mocked-btc-address'

const bitcoinLibMock = {
  networks: {
    bitcoin: {},
    regtest: {}
  },
  payments: {
    p2wpkh: () => ({ address: mockedAddress })
  },
  address: {
    toOutputScript: () => Buffer.from('0014abcdef', 'hex')
  },
  crypto: {
    sha256: () => Buffer.from('00'.repeat(32), 'hex')
  },
  Psbt: class {
    addInput() {}
    addOutput() {}
    signInputHD() {}
    finalizeAllInputs() {}
    extractTransaction() {
      return {
        getId: () => 'mocked-txid',
        toHex: () => 'deadbeef',
        virtualSize: () => 10
      }
    }
  }
}

export default bitcoinLibMock
