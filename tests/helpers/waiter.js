import net from 'net'

import zmq from 'zeromq'

const DEFAULT_INTERVAL = 50

const DEFAULT_TIMEOUT = 3_000

export default class Waiter {
  constructor(bitcoin, config) {
    this._btc = bitcoin

    const { host, electrumPort, zmqPort, interval, timeout } = config

    this._host = host
    this._port = electrumPort
    this._sub = new zmq.Subscriber()
    this._sub.connect(`tcp://${host}:${zmqPort}`)

    this._interval = interval ?? DEFAULT_INTERVAL
    this._timeout = timeout ?? DEFAULT_TIMEOUT

    this._topics = new Set()
  }

  async waitUntilRpcReady() {
    return this._waitUntilCondition(() => {
      try {
        this._btc.getBlockchainInfo()
        return true
      } catch {
        return false
      }
    })
  }

  async waitUntilRpcStopped() {
    return this._waitUntilCondition(() => {
      try {
        this._btc.getBlockchainInfo()
        return false
      } catch {
        return true
      }
    })
  }

  async waitUntilPortOpen(host, port) {
    return this._waitUntilCondition(() =>
      new Promise(res => {
        const s = net.createConnection({ host, port }, () => {
          s.end()
          res(true)
        })
        s.on('error', () => {
          s.destroy()
          res(false)
        })
      })
    )
  }

  async waitUntilPortClosed(host, port) {
    return this._waitUntilCondition(() =>
      new Promise(res => {
        const s = net.createConnection({ host, port }, () => {
          s.end()
          res(false)
        })
        s.on('error', () => {
          s.destroy()
          res(true)
        })
      })
    )
  }

  async waitForBlocks(blocks) {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout waiting for blocks.')), this._timeout)
    )
    const task = (async () => {
      await this._waitForCoreBlocks(blocks)
      await this._waitForElectrumSync()
    })()
    await Promise.race([timeout, task])
  }

  _ensureTopic(topic) {
    if (!this._topics.has(topic)) {
      this._sub.subscribe(topic)
      this._topics.add(topic)
    }
  }

  _getElectrumHeight() {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket()
      socket.setEncoding('utf8')
      socket.connect(this._port, this._host, () => {
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'blockchain.headers.subscribe',
            params: []
          }) + '\n'
        )
      })
      socket.on('data', chunk => {
        try {
          const res = JSON.parse(chunk)
          socket.destroy()
          resolve(res.result.height)
        } catch {

        }
      })
      socket.on('error', err => {
        socket.destroy()
        reject(err)
      })
    })
  }

  async _waitForCoreBlocks(expected) {
    this._ensureTopic('hashblock')

    let count = 0

    for await (const [topic] of this._sub) {
      if (topic.toString() === 'hashblock' && ++count >= expected) {
        return
      }
    }
  }

  async _waitForElectrumSync() {
    const target = this._btc.getBlockCount()
    await this._waitUntilCondition(async () => {
      const height = await this._getElectrumHeight()
      return height === target
    })
  }

  async _waitUntilCondition(fn) {
    const start = Date.now()
    while (true) {
      if (await fn()) return
      if (Date.now() - start > this._timeout) {
        throw new Error('Timeout waiting for condition.')
      }
      await new Promise(r => setTimeout(r, this._interval))
    }
  }
}
