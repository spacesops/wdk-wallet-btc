# Vendored `@mempool/electrum-client` 1.1.9

Upstream: https://github.com/mempool/electrum-client (MIT) — see `LICENSE.MIT`.

## Why this is vendored

`@mempool/electrum-client`'s `TlsSocketWrapper` assumes Node's `tls.TLSSocket`
(extends `net.Socket`) and always forwards `setTimeout` / `setKeepAlive` /
`setNoDelay` / `setEncoding` to the object returned by `tls.connect()`.

On Bare, `bare-tls`'s `TLSNetSocket` does **not** implement those methods; they
live on the underlying TCP socket (`socket.socket`). Calling them on the TLS
socket throws (`setTimeout is not a function`) and breaks Electrum over TLS.

`lib/TlsSocketWrapper.cjs` applies each option to the TLS socket when present,
otherwise to the TCP underlay — matching Node behaviour without runtime
monkey-patches of `node_modules`.

Other files are unmodified copies of 1.1.9 (renamed to `.cjs` because this
package is `"type": "module"`).
