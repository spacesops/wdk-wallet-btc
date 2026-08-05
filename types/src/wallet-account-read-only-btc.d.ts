export default class WalletAccountReadOnlyBtc extends WalletAccountReadOnly {
    /**
     * Creates a bitcoin client from a descriptor, or returns the client as-is if already instantiated.
     *
     * @protected
     * @param {IBtcClient | BtcClientDescriptor} client - The bitcoin client or client descriptor.
     * @param {"bitcoin" | "regtest" | "testnet"} [network] - The network name.
     * @returns {IBtcClient} The bitcoin client.
     */
    protected static _createClient(client: IBtcClient | BtcClientDescriptor, network?: "bitcoin" | "regtest" | "testnet"): IBtcClient;
    /**
     * Creates a new bitcoin read-only wallet account.
     *
     * @param {string} address - The account's address.
     * @param {Omit<BtcWalletConfig, 'bip' | 'transactionMaxFee'>} [config] - The configuration object.
     */
    constructor(address: string, config?: Omit<BtcWalletConfig, "bip" | "transactionMaxFee">);
    /**
     * The read-only wallet account configuration.
     *
     * @protected
     * @type {Omit<BtcWalletConfig, 'bip' | 'transactionMaxFee'>}
     */
    protected _config: Omit<BtcWalletConfig, "bip" | "transactionMaxFee">;
    /**
     * The network.
     *
     * @protected
     * @type {Network}
     */
    protected _network: Network;
    /**
     * A list of all the bitcoin client options.
     *
     * @protected
     * @type {Array<IBtcClient>}
     */
    protected _clientList: Array<IBtcClient>;
    /**
     * A client to interact with the bitcoin network.
     *
     * @protected
     * @type {IBtcClient}
     */
    protected _client: IBtcClient;
    /**
     * The dust limit in satoshis based on the BIP type.
     *
     * @private
     * @type {bigint}
     */
    private _dustLimit;
    /**
     * Returns the scriptPubKey hex for an address on this account's network.
     *
     * @param {string} address - The Bitcoin address.
     * @returns {string} The scriptPubKey as a hex string.
     */
    getScriptPubKeyHex(address: string): string;
    /**
     * Quotes the costs of a send transaction operation.
     *
     * @param {BtcTransaction} tx - The transaction.
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
     */
    quoteSendTransaction({ to, value, feeRate, confirmationTarget }: BtcTransaction): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Quotes the costs of a send transaction that embeds a UTF-8 memo in an OP_RETURN output.
     * Requires the recipient address to be a Taproot (P2TR) address.
     *
     * @param {Object} options - Transaction options.
     * @param {string} options.to - The recipient's Taproot Bitcoin address (bc1p / tb1p / bcrt1p).
     * @param {number | bigint} options.value - The amount to send (in satoshis).
     * @param {string} options.memo - The memo string to embed (max 75 bytes UTF-8).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
     */
    quoteSendTransactionWithMemo({ to, value, memo, feeRate, confirmationTarget }: {
        to: string;
        value: number | bigint;
        memo: string;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Returns a transaction's receipt.
     *
     * @param {string} hash - The transaction's hash.
     * @returns {Promise<BtcTransactionReceipt | null>} – The receipt, or null if the transaction has not been included in a block yet.
     */
    getTransactionReceipt(hash: string): Promise<BtcTransactionReceipt | null>;
    /**
     * Returns an estimation of the maximum spendable amount (in satoshis) that can be sent in
     * a single transaction, after subtracting estimated transaction fees.
     *
     * The estimated maximum spendable amount can differ from the wallet's total balance.
     * A transaction can only include up to MAX_UTXO_INPUTS (default: 200) unspents.
     * Wallets holding more than this limit cannot spend their full balance in a
     * single transaction. There will likely be some satoshis left over as change.
     *
     * @param {Object} [opts] - Options.
     * @param {number | bigint} [opts.feeRate] - Fee rate in sat/vB. If omitted, estimated via the client.
     * @returns {Promise<BtcMaxSpendableResult>} The estimated maximum spendable result.
     */
    getMaxSpendable(opts?: {
        feeRate?: number | bigint;
    }): Promise<BtcMaxSpendableResult>;
    /**
     * A list that maps each client to a flag that is true only if the client was externally provided.
     *
     * @protected
     * @type {Array<boolean>}
     */
    protected get _isExternalClient(): Array<boolean>;
    /**
     * Closes any internal connection with the server.
     */
    dispose(): void;
    /**
     * Ensures the client is connected.
     *
     * @protected
     * @returns {Promise<void>}
     */
    protected _ensureConnected(): Promise<void>;
    /** @private */
    private _toBigInt;
    /**
     * Builds and returns a fee-aware funding plan for sending a transaction.
     *
     * Uses descriptors + coinselect to choose inputs, at a given feeRate (sats/vB). Returns the selected
     * UTXOs (in the shape expected by the PSBT builder), the computed fee, and the resulting change value.
     *
     * @protected
     * @param {Object} tx - The transaction.
     * @param {string} tx.fromAddress - The sender's address.
     * @param {string} tx.toAddress - The recipient's address.
     * @param {number | bigint} tx.amount - The amount to send (in satoshis).
     * @param {number | bigint} tx.feeRate - The fee rate (in sats/vB).
     * @returns {Promise<{ utxos: OutputWithValue[], fee: number, changeValue: number }>} - The funding plan.
     */
    protected _planSpend({ fromAddress, toAddress, amount, feeRate }: {
        fromAddress: string;
        toAddress: string;
        amount: number | bigint;
        feeRate: number | bigint;
    }): Promise<{
        utxos: OutputWithValue[];
        fee: number;
        changeValue: number;
    }>;
    /**
     * Builds a fee-aware funding plan for a send that includes an OP_RETURN memo output.
     * Uses addUntilReach so a single UTXO that covers payment+base fee but not OP_RETURN
     * fees can still be supplemented by additional inputs.
     *
     * @protected
     * @param {Object} tx - The transaction.
     * @param {string} tx.fromAddress - The sender's address.
     * @param {string} tx.toAddress - The recipient's address.
     * @param {number | bigint} tx.amount - The amount to send (in satoshis).
     * @param {string} tx.memo - The UTF-8 memo (max 75 bytes).
     * @param {number | bigint} tx.feeRate - The fee rate (in sats/vB).
     * @returns {Promise<{ utxos: OutputWithValue[], fee: bigint, changeValue: bigint }>} The funding plan.
     */
    protected _planSpendWithMemo({ fromAddress, toAddress, amount, memo, feeRate }: {
        fromAddress: string;
        toAddress: string;
        amount: number | bigint;
        memo: string;
        feeRate: number | bigint;
    }): Promise<{
        utxos: OutputWithValue[];
        fee: bigint;
        changeValue: bigint;
    }>;
}
export type MempoolElectrumConfig = import("./transports/index.js").MempoolElectrumConfig;
export type MempoolElectrumClient = import("./transports/index.js").MempoolElectrumClient;
export type IBtcClient = import("./transports/index.js").IBtcClient;
export type BlockbookClientConfig = import("./transports/blockbook-client.js").BlockbookClientConfig;
export type ElectrumWsConfig = import("./transports/ws.js").ElectrumWsConfig;
export type OutputWithValue = import("@bitcoinerlab/coinselect").OutputWithValue;
export type Network = import("bitcoinjs-lib").Network;
export type BtcTransactionReceipt = import("bitcoinjs-lib").Transaction;
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferOptions = import("@tetherto/wdk-wallet").TransferOptions;
export type TransferResult = import("@tetherto/wdk-wallet").TransferResult;
export type BtcTransaction = {
    /**
     * - The transaction's recipient.
     */
    to: string;
    /**
     * - The amount of bitcoins to send to the recipient (in satoshis).
     */
    value: number | bigint;
    /**
     * - Optional confirmation target in blocks (default: 1).
     */
    confirmationTarget?: number;
    /**
     * - Optional fee rate in satoshis per virtual byte. If provided, this value overrides the fee rate estimated from the blockchain (default: undefined).
     */
    feeRate?: number | bigint;
};
export type BtcClientDescriptor = BtcBlockbookHttpClientDescriptor | BtcElectrumClientDescriptor | BtcElectrumWsClientDescriptor;
export type BtcBlockbookHttpClientDescriptor = {
    /**
     * - The client's type.
     */
    type: "blockbook-http";
    /**
     * - The client's configuration.
     */
    clientConfig: BlockbookClientConfig;
};
export type BtcElectrumWsClientDescriptor = {
    /**
     * - Use a WebSocket Electrum client.
     */
    type: "electrum-ws";
    /**
     * - The WebSocket client configuration.
     */
    clientConfig: Omit<ElectrumWsConfig, "network">;
};
export type BtcElectrumClientDescriptor = {
    /**
     * - Use a TCP/TLS/SSL Electrum client.
     */
    type: "electrum";
    /**
     * - The Electrum client configuration.
     */
    clientConfig: Omit<MempoolElectrumConfig, "network">;
};
export type BtcWalletConfig = {
    /**
     * - The bitcoin client, or a list of bitcoin client options for connection fallback.
     */
    client?: IBtcClient | BtcClientDescriptor | Array<IBtcClient | BtcClientDescriptor>;
    /**
     * - The name of the network to use (default: "bitcoin").
     */
    network?: "bitcoin" | "regtest" | "testnet";
    /**
     * - The BIP address type used for key and address derivation.
     * - 44: [BIP-44 (P2PKH / legacy)](https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki)
     * - 84: [BIP-84 (P2WPKH / native SegWit)](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)
     * - 86: [BIP-86 (P2TR / Taproot)](https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki)
     * - Default: 84 (P2WPKH).
     */
    bip?: 44 | 84 | 86;
    /**
     * - Optional script type. Inferred from `bip` when omitted.
     * Must be `"P2TR"` when `bip` is 86, and must not be `"P2TR"` otherwise.
     */
    script_type?: "P2WPKH" | "P2TR";
    /**
     * - The number of retries in the failover mechanism.
     */
    retries?: number;
    /**
     * - The maximum fee amount for sendTransaction and signTransaction operations.
     */
    transactionMaxFee?: number | bigint;
};
export type BtcMaxSpendableResult = {
    /**
     * - The maximum spendable amount in satoshis.
     */
    amount: bigint;
    /**
     * - The estimated network fee in satoshis.
     */
    fee: bigint;
    /**
     * - The estimated change value in satoshis.
     */
    changeValue: bigint;
};
import { WalletAccountReadOnly } from '@tetherto/wdk-wallet';
