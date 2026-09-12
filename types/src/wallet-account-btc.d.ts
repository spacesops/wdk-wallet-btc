/** @implements {IWalletAccount<string>} */
export default class WalletAccountBtc extends WalletAccountReadOnlyBtc implements IWalletAccount<string> {
    /**
     * @private
     * @param {WalletAccountBtc} account
     * @returns {{ tweakedOutputPubkey: Uint8Array, tweakedPrivKey: Uint8Array }}
     */
    private static _deriveTweakedTaprootKeysForAccount;
    /**
     * @private
     * @param {WalletAccountBtc} account
     * @param {import('bitcoinjs-lib').Psbt} psbt
     * @param {Object} utxo
     */
    private static _addAccountInput;
    /**
     * @private
     * @param {WalletAccountBtc} account
     * @param {import('bitcoinjs-lib').Psbt} psbt
     * @param {number} index
     */
    private static _signAccountInput;
    /**
     * Creates a new bitcoin wallet account.
     * Supports P2PKH (BIP-44), P2WPKH (BIP-84), and P2TR Taproot (BIP-86).
     *
     * @param {string | Uint8Array} seed - The wallet's BIP-39 seed phrase.
     * @param {string} path - The derivation path suffix (e.g. "0'/0/0").
     * @param {BtcWalletConfig} [config] - The configuration object.
     */
    constructor(seed: string | Uint8Array, path: string, config?: BtcWalletConfig);
    /** @private */
    private _path;
    /** @private */
    private _bip;
    /** @private */
    private _scriptType;
    /** @private */
    private _masterNode;
    /** @private */
    private _account;
    /** @private */
    private _internalPubkey;
    /**
     * The derivation path's index of this account.
     *
     * @type {number}
     */
    get index(): number;
    /**
     * The derivation path of this account.
     *
     * @type {string}
     */
    get path(): string;
    /**
     * The account's key pair.
     *
     * @type {KeyPair}
     */
    get keyPair(): KeyPair;
    /**
     * The script type of this account (`P2TR`, `P2WPKH`, or `P2PKH`).
     *
     * @type {string}
     */
    get scriptType(): string;
    /**
     * Exports Taproot key material as hex.
     * Returns private key material — treat as sensitive. Intended for Koine/Satochip-adjacent tooling.
     *
     * @returns {TaprootKeyMaterialHex | null} Key material, or null when this account is not P2TR.
     */
    getTaprootKeyMaterialHex(): TaprootKeyMaterialHex | null;
    /**
     * Signs a message.
     * For P2WPKH (BIP-84) and P2TR (BIP-86), uses SegWit message signing format.
     *
     * @param {string} message - The message to sign.
     * @returns {Promise<string>} The message's signature.
     */
    sign(message: string): Promise<string>;
    /**
     * Signs a transaction.
     *
     * @param {BtcTransaction} tx - The transaction to sign.
     * @returns {Promise<string>} The signed raw transaction as a hex string.
     * @throws {Error} If the transaction's cost exceeds the maximum transaction fee option.
     */
    signTransaction({ to, value, feeRate, confirmationTarget }: BtcTransaction): Promise<string>;
    /**
     * Quotes the costs of a send transaction operation.
     * When given a signed hex string, fee-quotes that transaction without rebuilding it.
     * Distinct from {@link WalletAccountBtc#quoteSendTransactionTX}, which builds a signed hex from `{to,value}`.
     *
     * @param {BtcTransaction | string} tx - The transaction, or a signed raw transaction as a hex string.
     * @returns {Promise<Omit<TransactionResult, 'hash'>>} The transaction's quotes.
     */
    quoteSendTransaction(tx: BtcTransaction | string): Promise<Omit<TransactionResult, "hash">>;
    /**
     * Sends a transaction.
     *
     * @param {BtcTransaction | string} tx - The transaction, or a signed raw transaction as a hex string.
     * @param {number} [timeoutMs] - Maximum milliseconds to poll for spent inputs to disappear from unspent outputs after broadcast.
     * @returns {Promise<TransactionResult>} The transaction's result.
     * @throws {Error} If the transaction's cost exceeds the maximum transaction fee option.
     */
    sendTransaction(tx: BtcTransaction | string, timeoutMs?: number): Promise<TransactionResult>;
    /**
     * Sends a transaction with a memo (OP_RETURN output).
     * Requires the recipient address to be a Taproot (P2TR) address.
     *
     * @param {Object} options - Transaction options.
     * @param {string} options.to - The recipient's Taproot Bitcoin address.
     * @param {number | bigint} options.value - The amount to send (in satoshis).
     * @param {string} options.memo - The memo string to embed in OP_RETURN (max 75 bytes UTF-8).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<TransactionResult>} The transaction result.
     */
    sendTransactionWithMemo({ to, value, memo, feeRate, confirmationTarget }: {
        to: string;
        value: number | bigint;
        memo: string;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<TransactionResult>;
    /**
     * Builds and signs a transaction from `{to,value}` and returns the raw hex without broadcasting.
     * Distinct from {@link WalletAccountBtc#quoteSendTransaction} when given a hex string (fee-only quote).
     *
     * @param {BtcTransaction} tx - The transaction options.
     * @returns {Promise<string>} The signed raw transaction hex.
     */
    quoteSendTransactionTX({ to, value, feeRate, confirmationTarget }: BtcTransaction): Promise<string>;
    /**
     * Builds and signs a memo transaction and returns the raw hex without broadcasting.
     * Requires a Taproot recipient.
     *
     * @param {Object} options - Transaction options.
     * @param {string} options.to - The recipient's Taproot Bitcoin address.
     * @param {number | bigint} options.value - The amount to send (in satoshis).
     * @param {string} options.memo - The memo string (max 75 bytes UTF-8).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<string>} The signed raw transaction hex.
     */
    quoteSendTransactionWithMemoTX({ to, value, memo, feeRate, confirmationTarget }: {
        to: string;
        value: number | bigint;
        memo: string;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<string>;
    /**
     * Sends a transaction with multiple payment outputs.
     *
     * @param {Object} options - Transaction options.
     * @param {Array<{ address: string, value: number | bigint }>} options.outputs - Payment outputs in satoshis.
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<TransactionResult>} The transaction result.
     */
    sendTransactionWithOutputs({ outputs, feeRate, confirmationTarget }: {
        outputs: Array<{
            address: string;
            value: number | bigint;
        }>;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<TransactionResult>;
    /**
     * Builds and signs a multi-output transaction and returns the raw hex without broadcasting.
     *
     * @param {Object} options - Transaction options.
     * @param {Array<{ address: string, value: number | bigint }>} options.outputs - Payment outputs in satoshis.
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<string>} The signed raw transaction hex.
     */
    quoteSendTransactionWithOutputsTX({ outputs, feeRate, confirmationTarget }: {
        outputs: Array<{
            address: string;
            value: number | bigint;
        }>;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<string>;
    /**
     * Sends a transaction with multiple Taproot payment outputs and an OP_RETURN memo.
     *
     * @param {Object} options - Transaction options.
     * @param {Array<{ address: string, value: number | bigint }>} options.outputs - Payment outputs in satoshis.
     * @param {string} options.memo - The memo string to embed in OP_RETURN (max 75 bytes UTF-8).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<TransactionResult>} The transaction result.
     */
    sendTransactionWithMemoAndOutputs({ outputs, memo, feeRate, confirmationTarget }: {
        outputs: Array<{
            address: string;
            value: number | bigint;
        }>;
        memo: string;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<TransactionResult>;
    /**
     * Builds and signs a multi-output memo transaction and returns the raw hex without broadcasting.
     *
     * @param {Object} options - Transaction options.
     * @param {Array<{ address: string, value: number | bigint }>} options.outputs - Payment outputs in satoshis.
     * @param {string} options.memo - The memo string (max 75 bytes UTF-8).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target in blocks (default: 1).
     * @returns {Promise<string>} The signed raw transaction hex.
     */
    quoteSendTransactionWithMemoAndOutputsTX({ outputs, memo, feeRate, confirmationTarget }: {
        outputs: Array<{
            address: string;
            value: number | bigint;
        }>;
        memo: string;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<string>;
    /**
     * Creates an OP_RETURN script from a UTF-8 string.
     *
     * @param {string} data - The UTF-8 data to embed.
     * @returns {Uint8Array} The OP_RETURN script.
     */
    createOpReturnScript(data: string): Uint8Array;
    /**
     * Creates an OP_RETURN script from hex-encoded data.
     * Script: OP_RETURN (0x6a) + OP_1 (0x51) + push opcode + data.
     * OP_1 is a script opcode (Spaces numbered-output prefix), not part of the payload.
     *
     * @param {string} hexData - The hex-encoded data to embed (wire payload, without OP_1).
     * @returns {Uint8Array} The OP_RETURN script.
     */
    createOpReturnScriptFromHex(hexData: string): Uint8Array;
    /**
     * Builds (without broadcasting) a two-input update transaction that spends a 1077-sat
     * output from `priorTx` (signed by `priorAcct`) plus a funding UTXO from this account,
     * embeds `hex` in OP_RETURN, and pays `value` (default 1077) to `to`.
     *
     * @param {Object} options - Transaction options.
     * @param {string} options.to - The recipient's Bitcoin address.
     * @param {string} options.hex - Hex-encoded OP_RETURN payload.
     * @param {string} options.priorTx - Prior transaction id containing a 1077-sat output.
     * @param {WalletAccountBtc} options.priorAcct - Account that owns the prior UTXO.
     * @param {number | bigint} [options.value] - Amount to send (default: 1077).
     * @param {number | bigint} [options.feeRate] - Optional fee rate (in sats/vB).
     * @param {number} [options.confirmationTarget] - Optional confirmation target (default: 1).
     * @returns {Promise<{hex: string, fee: bigint}>} The signed hex and fee.
     */
    quoteUpdateTransactionWithHexTX(options: {
        to: string;
        hex: string;
        priorTx: string;
        priorAcct: WalletAccountBtc;
        value?: number | bigint;
        feeRate?: number | bigint;
        confirmationTarget?: number;
    }): Promise<{
        hex: string;
        fee: bigint;
    }>;
    /**
     * Same as {@link WalletAccountBtc#quoteUpdateTransactionWithHexTX}, but broadcasts the result.
     *
     * @param {Object} options - See quoteUpdateTransactionWithHexTX.
     * @returns {Promise<TransactionResult>} The transaction result.
     */
    updateTransactionWithHex(options: any): Promise<TransactionResult>;
    /**
     * Transfers a token to another address.
     *
     * @param {TransferOptions} options - The transfer's options.
     * @returns {Promise<TransferResult>} The transfer's result.
     */
    transfer(options: TransferOptions): Promise<TransferResult>;
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
     * Returns a read-only copy of the account.
     *
     * @returns {Promise<WalletAccountReadOnlyBtc>} The read-only account.
     */
    toReadOnlyAccount(): Promise<WalletAccountReadOnlyBtc>;
    _btcReadOnlyAccount: WalletAccountReadOnlyBtc;
    /**
     * @private
     * @param {Transaction} transaction
     * @returns {Promise<bigint>}
     */
    private _getSignedTransactionFee;
    /**
     * @private
     * @returns {{ tweakedOutputPubkey: Uint8Array, tweakedPrivKey: Uint8Array }}
     */
    private _deriveTweakedTaprootKeys;
    /**
     * @private
     */
    private _composeUpdateTransactionWithHex;
    /**
     * @private
     */
    private _buildMultiAccountTransaction;
    /** @private */
    private _getRawTransaction;
    /**
     * Builds and signs a transaction with fixed payment outputs.
     * Fee shortfall is covered from change only; payment output amounts are never reduced.
     *
     * @private
     */
    private _getRawTransactionWithOutputs;
    /** @private */
    private _buildSignedTransaction;
}
export type IWalletAccount = import("@tetherto/wdk-wallet").IWalletAccount;
export type KeyPair = import("@tetherto/wdk-wallet").KeyPair;
export type TransactionResult = import("@tetherto/wdk-wallet").TransactionResult;
export type TransferOptions = import("@tetherto/wdk-wallet").TransferOptions;
export type TransferResult = import("@tetherto/wdk-wallet").TransferResult;
export type BtcTransaction = import("./wallet-account-read-only-btc.js").BtcTransaction;
export type BtcWalletConfig = import("./wallet-account-read-only-btc.js").BtcWalletConfig;
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
    value: bigint;
    /**
     * - The direction of the transfer.
     */
    direction: "incoming" | "outgoing";
    /**
     * - The fee paid for the full transaction (in satoshis).
     */
    fee?: bigint;
    /**
     * - The receiving address for outgoing transfers.
     */
    recipient?: string;
};
export type TaprootKeyMaterialHex = {
    /**
     * - The 32-byte Taproot internal public key (hex).
     */
    internalPubKeyHex: string;
    /**
     * - The BIP-32 account private key (hex). Sensitive.
     */
    privateKeyHex: string;
    /**
     * - The tweaked Taproot private key used for Schnorr signing (hex). Sensitive.
     */
    tweakedPrivateKeyHex: string;
};
import WalletAccountReadOnlyBtc from './wallet-account-read-only-btc.js';
