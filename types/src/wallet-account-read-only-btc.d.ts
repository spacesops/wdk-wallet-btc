export const DUST_LIMIT: 546;
export default class WalletAccountReadOnlyBtc extends WalletAccountReadOnly {
    /**
     * Creates a new bitcoin read-only wallet account.
     *
     * @param {string} address - The account's address.
     * @param {BtcWalletConfig} [config] - The configuration object.
     */
    constructor(address: string, config?: BtcWalletConfig);
    /**
     * The wallet account configuration.
     *
     * @protected
     * @type {BtcWalletConfig}
     */
    protected _config: BtcWalletConfig;
    /**
     * Electrum client to interact with a bitcoin node.
     *
     * @protected
     * @type {ElectrumClient}
     */
    protected _electrumClient: ElectrumClient;
    /**
     * The bitcoin network (bitcoinjs-lib).
     * @protected
     * @type {import('bitcoinjs-lib').Network}
     */
    protected _network: import("bitcoinjs-lib").Network;
    /**
     * Returns a transaction's receipt.
     *
     * @param {string} hash - The transaction's hash.
     * @returns {Promise<BtcTransactionReceipt | null>} – The receipt, or null if the transaction has not been included in a block yet.
     */
    getTransactionReceipt(hash: string): Promise<BtcTransactionReceipt | null>;
    /**
     * Quotes the costs of a transfer operation.
     *
     * @param {TransferOptions} options - The transfer's options.
     * @returns {Promise<Omit<TransferResult, 'hash'>>} The transfer's quotes.
     */
    quoteTransfer(options: TransferOptions): Promise<Omit<TransferResult, "hash">>;
    /**
     * Returns the bitcoin transfers history of the account.
     *
     * @param {Object} [options] - The options.
     * @param {"incoming" | "outgoing" | "all"} [options.direction] - If set, only returns transfers with the given direction (default: "all").
     * @param {number} [options.limit] - The number of transfers to return (default: 10).
     * @param {number} [options.skip] - The number of transfers to skip (default: 0).
     * @returns {Promise<BtcTransfer[]>} The bitcoin transfers.
     */
    getTransfers(options?: {
        direction?: "incoming" | "outgoing" | "all";
        limit?: number;
        skip?: number;
    }): Promise<BtcTransfer[]>;
    /**
     * Build a fee-aware funding plan.
     *
     * Uses `descriptors` + `coinselect` to choose inputs, at a given feeRate (sats/vB). Returns the selected UTXOs (in the shape expected by the PSBT builder), the computed fee, and the resulting change value.
     *
     * @protected
     * @param {Object} params
     * @param {string} params.fromAddress - The sender's address.
     * @param {string} params.toAddress - The recipient's address.
     * @param {number} params.amount - Amount to send in sats.
     * @param {number} params.feeRate - Fee rate in sats/vB.
     * @returns {Promise<{ utxos: Array<any>, fee: number, changeValue: number }>}
     * utxos: [{ tx_hash, tx_pos, value, vout: { value, scriptPubKey: { hex } } }, ...]
     * fee: total fee in sats chosen by coinselect
     * changeValue: total inputs - amount - fee (sats)
     */
    protected _planSpend({ fromAddress, toAddress, amount, feeRate }: {
        fromAddress: string;
        toAddress: string;
        amount: number;
        feeRate: number;
    }): Promise<{
        utxos: Array<any>;
        fee: number;
        changeValue: number;
    }>;
    /**
     * Computes the SHA-256 hash of the output script for this wallet's address,
     * reverses the byte order, and returns it as a hex string.
     *
     * @private
     * @returns {Promise<string>} The reversed SHA-256 script hash as a hex-encoded string.
     */
    private _getScriptHash;
}
export type TransactionResult = import("@wdk/wallet").TransactionResult;
export type TransferOptions = import("@wdk/wallet").TransferOptions;
export type BtcTransactionReceipt = import("bitcoinjs-lib").Transaction;
export type BtcTransaction = {
    /**
     * - The transaction's recipient.
     */
    to: string;
    /**
     * - The amount of bitcoins to send to the recipient (in satoshis).
     */
    value: number;
};
export type BtcWalletConfig = {
    /**
     * - The electrum server's hostname (default: "electrum.blockstream.info").
     */
    host?: string;
    /**
     * - The electrum server's port (default: 50001).
     */
    port?: number;
    /**
     * - The BIP address type. Available values: 44 or 84 (default: 44).
     */
    bip?: 44 | 84;
    /**
     * The name of the network to use (default: "bitcoin").
     */
    network?: "bitcoin" | "regtest" | "testnet";
    /**
     * - The connection protocol to use (default: "tcp").
     */
    protocol?: "tcp" | "tls" | "ssl";
};
export type BtcTransfer = {
    /**
     * - The transaction's id.
     */
    txid: string;
    /**
     * - The user's own address.
     */
    address: string;
    /**
     * - The index of the output in the transaction.
     */
    vout: number;
    /**
     * - The block height (if unconfirmed, 0).
     */
    height: number;
    /**
     * - The value of the transfer (in satoshis).
     */
    value: number;
    /**
     * - The direction of the transfer.
     */
    direction: "incoming" | "outgoing";
    /**
     * - The fee paid for the full transaction (in satoshis).
     */
    fee?: number;
    /**
     * - The receiving address for outgoing transfers.
     */
    recipient?: string;
};
import { WalletAccountReadOnly } from '@wdk/wallet';
import ElectrumClient from './electrum-client.js';
