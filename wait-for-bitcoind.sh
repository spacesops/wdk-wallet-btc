#!/bin/bash

until bitcoin-cli -regtest -rpcuser=user -rpcpassword=pass getblockchaininfo > /dev/null 2>&1; do
  echo "Waiting for bitcoind..."
  sleep 1
done

echo "bitcoind is ready."
