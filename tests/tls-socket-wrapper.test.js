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
'use strict'

import { createRequire } from 'module'
import { EventEmitter } from 'events'
import { jest } from '@jest/globals'

const require = createRequire(import.meta.url)
const TlsSocketWrapper = require('../src/vendor/electrum-client/lib/TlsSocketWrapper.cjs')
const { applySocketOption } = TlsSocketWrapper

describe('TlsSocketWrapper (Bare / Node TLS surface)', () => {
  test('applySocketOption uses the TLS socket when the method exists', () => {
    const tlsSocket = {
      setTimeout: jest.fn()
    }

    applySocketOption(tlsSocket, 'setTimeout', [60_000])

    expect(tlsSocket.setTimeout).toHaveBeenCalledWith(60_000)
  })

  test('applySocketOption falls back to the TCP underlay (bare-tls shape)', () => {
    const underlay = {
      setTimeout: jest.fn(),
      setKeepAlive: jest.fn(),
      setNoDelay: jest.fn()
    }
    const tlsSocket = { socket: underlay }

    applySocketOption(tlsSocket, 'setTimeout', [60_000])
    applySocketOption(tlsSocket, 'setKeepAlive', [true, 0])
    applySocketOption(tlsSocket, 'setNoDelay', [true])

    expect(underlay.setTimeout).toHaveBeenCalledWith(60_000)
    expect(underlay.setKeepAlive).toHaveBeenCalledWith(true, 0)
    expect(underlay.setNoDelay).toHaveBeenCalledWith(true)
  })

  test('connect applies buffered options to a Bare-like TLS socket without throwing', () => {
    const underlay = {
      setTimeout: jest.fn(),
      setKeepAlive: jest.fn(),
      setNoDelay: jest.fn(),
      setEncoding: jest.fn()
    }

    const fakeTlsSocket = new EventEmitter()
    fakeTlsSocket.socket = underlay

    const tls = {
      connect: jest.fn((_opts, onconnect) => {
        queueMicrotask(() => onconnect())
        return fakeTlsSocket
      })
    }

    const wrapper = new TlsSocketWrapper(tls)
    wrapper.setTimeout(60_000)
    wrapper.setKeepAlive(true, 0)
    wrapper.setNoDelay(true)
    wrapper.setEncoding('utf8')

    return new Promise((resolve, reject) => {
      wrapper.connect(50002, 'example.com', () => {
        try {
          expect(tls.connect).toHaveBeenCalledWith(
            { port: 50002, host: 'example.com', rejectUnauthorized: false },
            expect.any(Function)
          )
          expect(underlay.setTimeout).toHaveBeenCalledWith(60_000)
          expect(underlay.setKeepAlive).toHaveBeenCalledWith(true, 0)
          expect(underlay.setNoDelay).toHaveBeenCalledWith(true)
          expect(underlay.setEncoding).toHaveBeenCalledWith('utf8')

          // Post-connect idle clear (electrum client does this on 'connect')
          wrapper.setTimeout(0)
          expect(underlay.setTimeout).toHaveBeenCalledWith(0)
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    })
  })
})
