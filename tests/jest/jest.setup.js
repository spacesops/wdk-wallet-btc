import { spawn, execSync } from 'child_process'

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
  console.log('\n🧪 [Test Setup] Initializing Bitcoin regtest environment...')

  try {
    console.log('⛔ Stopping any previously running bitcoind instance...')
    btc.stop()
  } catch {
    console.log('⚠️ No previous bitcoind instance was running.')
  }

  console.log('🧹 Removing old regtest data...')
  execSync(`rm -rf ${DATA_DIR}/regtest`, { stdio: 'ignore' })

  console.log(`📁 Ensuring data directory exists at ${DATA_DIR}...`)
  execSync(`mkdir -p ${DATA_DIR}`, { stdio: 'ignore' })

  try {
    console.log(`🔍 Checking for processes using port ${PORT}...`)
    execSync(`lsof -i :${PORT} | grep LISTEN | awk '{print $2}' | xargs kill -9`, { stdio: 'ignore' })
    console.log(`✅ Killed process on port ${PORT}.`)
  } catch {
    console.log(`⚠️ No process was using port ${PORT}.`)
  }

  console.log('🚀 Starting bitcoind in regtest mode...')
  btc.start()
  await btc.waiter.waitUntilRpcReady()
  console.log('✅ bitcoind started.')

  console.log('🔌 Starting Electrum server...')
  spawn('electrs', [
    '--network', 'regtest',
    '--daemon-dir', DATA_DIR,
    '--electrum-rpc-addr', `${HOST}:${ELECTRUM_PORT}`
  ])

  await btc.waiter.waitUntilPortOpen(HOST, ELECTRUM_PORT)
  console.log('✅ Electrum server is running.')

  console.log('💼 Creating new wallet `testwallet`...')
  btc.createWallet('testwallet')
  btc.setWallet('testwallet')

  console.log('⛏️ Mining 101 blocks for initial funds...')
  await btc.mine(101)
  console.log('✅ Initial funds added.')

  console.log('🎯 Test environment ready.\n')
}
