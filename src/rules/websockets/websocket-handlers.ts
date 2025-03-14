import * as _ from 'lodash';
import net = require('net');
import * as url from 'url';
import * as tls from 'tls';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as WebSocket from 'ws';
import CacheableLookup from 'cacheable-lookup';

import {
    ClientServerChannel,
    deserializeProxyConfig
} from "../../serialization/serialization";

import { OngoingRequest, RawHeaders } from "../../types";

import {
    CloseConnectionHandler,
    ResetConnectionHandler,
    TimeoutHandler
} from '../requests/request-handlers';
import {
    isHttp2
} from '../../util/request-utils';
import {
    findRawHeader,
    objectHeadersToRaw,
    pairFlatRawHeaders,
    rawHeadersToObjectPreservingCase
} from '../../util/header-utils';
import { streamToBuffer } from '../../util/buffer-utils';
import { isLocalhostAddress } from '../../util/socket-util';
import { MaybePromise } from '../../util/type-utils';

import { getAgent } from '../http-agents';
import { ProxySettingSource } from '../proxy-config';
import { assertParamDereferenced, RuleParameters } from '../rule-parameters';
import {
    UPSTREAM_TLS_OPTIONS,
    shouldUseStrictHttps
} from '../passthrough-handling';

import {
    EchoWebSocketHandlerDefinition,
    ListenWebSocketHandlerDefinition,
    PassThroughWebSocketHandlerDefinition,
    PassThroughWebSocketHandlerOptions,
    RejectWebSocketHandlerDefinition,
    SerializedPassThroughWebSocketData,
    WebSocketHandlerDefinition,
    WsHandlerDefinitionLookup,
} from './websocket-handler-definitions';

export interface WebSocketHandler extends WebSocketHandlerDefinition {
    handle(
        // The incoming upgrade request
        request: OngoingRequest & http.IncomingMessage,
        // The raw socket on which we'll be communicating
        socket: net.Socket,
        // Initial data received
        head: Buffer
    ): Promise<void>;
}

export interface InterceptedWebSocket extends WebSocket {
    upstreamWebSocket: WebSocket;
}

function isOpen(socket: WebSocket) {
    return socket.readyState === WebSocket.OPEN;
}

// Based on ws's validation.js
function isValidStatusCode(code: number) {
    return ( // Standard code:
        code >= 1000 &&
        code <= 1014 &&
        code !== 1004 &&
        code !== 1005 &&
        code !== 1006
    ) || ( // Application-specific code:
        code >= 3000 && code <= 4999
    );
}

const INVALID_STATUS_REGEX = /Invalid WebSocket frame: invalid status code (\d+)/;

function pipeWebSocket(inSocket: WebSocket, outSocket: WebSocket) {
    const onPipeFailed = (op: string) => (err?: Error) => {
        if (!err) return;

        inSocket.close();
        console.error(`Websocket ${op} failed`, err);
    };

    inSocket.on('message', (msg, isBinary) => {
        if (isOpen(outSocket)) {
            outSocket.send(msg, { binary: isBinary }, onPipeFailed('message'))
        }
    });

    inSocket.on('close', (num, reason) => {
        if (isValidStatusCode(num)) {
            try {
                outSocket.close(num, reason);
            } catch (e) {
                console.warn(e);
                outSocket.close();
            }
        } else {
            outSocket.close();
        }
    });

    inSocket.on('ping', (data) => {
        if (isOpen(outSocket)) outSocket.ping(data, undefined, onPipeFailed('ping'))
    });

    inSocket.on('pong', (data) => {
        if (isOpen(outSocket)) outSocket.pong(data, undefined, onPipeFailed('pong'))
    });

    // If either socket has an general error (connection failure, but also could be invalid WS
    // frames) then we kill the raw connection upstream to simulate a generic connection error:
    inSocket.on('error', (err) => {
        console.log(`Error in proxied WebSocket:`, err);
        const rawOutSocket = outSocket as any;

        if (err.message.match(INVALID_STATUS_REGEX)) {
            const status = parseInt(INVALID_STATUS_REGEX.exec(err.message)![1]);

            // Simulate errors elsewhere by messing with ws internals. This may break things,
            // that's effectively on purpose: we're simulating the client going wrong:
            const buf = Buffer.allocUnsafe(2);
            buf.writeUInt16BE(status); // status comes from readUInt16BE, so always fits
            const sender = rawOutSocket._sender;
            sender.sendFrame(sender.constructor.frame(buf, {
                fin: true,
                rsv1: false,
                opcode: 0x08,
                mask: true,
                readOnly: false
            }), () => {
                rawOutSocket._socket.destroy();
            });
        } else {
            // Unknown error, just kill the connection with no explanation
            rawOutSocket._socket.destroy();
        }
    });
}

async function mirrorRejection(socket: net.Socket, rejectionResponse: http.IncomingMessage) {
    if (socket.writable) {
        const { statusCode, statusMessage, rawHeaders } = rejectionResponse;

        socket.write(
            rawResponse(statusCode || 500, statusMessage || 'Unknown error', pairFlatRawHeaders(rawHeaders))
        );

        const body = await streamToBuffer(rejectionResponse);
        if (socket.writable) socket.write(body);
    }

    socket.destroy();
}

const rawResponse = (
    statusCode: number,
    statusMessage: string,
    headers: RawHeaders = []
) =>
    `HTTP/1.1 ${statusCode} ${statusMessage}\r\n` +
    _.map(headers, ([key, value]) =>
        `${key}: ${value}`
    ).join('\r\n') +
    '\r\n\r\n';

export { PassThroughWebSocketHandlerOptions };

export class PassThroughWebSocketHandler extends PassThroughWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: InterceptedWebSocket) => {
            pipeWebSocket(ws, ws.upstreamWebSocket);
            pipeWebSocket(ws.upstreamWebSocket, ws);
        });
    }

    private _trustedCACertificates: MaybePromise<Array<string> | undefined>;
    private async trustedCACertificates(): Promise<Array<string> | undefined> {
        if (!this.extraCACertificates.length) return undefined;

        if (!this._trustedCACertificates) {
            this._trustedCACertificates = Promise.all(
                (tls.rootCertificates as Array<string | Promise<string>>)
                    .concat(this.extraCACertificates.map(certObject => {
                        if ('cert' in certObject) {
                            return certObject.cert.toString('utf8');
                        } else {
                            return fs.readFile(certObject.certPath, 'utf8');
                        }
                    }))
            );
        }

        return this._trustedCACertificates;
    }

    private _cacheableLookupInstance: CacheableLookup | undefined;
    private lookup() {
        if (!this.lookupOptions) return undefined;

        if (!this._cacheableLookupInstance) {
            this._cacheableLookupInstance = new CacheableLookup({
                maxTtl: this.lookupOptions.maxTtl,
                errorTtl: this.lookupOptions.errorTtl,
                // As little caching of "use the fallback server" as possible:
                fallbackDuration: 0
            });

            if (this.lookupOptions.servers) {
                this._cacheableLookupInstance.servers = this.lookupOptions.servers;
            }
        }

        return this._cacheableLookupInstance.lookup;
    }

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        let { protocol, hostname, port, path } = url.parse(req.url!);
        const rawHeaders = req.rawHeaders;

        const reqMessage = req as unknown as http.IncomingMessage;
        const isH2Downstream = isHttp2(req);
        const hostHeaderName = isH2Downstream ? ':authority' : 'host';

        if (isLocalhostAddress(hostname) && req.remoteIpAddress && !isLocalhostAddress(req.remoteIpAddress)) {
            // If we're proxying localhost traffic from another remote machine, then we should really be proxying
            // back to that machine, not back to ourselves! Best example is docker containers: if we capture & inspect
            // their localhost traffic, it should still be sent back into that docker container.
            hostname = req.remoteIpAddress;

            // We don't update the host header - from the POV of the target, it's still localhost traffic.
        }

        if (this.forwarding) {
            const { targetHost, updateHostHeader } = this.forwarding;

            let wsUrl: string;
            if (!targetHost.includes('/')) {
                // We're forwarding to a bare hostname, just overwrite that bit:
                [hostname, port] = targetHost.split(':');
            } else {
                // Forwarding to a full URL; override the host & protocol, but never the path.
                ({ protocol, hostname, port } = url.parse(targetHost));
            }

            // Connect directly to the forwarding target URL
            wsUrl = `${protocol!}//${hostname}${port ? ':' + port : ''}${path}`;

            // Optionally update the host header too:
            let hostHeader = findRawHeader(rawHeaders, hostHeaderName);
            if (!hostHeader) {
                // Should never happen really, but just in case:
                hostHeader = [hostHeaderName, hostname!];
                rawHeaders.unshift(hostHeader);
            };

            if (updateHostHeader === undefined || updateHostHeader === true) {
                // If updateHostHeader is true, or just not specified, match the new target
                hostHeader[1] = hostname + (port ? `:${port}` : '');
            } else if (updateHostHeader) {
                // If it's an explicit custom value, use that directly.
                hostHeader[1] = updateHostHeader;
            } // Otherwise: falsey means don't touch it.

            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head);
        } else if (!hostname) { // No hostname in URL means transparent proxy, so use Host header
            const hostHeader = req.headers[hostHeaderName];
            [ hostname, port ] = hostHeader!.split(':');

            // __lastHopEncrypted is set in http-combo-server, for requests that have explicitly
            // CONNECTed upstream (which may then up/downgrade from the current encryption).
            if (socket.__lastHopEncrypted !== undefined) {
                protocol = socket.__lastHopEncrypted ? 'wss' : 'ws';
            } else {
                protocol = reqMessage.connection.encrypted ? 'wss' : 'ws';
            }

            const wsUrl = `${protocol}://${hostname}${port ? ':' + port : ''}${path}`;
            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head);
        } else {
            // Connect directly according to the specified URL
            const wsUrl = `${
                protocol!.replace('http', 'ws')
            }//${hostname}${port ? ':' + port : ''}${path}`;

            await this.connectUpstream(wsUrl, reqMessage, rawHeaders, socket, head);
        }
    }

    private async connectUpstream(
        wsUrl: string,
        req: http.IncomingMessage,
        rawHeaders: RawHeaders,
        incomingSocket: net.Socket,
        head: Buffer
    ) {
        const parsedUrl = url.parse(wsUrl);
        const checkServerCertificate = shouldUseStrictHttps(
            parsedUrl.hostname!,
            parsedUrl.port!,
            this.ignoreHostHttpsErrors
        );

        const trustedCerts = await this.trustedCACertificates();
        const caConfig = trustedCerts
            ? { ca: trustedCerts }
            : {};

        const effectivePort = !!parsedUrl.port
            ? parseInt(parsedUrl.port, 10)
            : parsedUrl.protocol == 'wss:' ? 443 : 80;

        const proxySettingSource = assertParamDereferenced(this.proxyConfig) as ProxySettingSource;

        const agent = await getAgent({
            protocol: parsedUrl.protocol as 'ws:' | 'wss:',
            hostname: parsedUrl.hostname!,
            port: effectivePort,
            proxySettingSource,
            tryHttp2: false, // We don't support websockets over H2 yet
            keepAlive: false // Not a thing for websockets: they take over the whole connection
        });

        // We have to flatten the headers, as WS doesn't support raw headers - it builds its own
        // header object internally.
        const headers = rawHeadersToObjectPreservingCase(rawHeaders);

        const upstreamWebSocket = new WebSocket(wsUrl, {
            maxPayload: 0,
            agent,
            lookup: this.lookup(),
            headers: _.omitBy(headers, (_v, headerName) =>
                headerName.toLowerCase().startsWith('sec-websocket') ||
                headerName.toLowerCase() === 'connection' ||
                headerName.toLowerCase() === 'upgrade'
            ) as { [key: string]: string }, // Simplify to string - doesn't matter though, only used by http module anyway

            // TLS options:
            ...UPSTREAM_TLS_OPTIONS,
            rejectUnauthorized: checkServerCertificate,
            ...caConfig
        } as WebSocket.ClientOptions & { lookup: any, maxPayload: number });

        upstreamWebSocket.once('open', () => {
            this.wsServer!.handleUpgrade(req, incomingSocket, head, (ws) => {
                (<InterceptedWebSocket> ws).upstreamWebSocket = upstreamWebSocket;
                incomingSocket.emit('ws-upgrade', ws);
                this.wsServer!.emit('connection', ws);
            });
        });

        // If the upstream says no, we say no too.
        upstreamWebSocket.on('unexpected-response', (req, res) => {
            console.log(`Unexpected websocket response from ${wsUrl}: ${res.statusCode}`);
            mirrorRejection(incomingSocket, res);
        });

        // If there's some other error, we just kill the socket:
        upstreamWebSocket.on('error', (e) => {
            console.warn(e);
            incomingSocket.end();
        });

        incomingSocket.on('error', () => upstreamWebSocket.close(1011)); // Internal error
    }

    /**
     * @internal
     */
    static deserialize(
        data: SerializedPassThroughWebSocketData,
        channel: ClientServerChannel,
        ruleParams: RuleParameters
    ): any {
        // By default, we assume we just need to assign the right prototype
        return _.create(this.prototype, {
            ...data,
            extraCACertificates: data.extraCACertificates || [],
            proxyConfig: deserializeProxyConfig(data.proxyConfig, channel, ruleParams),
            ignoreHostHttpsErrors: data.ignoreHostCertificateErrors
        });
    }
}

export class EchoWebSocketHandler extends EchoWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: WebSocket) => {
            pipeWebSocket(ws, ws);
        });
    }

    async handle(req: OngoingRequest & http.IncomingMessage, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
            socket.emit('ws-upgrade', ws);
            this.wsServer!.emit('connection', ws);
        });
    }
}

export class ListenWebSocketHandler extends ListenWebSocketHandlerDefinition {

    private wsServer?: WebSocket.Server;

    private initializeWsServer() {
        if (this.wsServer) return;

        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on('connection', (ws: WebSocket) => {
            // Accept but ignore the incoming websocket data
            ws.resume();
        });
    }

    async handle(req: OngoingRequest & http.IncomingMessage, socket: net.Socket, head: Buffer) {
        this.initializeWsServer();

        this.wsServer!.handleUpgrade(req, socket, head, (ws) => {
            socket.emit('ws-upgrade', ws);
            this.wsServer!.emit('connection', ws);
        });
    }
}

export class RejectWebSocketHandler extends RejectWebSocketHandlerDefinition {

    async handle(req: OngoingRequest, socket: net.Socket, head: Buffer) {
        socket.write(rawResponse(this.statusCode, this.statusMessage, objectHeadersToRaw(this.headers)));
        if (this.body) socket.write(this.body);
        socket.write('\r\n');
        socket.destroy();
    }

}

// These three work equally well for HTTP requests as websockets, but it's
// useful to reexport there here for consistency.
export {
    CloseConnectionHandler,
    ResetConnectionHandler,
    TimeoutHandler
};

export const WsHandlerLookup: typeof WsHandlerDefinitionLookup = {
    'ws-passthrough': PassThroughWebSocketHandler,
    'ws-echo': EchoWebSocketHandler,
    'ws-listen': ListenWebSocketHandler,
    'ws-reject': RejectWebSocketHandler,
    'close-connection': CloseConnectionHandler,
    'reset-connection': ResetConnectionHandler,
    'timeout': TimeoutHandler
};
