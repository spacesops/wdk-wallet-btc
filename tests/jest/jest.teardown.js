import { execSync } from 'child_process'

import { HOST, PORT, ELECTRUM_PORT, ZMQ_PORT, DATA_DIR } from '../config.js'

import BitcoinCli from '../helpers/bitcoin-cli.js'

const btc = new BitcoinCli({
  host: HOST,
  port: PORT,
  electrumPort: ELECTRUM_PORT,
  zmqPort: ZMQ_PORT,
  dataDir: DATA_DIR
})

export default async () => {
  console.log('\n🧹 [Test Teardown] Tearing down test environment...')

  try {
    console.log('⛔ Stopping bitcoind...')
    btc.stop()
    await btc.waiter.waitUntilRpcStopped()
    console.log('✅ bitcoind stopped.')
  } catch {
    console.log('⚠️ bitcoind was not running or already stopped.')
  }

  console.log('🔌 Waiting for Electrum server to fail...')
  try {
    await btc.waiter.waitUntilPortClosed(HOST, ELECTRUM_PORT)
    console.log('✅ Electrum server stopped.')
  } catch {
    console.log('⚠️ Electrum server did not exit in time.')
  }

  try {
    console.log('🗑️ Removing regtest chain data...')
    execSync(`rm -rf ${DATA_DIR}`)
    console.log('✅ Chain data removed.')
  } catch {
    console.log('⚠️ Failed to remove chain data.')
  }

  console.log('🏁 Teardown complete.\n')
}
