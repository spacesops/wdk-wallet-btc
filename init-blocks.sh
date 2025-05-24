#!/bin/bash

ADDRESS=$(bitcoin-cli -regtest -rpcuser=user -rpcpassword=pass getnewaddress)
bitcoin-cli -regtest -rpcuser=user -rpcpassword=pass generatetoaddress 101 "$ADDRESS"
