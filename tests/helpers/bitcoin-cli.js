import { execSync } from 'child_process'

import Waiter from './waiter.js'

export default class BitcoinCli {
  constructor (config) {
    this._config = config

    this._wallet = config.wallet

    const { host, port, dataDir } = config

    this._app = `bitcoin-cli -regtest -rpcconnect=${host} -rpcport=${port} -datadir=${dataDir}`
 
    this._waiter = new Waiter(this, config)
  }

  get waiter () {
    return this._waiter
  }

  setWallet (wallet) {
    this._wallet = wallet
  }

  start () {
    const { host, port, dataDir, zmqPort } = this._config

    execSync('bitcoind -regtest -daemon ' +
      '-server=1 ' +
      '-txindex=1 ' +
      '-fallbackfee=0.0001 ' +
      '-paytxfee=0.0001 ' +
      '-minrelaytxfee=0.000001 ' +
      `-rpcbind=${host} ` +
      `-rpcport=${port} ` +
      `-datadir=${dataDir} ` +
      `-zmqpubhashblock=tcp://${host}:${zmqPort}`)
  }

  stop () {
    execSync(`${this._app} stop`)
  }

  call (cmd, { rawResult = false } = { }) {
    const walletFlag = this._wallet ? `-rpcwallet=${this._wallet}` : ''
    const fullCmd = `${this._app} ${walletFlag} ${cmd}`
    const result = execSync(fullCmd).toString().trim()

    return rawResult ? result : JSON.parse(result)
  }

  createWallet (wallet) {
    return this.call(`createwallet ${wallet}`, { rawResult: true })
  }

  getNewAddress () {
    return this.call('getnewaddress', { rawResult: true })
  }

  sendToAddress (address, amount) {
    return this.call(`sendtoaddress ${address} ${amount}`, { rawResult: true })
  }

  generateToAddress (blocks, address) {
    return this.call(`generatetoaddress ${blocks} ${address}`)
  }

  getMempoolEntry (txid) {
    return this.call(`getmempoolentry ${txid}`)
  }

  getTransaction (txid) {
    return this.call(`gettransaction ${txid}`)
  }

  getBlockCount () {
    return this.call('getblockcount')
  }

  getBlockchainInfo () {
    return this.call('getblockchaininfo')
  }

  async mine (blocks = 1) {
    const miner = this.getNewAddress()
    const promise = this.waiter.waitForBlocks(blocks)
    this.generateToAddress(blocks, miner)

    await promise
  }
}
