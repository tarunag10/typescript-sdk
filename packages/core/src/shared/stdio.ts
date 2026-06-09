import { INVALID_REQUEST } from '../types/constants.js';
import type { JSONRPCErrorResponse, JSONRPCMessage, RequestId } from '../types/index.js';
import { JSONRPCMessageSchema } from '../types/index.js';

/**
 * Buffers a continuous stdio stream into discrete JSON-RPC messages.
 */
export class ReadBuffer {
    private _buffer?: Buffer;

    append(chunk: Buffer): void {
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }

    readMessage(): JSONRPCMessage | null {
        while (this._buffer) {
            const index = this._buffer.indexOf('\n');
            if (index === -1) {
                return null;
            }

            const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
            this._buffer = this._buffer.subarray(index + 1);

            try {
                return deserializeMessage(line);
            } catch (error) {
                // Skip non-JSON lines (e.g., debug output from hot-reload tools like
                // tsx or nodemon that write to stdout). Schema validation errors still
                // throw so malformed-but-valid-JSON messages surface via onerror.
                if (error instanceof SyntaxError) {
                    continue;
                }
                throw error;
            }
        }
        return null;
    }

    clear(): void {
        this._buffer = undefined;
    }
}

export class JSONRPCMessageParseError extends Error {
    constructor(
        public readonly parsedValue: unknown,
        public readonly cause: unknown
    ) {
        super('Invalid JSON-RPC message');
        this.name = 'JSONRPCMessageParseError';
    }

    recoverRequestId(): RequestId | null | undefined {
        if (Array.isArray(this.parsedValue)) {
            return null;
        }

        if (this.parsedValue && typeof this.parsedValue === 'object' && 'id' in this.parsedValue) {
            const requestId = (this.parsedValue as { id?: unknown }).id;
            if (typeof requestId === 'string') {
                return requestId;
            }

            if (typeof requestId === 'number' && Number.isInteger(requestId)) {
                return requestId;
            }
        }

        return undefined;
    }

    toInvalidRequestResponse(): JSONRPCErrorResponse | undefined {
        const id = this.recoverRequestId();
        if (id === undefined) {
            return undefined;
        }

        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: INVALID_REQUEST,
                message: 'Invalid Request'
            }
        };
    }
}

export function deserializeMessage(line: string): JSONRPCMessage {
    const parsedValue = JSON.parse(line);
    const message = JSONRPCMessageSchema.safeParse(parsedValue);
    if (message.success) {
        return message.data;
    }

    throw new JSONRPCMessageParseError(parsedValue, message.error);
}

export function serializeMessage(message: JSONRPCMessage): string {
    return JSON.stringify(message) + '\n';
}
