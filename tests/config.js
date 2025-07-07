import 'dotenv/config'

export const DATA_DIR = process.env.TEST_BITCOIN_CLI_DATA_DIR || './.bitcoin'
export const HOST = process.env.TEST_NODE_HOST || '127.0.0.1'
export const ELECTRUM_PORT = Number(process.env.TEST_ELECTRUM_SERVER_PORT || '7777')
export const ZMQ_PORT = process.env.TEST_BITCOIN_ZMQ_PORT || '29000'
export const RPC_PORT = Number(process.env.TEST_BITCOIN_CLI_RPC_PORT || '18443')
