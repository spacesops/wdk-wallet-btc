import { jest } from '@jest/globals'
import netMock, { sockets as netSockets, createSocket as createNetSocket } from './__mocks__/net.js'
import tlsMock, { sockets as tlsSockets, createSocket as createTlsSocket } from './__mocks__/tls.js'
import bitcoinjsLibMock from './__mocks__/bitcoinjs-lib.js'

jest.unstable_mockModule('net', async () => ({ connect: netMock.connect }))
jest.unstable_mockModule('tls', async () => ({ connect: tlsMock.connect }))
jest.unstable_mockModule('bitcoinjs-lib', async () => bitcoinjsLibMock)

let ElectrumClient

beforeAll(async () => {
  ElectrumClient = (await import('../src/electrum-client.js')).default
})

beforeEach(() => {
  jest.clearAllMocks()
  netSockets.length = 0
  tlsSockets.length = 0
  netMock.connect.mockReset()
  tlsMock.connect.mockReset()
  netMock.connect.mockImplementation(() => {
    const socket = createNetSocket()
    netSockets.push(socket)
    return socket
  })
  tlsMock.connect.mockImplementation(() => {
    const socket = createTlsSocket()
    tlsSockets.push(socket)
    return socket
  })
})

describe('ElectrumClient', () => {
  test('constructor throws on invalid network', () => {
    expect(() => new ElectrumClient({ network: 'invalid' })).toThrow('Invalid network: invalid.')
  })

  test('getScriptHash produces reversed sha256 hash', () => {
    const client = new ElectrumClient({ network: 'bitcoin' })
    expect(client.network).toEqual(bitcoinjsLibMock.networks.bitcoin)
    const hash = client.getScriptHash('mocked')
    expect(hash).toBe('0'.repeat(64))
  })

  test('connect establishes tcp connection', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const promise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await expect(promise).resolves.toBeUndefined()
    expect(client.isConnected()).toBe(true)
    expect(netMock.connect).toHaveBeenCalled()
  })

  test('uses tls connection when protocol tls', async () => {
    const client = new ElectrumClient({ protocol: 'tls' })
    const promise = client.connect()
    const socket = tlsSockets[tlsSockets.length - 1]
    socket.emit('connect')
    await promise
    expect(tlsMock.connect).toHaveBeenCalled()
    expect(netMock.connect).not.toHaveBeenCalled()
  })

  test('connect rejects on socket error', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const promise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    const err = new Error('boom')
    socket.emit('error', err)
    await expect(promise).rejects.toThrow('boom')
    expect(client.isConnected()).toBe(false)
  })

  test('connect rejects if connect throws', async () => {
    netMock.connect.mockImplementationOnce(() => { throw new Error('sync fail') })
    const client = new ElectrumClient({ protocol: 'tcp' })
    await expect(client.connect()).rejects.toThrow('sync fail')
    expect(client.isConnected()).toBe(false)
  })

  test('existing socket destroyed on subsequent connect failure', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const first = client.connect()
    const s1 = netSockets[netSockets.length - 1]
    s1.emit('connect')
    await first

    netMock.connect.mockImplementationOnce(() => { throw new Error('oops') })
    await expect(client.connect()).rejects.toThrow('oops')
    expect(s1.destroy).toHaveBeenCalled()
  })

  test('connect rejects on timeout', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const p = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('timeout')
    await expect(p).rejects.toThrow('Electrum client connection time-out.')
    expect(socket.destroy).toHaveBeenCalled()
  })

  test('error after connect resets state', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const p = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await p
    socket.emit('error', new Error('late'))
    expect(socket.destroy).toHaveBeenCalled()
    expect(client.isConnected()).toBe(false)
  })

  test('request writes json and resolves with response', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const connectPromise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await connectPromise

    const reqPromise = client.getFeeEstimate(1)
    const written = socket.write.mock.calls[0][0]
    const parsed = JSON.parse(written)
    socket.emit('data', Buffer.from(JSON.stringify({ id: parsed.id, result: 0.5 }) + '\n'))

    const result = await reqPromise
    expect(result).toBe(0.5)
  })

  test('request rejects after timeout', async () => {
    jest.useFakeTimers()
    const client = new ElectrumClient({ protocol: 'tcp' })
    const connectPromise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await connectPromise

    const reqPromise = client.getFeeEstimate(1)
    await Promise.resolve()
    jest.advanceTimersByTime(30000)
    await expect(reqPromise).rejects.toThrow('Electrum client request time-out.')
    jest.useRealTimers()
  })

  test('response with error rejects request', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const connectPromise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await connectPromise

    const reqPromise = client.getFeeEstimate(1)
    const req = JSON.parse(socket.write.mock.calls[0][0])
    socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, error: { message: 'oops' } }) + '\n'))
    await expect(reqPromise).rejects.toThrow('oops')
  })



  test('disconnect handles end error', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c

    socket.end.mockImplementation(() => { throw new Error('boom') })
    const p = client.disconnect()
    await expect(p).resolves.toBeUndefined()
    expect(socket.destroy).toHaveBeenCalled()
  })

  test('disconnect resolves when not connected', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    await expect(client.disconnect()).resolves.toBeUndefined()
  })

  test('close and end events reset connection', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    socket.emit('close')
    expect(client.isConnected()).toBe(false)
    socket.emit('end')
    expect(client.isConnected()).toBe(false)
  })

  test('invalid json is ignored', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    socket.emit('data', Buffer.from('not json\n'))
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  test('wrapper methods send correct RPC commands', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    const history = client.getHistory('addr')
    const unspent = client.getUnspent('addr')
    const tx = client.getTransaction('id')
    const broadcast = client.broadcastTransaction('hex')
    const fee = client.getFeeEstimate(2)
    const balance = client.getBalance('addr')
    const requests = socket.write.mock.calls.map(c => JSON.parse(c[0]))
    const methods = requests.map(r => r.method)
    expect(methods).toEqual([
      'blockchain.scripthash.get_history',
      'blockchain.scripthash.listunspent',
      'blockchain.transaction.get',
      'blockchain.transaction.broadcast',
      'blockchain.estimatefee',
      'blockchain.scripthash.get_balance'
    ])
    const idMap = Object.fromEntries(requests.map(r => [r.method, r.id]))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.scripthash.get_history'], result: [] }) + '\n'))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.scripthash.listunspent'], result: [] }) + '\n'))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.transaction.get'], result: {} }) + '\n'))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.transaction.broadcast'], result: 'b' }) + '\n'))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.estimatefee'], result: 3 }) + '\n'))
    socket.emit('data', Buffer.from(JSON.stringify({ id: idMap['blockchain.scripthash.get_balance'], result: 5 }) + '\n'))
    await expect(history).resolves.toEqual([])
    await expect(unspent).resolves.toEqual([])
    await expect(tx).resolves.toEqual({})
    await expect(broadcast).resolves.toBe('b')
    await expect(fee).resolves.toBe(3)
    await expect(balance).resolves.toBe(5)
  })


  test('disconnect ends socket and clears state', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const connectPromise = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await connectPromise

    const discPromise = client.disconnect()
    socket.emit('close')
    await expect(discPromise).resolves.toBeUndefined()
    expect(client.isConnected()).toBe(false)
    expect(socket.end).toHaveBeenCalled()
  })
})

describe('ElectrumClient edge cases', () => {
  test('constructor uses defaults when no config provided', () => {
    const client = new ElectrumClient()
    expect(client.network).toEqual(bitcoinjsLibMock.networks.bitcoin)
  })

  test('request retries connection then fails', async () => {
    netMock.connect.mockImplementation(() => { throw new Error('fail') })
    const client = new ElectrumClient({ protocol: 'tcp' })
    const p = client.getFeeEstimate(1)
    await expect(p).rejects.toThrow('Failed to connect after retries: fail.')
    expect(netMock.connect).toHaveBeenCalledTimes(3)
  })

  test('request errors when socket not connected', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    const disc = client.disconnect()
    socket.emit('close')
    await disc
    jest.spyOn(client, 'isConnected').mockReturnValue(true)
    await expect(client.getFeeEstimate(1)).rejects.toThrow('Electrum client websocket client not connected.')
  })

  test('request rejects when write fails', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    socket.write.mockImplementation(() => { throw new Error('write fail') })
    await expect(client.getFeeEstimate(1)).rejects.toThrow('write fail')
  })

  test('unmatched response ids are ignored', async () => {
    const client = new ElectrumClient({ protocol: 'tcp' })
    const c = client.connect()
    const socket = netSockets[netSockets.length - 1]
    socket.emit('connect')
    await c
    const p = client.getFeeEstimate(1)
    const req = JSON.parse(socket.write.mock.calls[0][0])
    let settled = false
    p.then(() => { settled = true })
    socket.emit('data', Buffer.from(JSON.stringify({ id: req.id + 1, result: 0 }) + '\n'))
    await Promise.resolve()
    expect(settled).toBe(false)
    socket.emit('data', Buffer.from(JSON.stringify({ id: req.id, result: 7 }) + '\n'))
    await expect(p).resolves.toBe(7)
  })
})
