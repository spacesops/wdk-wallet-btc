#!/bin/bash

# Define version
BITCOIN_VERSION="26.0"

# Download Bitcoin Core
wget https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz

# Extract
tar -xzf bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz

# Move to /usr/local for global access (you can change this)
sudo mv bitcoin-${BITCOIN_VERSION}/bin/* /usr/local/bin/

# Verify installation
bitcoind --version
