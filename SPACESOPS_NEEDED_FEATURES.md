# Spacesops fork features — re-implementation guide

This document lists **technical work** needed after resetting this repository to the latest **upstream** [`tetherto/wdk-wallet-btc`](https://github.com/tetherto/wdk-wallet-btc) release. Use it as a checklist: implement **one item at a time**, run `npm run lint` and `npm run build:types`, and run tests where applicable.

## Baseline after reset (upstream)

Expect the upstream layout to include at least:

- `src/transports/` — `IBtcClient` (`btc-client.js`), `MempoolElectrumClient`, `BlockbookClient`, Electrum transports (`tcp`, `tls`, `ssl`, `ws`), barrel `index.js`.
- `WalletManagerBtc` owns `_client` / `_clientList` and passes `client` into accounts; **no** per-account `host`/`port` construction like the old fork.
- Accounts use **`this._client`** with abstract methods: `connect()`, `getBalance(address)`, `listUnspent(address)`, `getHistory(address)`, `getTransaction(txHash)`, `broadcast(rawTx)`, `estimateFee(blocks)` — **not** raw `blockchainScripthash_*` Electrum calls.
- `toScriptHash()` lives in `btc-client.js`; fork-specific `_getScriptHash()` helpers should be **replaced** by address-based `_client` calls unless you add a shared utility.
- `npm run test` may split into **unit** vs **integration** scripts; align new tests with whatever `package.json` defines after reset.

All fork features below must be **ported onto this model** (translate every former `this._electrumClient.*` usage to `this._client.*` with the correct arguments).

---

## Recommended order (merge strategy, condensed)

1. **Confirm upstream builds** — `npm install`, `npm run lint`, `npm run build:types`, run unit tests if present.
2. **Do not** merge the old `src/electrum-client.js` debug wrapper unless you explicitly need RPC logging; upstream’s `MempoolElectrumClient` is the supported path.
3. **Taproot / BIP-86 first** (or immediately after any shared helpers), because memo and update-tx flows assume P2TR addressing and signing.
4. **Memo APIs** (`_planSpendWithMemo`, OP_RETURN building, Taproot recipient checks).
5. **Update transaction with hex** (`_buildMultiAccountTransaction`, `createOpReturnScriptFromHex`).
6. **Polish** — `verify` on full account if desired, dust/prefix tables, README/types, remove any temporary `console.log` / worklet logging bridges copied from the fork.
7. **Behavior choices** — document whether `getBalance()` should match upstream (confirmed + unconfirmed) or stay confirmed-only for Spacesops consumers.

---

## 1. Taproot (BIP-86) / `script_type: 'P2TR'`

### What the fork had (reference)

- **`WalletAccountBtc` constructor** (`src/wallet-account-btc.js`): `bip` 44 | 84 | 86 with validation; correlation `bip === 86` ⇔ `script_type === 'P2TR'`; derivation path `m/${bip}'/${coinType}'/${path}`; address via `payments.p2tr({ internalPubkey: account.publicKey.slice(1), network })` for P2TR.
- **Private state**: `_scriptType`, `_internalPubkey` (32-byte x-only internal key from BIP32 pubkey), `_bip`, `_masterNode`, `_account`.
- **`get scriptType`**: public getter.
- **`sign()`**: `bitcoinjs-message` with `segwitType: 'p2wpkh'` only for BIP-84; Taproot uses default path in fork (verify against bitcoinjs-message + address type).
- **`_getRawTransaction` / `_buildMultiAccountTransaction`**: branch on `this._scriptType === 'P2TR'` — PSBT inputs with `witnessUtxo`, `tapInternalKey`, manual `tapBip32Derivation` workaround for bitcoinjs-lib v6.1.7, Schnorr signing via `ecc.signSchnorr` and tweaked key logic (`tapTweakHash`, `tweakKey` from `bitcoinjs-lib/src/payments/bip341.js`), parity negation for internal/tweaked keys.
- **Legacy path**: BIP-44 uses `nonWitnessUtxo`; BIP-84 uses `witnessUtxo` + `signInputHD`.

### What to implement on upstream

1. Extend **`BtcWalletConfig` JSDoc** in `wallet-account-read-only-btc.js`: `bip: 44 | 84 | 86`, `script_type: 'P2WPKH' | 'P2TR' | 'P2PKH'` (as needed), consistent with upstream’s style.
2. **`WalletAccountBtc` constructor**: replicate derivation + address generation; keep upstream’s `@noble/hashes` + `derivePath` pattern if that is what upstream uses post-reset.
3. **`_getRawTransaction`** (or equivalent PSBT builder): add P2TR branches mirroring the fork’s `buildAndSign` inner function — **test on regtest** with integration tests.
4. **`BIP_BY_ADDRESS_PREFIX` / `DUST_LIMIT`** in read-only account: add `bc1p`, `tb1p`, `bcrt1p` → BIP 86 and dust `330n` (fork values); ensure `getMaxSpendable` uses correct input vbytes for P2TR (~58) vs P2WPKH (~68) if that logic exists upstream.

### Dependencies

- `bitcoinjs-lib` (already present), `@bitcoinerlab/secp256k1` for `signSchnorr` / `privateAdd`.
- Internal imports from `bitcoinjs-lib/src/payments/bip341.js` — **fragile** across minor versions; prefer stable public APIs if upstream upgrades bitcoinjs-lib.

### Tests

- Integration: fund Taproot address, `sendTransaction`, optional `sign`/`verify` roundtrip.
- Add or extend tests under upstream’s `tests/` layout after reset.

---

## 2. Memo (OP_RETURN) APIs

### Public API (fork)

| Method | Class | Notes |
|--------|--------|--------|
| `quoteSendTransactionWithMemo({ to, value, memo, feeRate?, confirmationTarget? })` | Read-only + full | Fee quote only |
| `sendTransactionWithMemo(...)` | Full only | Broadcast |
| `quoteSendTransactionWithMemoTX(...)` | Full only | Signed hex, no broadcast |

### Rules (fork)

- Recipient **`to`** must be Taproot (`bc1p` / `tb1p` / `bcrt1p`); throw otherwise.
- Memo UTF-8 length ≤ **75 bytes**.
- OP_RETURN script in fork: `OP_RETURN` + push length + data (`createOpReturnScript` in full account — note fork used a slightly different layout than `createOpReturnScriptFromHex` which added an extra `OP_PUSHNUM_1` byte; **keep one consistent spec** and document it).

### Implementation steps

1. **`_planSpendWithMemo`** in `wallet-account-read-only-btc.js` (or superclass where upstream places `_planSpend`): clone `_planSpend` but add extra vbytes/fee for one OP_RETURN output; use `this._client.listUnspent(fromAddress)` instead of `blockchainScripthash_listunspent`.
2. **Full account**: `sendTransactionWithMemo` / `quoteSendTransactionWithMemoTX` call `_planSpendWithMemo`, build tx via `_getRawTransaction` with `additionalOutputs: [{ script, value: 0 }]`, then `this._client.broadcast(hex)` when sending.
3. **Fee estimation**: `this._client.estimateFee(confirmationTarget)` then convert BTC/kB → sat/vB as upstream already does (`* 100_000` pattern).

### Documentation

- Align `WITH_MEMO_USAGE.md` with final script format and Taproot-only rule.

---

## 3. Update transaction with hex (`priorTx` + `priorAcct`)

### Public API (fork)

- `quoteUpdateTransactionWithHexTX({ to, hex, priorTx, priorAcct, value?, feeRate?, confirmationTarget? })` → `Promise<string>` (hex)
- `updateTransactionWithHex({ ... })` → `Promise<{ hash, fee }>` (broadcast)

### Behavior (fork)

1. Load prior tx via `getTransaction(priorTx)`.
2. Find first output with value **1007** sats; fail if none.
3. Require **`priorAcct`** (`WalletAccountBtc`); same network; prior output script must match `priorAcct` address script.
4. Build **2-input, 3-output** tx: (1) payment `value` (default 1007) to `to`, (2) OP_RETURN from **`createOpReturnScriptFromHex(hex)`** (fork used `0x6a` + `0x51` + push + data, max **75** bytes decoded), (3) change to current account.
5. **`_buildMultiAccountTransaction`**: input 0 signed by `priorAcct`, input 1 by `this`; supports P2TR and P2WPKH/P2PKH branches per account.

### Porting checklist

- Replace all `this._electrumClient.blockchainTransaction_get` / `listunspent` / `broadcast` with `_client.getTransaction`, `_client.listUnspent`, `_client.broadcast`.
- **Prior tx output selection**: if multiple 1007-sat outputs exist, fork picked first match — document or make deterministic (e.g. lowest `vout`).
- **Multi-account signing**: port `buildAndSign` loop from fork `_buildMultiAccountTransaction` (~400 lines) carefully; merge with upstream’s simpler `_getRawTransaction` if upstream refactors structure.

### Documentation

- `UPDATE_TX_HEX.md` describes the API; update it for `IBtcClient` and any semantic changes.

---

## 4. `verify()` on `WalletAccountBtc` (optional)

Upstream may only expose **`verify()`** on the read-only class. The fork duplicated **`verify()`** on the full account for convenience.

- **To re-add**: delegate to same `bitcoinjs-message` + `getAddress()` logic as read-only, or call `super`-style implementation without duplicating crypto.

---

## 5. `quoteSendTransactionTX` and related “quote TX hex” helpers

The fork implemented **`quoteSendTransactionTX`** with verbose logging. Upstream may already expose some quote-hex methods — **diff after reset**.

- If missing: implement as `_getRawTransaction` + return `hex` without `broadcast`, using `_client` only.
- Remove debug `console.log` from the fork version.

---

## 6. `toReadOnlyAccount()` behavior

- **Fork**: `new WalletAccountReadOnlyBtc(this._address, this._config)` — shared Electrum client lived per account (old model).
- **Upstream**: typically passes **`client: this._client`** in config so the read-only view uses the same connection.

After reset, **match upstream’s pattern** and inject `client` when creating the read-only clone.

---

## 7. Electrum debug client (`src/electrum-client.js`) — optional

The fork’s `ElectrumClient` subclass added:

- Lazy `Proxy` wrapping RPC calls
- `buildElectrumWirePayload` / shell one-liners for reproducing RPC on the wire

**Recommendation:** treat as **development-only** tooling. Do not ship in library `src/` unless product requires it. If needed, move to `scripts/` or a separate optional package.

---

## 8. Upstream behaviors to consciously adopt or override

| Topic | Upstream (typical) | Fork | Decision |
|--------|-------------------|------|----------|
| **Post-broadcast polling** | `sendTransaction` may poll until spent UTXOs drop from `listUnspent` | Fork returned immediately after broadcast | Prefer upstream behavior for double-spend safety unless product forbids delay |
| **`getBalance()`** | Often confirmed + unconfirmed | Fork returned confirmed only | Document breaking change if you keep confirmed-only |
| **`dispose()`** | Manager closes internal clients; external clients untouched | Fork closed `_electrumClient` in account `dispose` | Follow upstream’s ownership rules |
| **`@tetherto/wdk-wallet` version** | Pinned newer beta | Fork used wider range | Align with upstream pin after reset |

---

## 9. `index.js` and public exports

After reset, upstream **`index.js`** may export transport types:

```text
IBtcClient, BlockbookClient, MempoolElectrumClient, ElectrumTcp, ElectrumSsl, ElectrumTls, ElectrumWs
```

Spacesops-only: add JSDoc `@typedef` re-exports for any **new** public types (memo options, update-tx options). Run **`npm run build:types`**; do not hand-edit `types/` except via regeneration.

---

## 10. Files to use as reference when porting (pre-reset fork)

Keep a **backup branch or patch** of the old fork before reset. Primary reference locations:

| Concern | File (fork) | Symbols |
|---------|-------------|---------|
| Taproot constructor + signing | `src/wallet-account-btc.js` | constructor, `_getRawTransaction`, `_buildMultiAccountTransaction`, `sign`, `scriptType` getter |
| Memo planning | `src/wallet-account-read-only-btc.js` | `_planSpendWithMemo`, `quoteSendTransactionWithMemo` |
| Memo send / quote hex | `src/wallet-account-btc.js` | `sendTransactionWithMemo`, `quoteSendTransactionWithMemoTX`, `createOpReturnScript` |
| Update tx + hex OP_RETURN | `src/wallet-account-btc.js` | `quoteUpdateTransactionWithHexTX`, `updateTransactionWithHex`, `createOpReturnScriptFromHex`, `_buildMultiAccountTransaction` |
| Dust / prefix | `src/wallet-account-read-only-btc.js` | `BIP_BY_ADDRESS_PREFIX`, `DUST_LIMIT` |
| Debug Electrum | `src/electrum-client.js` | entire file (optional) |

---

## 11. Lint, types, and CI

- **Standard** applies to `src/**/*.js` (not tests if ignored in `package.json`).
- Every new public method needs **JSDoc** compatible with `tsc --emitDeclarationOnly`.
- No **`console.log`** in production library paths (fork violated this intentionally for debugging).

---

## Summary checklist (copy for issues/PRs)

- [ ] BIP-86 / P2TR derivation, addresses, `_getRawTransaction` signing
- [ ] Dust + address-prefix tables for Taproot
- [ ] `quoteSendTransactionWithMemo` / `sendTransactionWithMemo` / `quoteSendTransactionWithMemoTX`
- [ ] `_planSpendWithMemo` on `_client` API
- [ ] `quoteUpdateTransactionWithHexTX` / `updateTransactionWithHex` / `createOpReturnScriptFromHex` / `_buildMultiAccountTransaction`
- [ ] `quoteSendTransactionTX` if not in upstream
- [ ] `verify` on full account (optional)
- [ ] `toReadOnlyAccount` passes `client` per upstream
- [ ] README / `WITH_MEMO_USAGE.md` / `UPDATE_TX_HEX.md` / `AGENTS.md` updated
- [ ] `npm run lint` + `npm run build:types` + tests
