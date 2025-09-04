export const HOST = '127.0.0.1'
export const PORT = 18_443
export const ELECTRUM_PORT = 7_777
export const ZMQ_PORT = 29_000
export const DATA_DIR = './.bitcoin'

export const BITCOIN_CLI_PATH = 'bitcoin-cli'
export const BITCOIND_PATH = 'bitcoind'
export const ELECTRS_PATH = 'electrs'
export const BITCOIN_CORE_VERSION = 'v29.'
export const ELECTRS_VERSION = 'v0.10.10'

export const ACCOUNT_CONFIG = {
  host: HOST,
  port: ELECTRUM_PORT,
  network: 'regtest',
  bip: 44
}
