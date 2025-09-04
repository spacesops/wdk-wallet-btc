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

import BaseElectrumClient from '@mempool/electrum-client'

/**
 * @typedef {Object} ElectrumIdentity
 * @property {string} [client='wdk-wallet'] - Client name reported to the server.
 * @property {string} [version='1.4'] - Electrum protocol version.
 */

/**
 * @typedef {Object} ElectrumPersistence
 * @property {number} [retryPeriod=1000] - ms between reconnect attempts.
 * @property {number} [maxRetry=2] - max reconnect attempts before failing.
 * @property {number} [pingPeriod=120000] - ms between keepalive pings.
 * @property {(err: Error | null) => void | null} [callback=null] - optional status callback.
 */

/**
 * @typedef {Object} ElectrumCtorExtras
 * @property {ElectrumIdentity} [identity] - (unused; provided via top-level args)
 * @property {ElectrumPersistence} [persistence] - Persistence policy.
 * @property {any} [options] - Socket options consumed by base client.
 * @property {any} [callbacks] - Event callbacks consumed by base client.
 */

/**
 * A thin wrapper around {@link @mempool/electrum-client} that lazily initializes the underlying Electrum connection on first RPC call.
 *
 * The instance returned from the constructor is a Proxy that intercepts all method calls
 * (except `close`, `initElectrum`, and `reconnect`) to ensure the client is initialized.
 *
 * @example
 * const ec = new ElectrumClient(50001, 'electrum.blockstream.info', 'tcp')
 * const feeRate = await ec.blockchainEstimatefee(1) // initialization is performed automatically
 *
 * @extends BaseElectrumClient
 */
export default class ElectrumClient extends BaseElectrumClient {
  /**
   * Create a new Electrum client wrapper.
   *
   * @param {number} port - Electrum server port (e.g. `50001`, `50002`).
   * @param {string} host - Electrum server hostname.
   * @param {'tcp' | 'tls' | 'ssl'} protocol - Transport protocol.
   * @param {Object} [opts={}] - Optional configuration.
   * @param {string} [opts.client='wdk-wallet'] - Client name reported to the server.
   * @param {string} [opts.version='1.4'] - Electrum protocol version.
   * @param {ElectrumPersistence} [opts.persistence] - Reconnect & keepalive behavior.
   * @param {any} [opts.options] - Low-level socket options for base client.
   * @param {any} [opts.callbacks] - Low-level callbacks for base client.
   *
   * @returns {ElectrumClient} A proxied instance that auto-initializes on first RPC.
   */
  constructor (
    port,
    host,
    protocol,
    {
      client = 'wdk-wallet',
      version = '1.4',
      persistence = { retryPeriod: 1000, maxRetry: 2, pingPeriod: 120000, callback: null },
      options,
      callbacks
    } = {}
  ) {
    super(port, host, protocol, options, callbacks)

    /** @private @type {ElectrumIdentity} */
    this._clientInfo = { client, version }

    /** @private @type {ElectrumPersistence} */
    this._persistence = persistence

    /**
     * Promise representing an in-flight or completed initialization.
     * Reset to `null` on failure/close, re-created on next demand.
     * @private
     * @type {Promise<void> | null}
     */
    this._ready = null

    const target = this
    return new Proxy(this, {
      get (obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)
        if (typeof value !== 'function') return value

        if (prop === 'close' || prop === 'initElectrum' || prop === 'reconnect') {
          return value.bind(obj)
        }

        return async function (...args) {
          await target._ensure()
          return value.apply(obj, args)
        }
      }
    })
  }

  /**
   * Ensure the Electrum connection is initialized. If a previous attempt failed or the
   * client was closed, a new initialization is attempted.
  *
   * @private
   * @param {number} [timeout=15000] - In ms.
   * @returns {Promise<void>} Resolves when ready for RPC calls.
   * @throws {Error} If hits a timeout or the init fails.
   */
  _ensure (timeout = 15000) {
    if (this._ready) return this._ready

    const initPromise = super.initElectrum(this._clientInfo, this._persistence)
    const timeoutPromise = new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Electrum init timeout')), timeout)
      if (typeof t.unref === 'function') t.unref()
    })

    this._ready = Promise.race([initPromise, timeoutPromise]).catch(err => {
      this._ready = null
      throw err
    })

    return this._ready
  }

  /**
   * Recreate the underlying socket and reinitialize the session.
   *
   * @returns {Promise<void>} Resolves when reconnected and ready.
   */
  reconnect () {
    this.initSocket()
    const p = super.initElectrum(this._clientInfo, this._persistence)
    this._ready = p.catch(err => { this._ready = null; throw err })
    return this._ready
  }

  /**
   * Close the connection and clear readiness state.
   *
   * @returns {void}
   */
  close () {
    super.close()
    this._ready = null
    this.reconnect = ElectrumClient.prototype.reconnect.bind(this)
  }
}
