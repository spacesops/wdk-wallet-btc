/** @implements {IWalletAccount} */
export default class WalletAccountBtc extends WalletAccountReadOnlyBtc implements IWalletAccount {
    /**
     * Creates a new bitcoin wallet account.
     *
     * @param {string | Uint8Array} seed - The wallet's [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) seed phrase.
     * @param {string} path - The BIP-84 derivation path (e.g. "0'/0/0").
     * @param {BtcWalletConfig} [config] - The configuration object.
     */
    constructor(seed: string | Uint8Array, path: string, config?: BtcWalletConfig);
    /**
     * The derivation path of this account.
     *
     * @protected
     * @type {string}
     */
    protected _path: string;
    /**
     * The BIP32 master node.
     *
     * @protected
     * @type {import('bip32').BIP32Interface}
     */
    protected _masterNode: import("bip32").BIP32Interface;
    /**
     * The derived BIP32 account.
     *
     * @protected
     * @type {import('bip32').BIP32Interface}
     */
    protected _account: import("bip32").BIP32Interface;
    /** @type {number} */
    get index(): number;
    /**
     * The derivation path of this account (see [BIP-84](https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki)).
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
     * Signs a message.
     *
     * @param {string} message - The message to sign.
     * @returns {Promise<string>} The message's signature.
     */
    sign(message: string): Promise<string>;
    /**
     * Verifies a message's signature.
     *
     * @param {string} message - The original message.
     * @param {string} signature - The signature to verify.
     * @returns {Promise<boolean>} True if the signature is valid.
     */
    verify(message: string, signature: string): Promise<boolean>;
    /**
     * Sends a transaction.
     *
     * @param {BtcTransaction} tx - The transaction.
     * @returns {Promise<TransactionResult>} The transaction's result.
     */
    sendTransaction({ to, value }: BtcTransaction): Promise<TransactionResult>;
    /**
     * Transfers a token to another address.
     *
     * @param {TransferOptions} options - The transfer's options.
     * @returns {Promise<TransferResult>} The transfer's result.
     */
    transfer(options: TransferOptions): Promise<TransferResult>;
    /**
     * Returns a read-only copy of the account.
     * @returns {Promise<WalletAccountReadOnlyBtc>} The read-only account.
     */
    toReadOnlyAccount(): Promise<WalletAccountReadOnlyBtc>;
    /**
     * Disposes the wallet account, erasing the private key from the memory and closing the connection with the electrum server.
     */
    dispose(): void;
    /**
     * Build and fee-estimate a transaction for this account.
     *
     * @protected
     * @param {{ recipient: string, amount: number }} params
     * @returns {Promise<{ txid: string, hex: string, fee: BigNumber }>}
     */
    protected _getTransaction({ recipient, amount }: {
        recipient: string;
        amount: number;
    }): Promise<{
        txid: string;
        hex: string;
        fee: BigNumber;
    }>;
    /**
     * Creates and signs the PSBT using the precomputed (coinselect) fee.
     *
     * @protected
     * @param {Array<any>} utxoSet
     * @param {number} amount
     * @param {string} recipient
     * @param {number} selectorFee - total fee in sats (from coinselect)
     * @returns {Promise<{ txid: string, hex: string, fee: BigNumber }>}
     */
    protected _getRawTransaction(utxoSet: Array<any>, amount: number, recipient: string, selectorFee: number): Promise<{
        txid: string;
        hex: string;
        fee: BigNumber;
    }>;
}
export type IWalletAccount = import("@wdk/wallet").IWalletAccount;
export type KeyPair = import("@wdk/wallet").KeyPair;
export type TransactionResult = import("@wdk/wallet").TransactionResult;
export type TransferOptions = import("@wdk/wallet").TransferOptions;
export type TransferResult = import("@wdk/wallet").TransferResult;
export type BtcTransaction = import("./wallet-account-read-only-btc.js").BtcTransaction;
export type BtcWalletConfig = import("./wallet-account-read-only-btc.js").BtcWalletConfig;
import WalletAccountReadOnlyBtc from './wallet-account-read-only-btc.js';
import BigNumber from 'bignumber.js';
