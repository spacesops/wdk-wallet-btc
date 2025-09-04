/**
 * @typedef {Object} ElectrumIdentity
 * @property {string} [client='wdk-wallet'] - Client name reported to the server.
 * @property {string} [version='1.4'] - Electrum protocol version.
 */
/**
 * @typedef {Object} ElectrumPersistence
 * @property {number} [retryPeriod=1000] - ms between reconnect attempts.
 * @property {number} [maxRetry=2] - max reconnect attempts before failing.
 * @property {number} [pingPeriod=120000] - ms between keepalive pings.
 * @property {(err: Error | null) => void | null} [callback=null] - optional status callback.
 */
/**
 * @typedef {Object} ElectrumCtorExtras
 * @property {ElectrumIdentity} [identity] - (unused; provided via top-level args)
 * @property {ElectrumPersistence} [persistence] - Persistence policy.
 * @property {any} [options] - Socket options consumed by base client.
 * @property {any} [callbacks] - Event callbacks consumed by base client.
 */
/**
 * A thin wrapper around {@link @mempool/electrum-client} that lazily initializes the underlying Electrum connection on first RPC call.
 *
 * The instance returned from the constructor is a Proxy that intercepts all method calls
 * (except `close`, `initElectrum`, and `reconnect`) to ensure the client is initialized
 * by awaiting {@link ElectrumClient#_ensure}.
 *
 * @example
 * const ec = new ElectrumClient(50001, 'electrum.blockstream.info', 'tcp')
 * const feeRate = await ec.blockchainEstimatefee(1) // initialization is performed automatically
 *
 * @extends BaseElectrumClient
 */
export default class ElectrumClient {
    /**
     * Create a new Electrum client wrapper.
     *
     * @param {number} port - Electrum server port (e.g. `50001`, `50002`).
     * @param {string} host - Electrum server hostname.
     * @param {'tcp' | 'tls' | 'ssl'} protocol - Transport protocol.
     * @param {Object} [opts={}] - Optional configuration.
     * @param {string} [opts.client='wdk-wallet'] - Client name reported to the server.
     * @param {string} [opts.version='1.4'] - Electrum protocol version.
     * @param {ElectrumPersistence} [opts.persistence] - Reconnect & keepalive behavior.
     * @param {any} [opts.options] - Low-level socket options for base client.
     * @param {any} [opts.callbacks] - Low-level callbacks for base client.
     *
     * @returns {ElectrumClient} A proxied instance that auto-initializes on first RPC.
     */
    constructor(port: number, host: string, protocol: "tcp" | "tls" | "ssl", { client, version, persistence, options, callbacks }?: {
        client?: string;
        version?: string;
        persistence?: ElectrumPersistence;
        options?: any;
        callbacks?: any;
    });
    /** @private @type {ElectrumIdentity} */
    private _clientInfo;
    /** @private @type {ElectrumPersistence} */
    private _persistence;
    /**
     * Promise representing an in-flight or completed initialization.
     * Reset to `null` on failure/close, re-created on next demand.
     * @private
     * @type {Promise<void> | null}
     */
    private _ready;
    /**
     * Ensure the Electrum connection is initialized. If a previous attempt failed or the
     * client was closed, a new initialization is attempted.
    *
     * @private
     * @param {number} [timeoutMs=15000] - In ms.
     * @returns {Promise<void>} Resolves when ready for RPC calls.
     * @throws {Error} If hits a timeout or the init fails.
     */
    private _ensure;
    /**
     * Recreate the underlying socket and reinitialize the session.
     *
     * @returns {Promise<void>} Resolves when reconnected and ready.
     */
    reconnect(): Promise<void>;
    /**
     * Close the connection and clear readiness state.
     *
     * @returns {void}
     */
    close(): void;
}
export type ElectrumIdentity = {
    /**
     * - Client name reported to the server.
     */
    client?: string;
    /**
     * - Electrum protocol version.
     */
    version?: string;
};
export type ElectrumPersistence = {
    /**
     * - ms between reconnect attempts.
     */
    retryPeriod?: number;
    /**
     * - max reconnect attempts before failing.
     */
    maxRetry?: number;
    /**
     * - ms between keepalive pings.
     */
    pingPeriod?: number;
    /**
     * - optional status callback.
     */
    callback?: (err: Error | null) => void | null;
};
export type ElectrumCtorExtras = {
    /**
     * - (unused; provided via top-level args)
     */
    identity?: ElectrumIdentity;
    /**
     * - Persistence policy.
     */
    persistence?: ElectrumPersistence;
    /**
     * - Socket options consumed by base client.
     */
    options?: any;
    /**
     * - Event callbacks consumed by base client.
     */
    callbacks?: any;
};
