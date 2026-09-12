'use strict'

/**
 * TLS socket adapter for Electrum (derived from @mempool/electrum-client 1.1.9).
 *
 * Node's tls.TLSSocket extends net.Socket, so setTimeout / setKeepAlive /
 * setNoDelay / setEncoding live on the TLS socket itself.
 *
 * Bare's bare-tls TLSNetSocket is a Duplex wrapped around a TCP socket. Those
 * net.Socket methods exist on the underlying transport (socket.socket), not on
 * the TLS surface. Apply options to the TLS socket when present, otherwise to
 * the TCP underlay — same behaviour Node callers expect.
 */

/**
 * @param {object | false} socket
 * @param {string} method
 * @param {unknown[]} args
 */
function applySocketOption (socket, method, args) {
  if (!socket) return

  if (typeof socket[method] === 'function') {
    socket[method](...args)
    return
  }

  const transport = socket.socket
  if (transport && typeof transport[method] === 'function') {
    transport[method](...args)
  }
}

class TlsSocketWrapper {
  /**
   * @param {typeof import('tls')} tls
   */
  constructor (tls) {
    this._tls = tls
    this._socket = false
    this._timeout = 5000
    this._encoding = 'utf8'
    this._keepAliveEneblad = true
    this._keepAliveinitialDelay = 0
    this._noDelay = true
    this._listeners = {}
  }

  setTimeout (timeout) {
    this._timeout = timeout
    applySocketOption(this._socket, 'setTimeout', [timeout])
  }

  setEncoding (encoding) {
    this._encoding = encoding
    applySocketOption(this._socket, 'setEncoding', [encoding])
  }

  setKeepAlive (enabled, initialDelay) {
    this._keepAliveEneblad = enabled
    this._keepAliveinitialDelay = initialDelay
    applySocketOption(this._socket, 'setKeepAlive', [enabled, initialDelay])
  }

  setNoDelay (noDelay) {
    this._noDelay = noDelay
    applySocketOption(this._socket, 'setNoDelay', [noDelay])
  }

  on (event, listener) {
    this._listeners[event] = this._listeners[event] || []
    this._listeners[event].push(listener)
  }

  removeListener (event, listener) {
    this._listeners[event] = this._listeners[event] || []
    const newListeners = []
    let found = false
    for (const savedListener of this._listeners[event]) {
      if (savedListener === listener) {
        found = true
      } else {
        newListeners.push(savedListener)
      }
    }
    this._listeners[event] = found ? newListeners : []
  }

  connect (port, host, callback) {
    // SNI (servername) is required for many TLS terminators (e.g. StartOS Frigate).
    // bare-tls and Node tls both honour servername; host alone is not enough.
    this._socket = this._tls.connect(
      { port, host, servername: host, rejectUnauthorized: false },
      () => callback()
    )

    applySocketOption(this._socket, 'setTimeout', [this._timeout])
    applySocketOption(this._socket, 'setEncoding', [this._encoding])
    applySocketOption(this._socket, 'setKeepAlive', [
      this._keepAliveEneblad,
      this._keepAliveinitialDelay
    ])
    applySocketOption(this._socket, 'setNoDelay', [this._noDelay])

    this._socket.on('data', (data) => this._passOnEvent('data', data))
    this._socket.on('error', (data) => this._passOnEvent('error', data))
    this._socket.on('close', (data) => this._passOnEvent('close', data))
    this._socket.on('connect', (data) => this._passOnEvent('connect', data))
    this._socket.on('connection', (data) => this._passOnEvent('connection', data))
  }

  _passOnEvent (event, data) {
    this._listeners[event] = this._listeners[event] || []
    for (const savedListener of this._listeners[event]) {
      savedListener(data)
    }
  }

  emit (event, data) {
    this._socket.emit(event, data)
  }

  end () {
    this._socket.end()
  }

  destroy () {
    this._socket.destroy()
  }

  write (data) {
    this._socket.write(data)
  }
}

module.exports = TlsSocketWrapper
module.exports.applySocketOption = applySocketOption
