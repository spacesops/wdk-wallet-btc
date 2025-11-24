/** @internal */
export default class ElectrumClient {
    constructor(config?: {});
    _network: any;
    _host: any;
    _port: any;
    _protocol: any;
    _socket: import("net").Socket | import("tls").TLSSocket;
    _connected: boolean;
    _pendingRequests: Map<any, any>;
    get network(): any;
    connect(): Promise<any>;
    _setupSocket(): void;
    _handleResponse(response: any): void;
    disconnect(): Promise<any>;
    _request(method: any, params?: any[], retries?: number): any;
    getHistory(address: any): Promise<any>;
    getUnspent(address: any): Promise<any>;
    getTransaction(txid: any): Promise<Transaction>;
    broadcastTransaction(txHex: any): Promise<any>;
    getFeeEstimateInSatsPerVb(blocks?: number): Promise<any>;
    getScriptHash(address: any): string;
    getBalance(address: any): Promise<any>;
    isConnected(): boolean;
}
import { Transaction } from 'bitcoinjs-lib';
