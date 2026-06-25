import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import {
    InMemoryTransport,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    isStandardSchema,
    LATEST_PROTOCOL_VERSION
} from '@modelcontextprotocol/core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { McpServer, ResourceTemplate } from '../../src/index.js';
import type { InferRawShape } from '../../src/server/mcp.js';
import { completable } from '../../src/server/completable.js';

async function sendRequest(server: McpServer, method: string, params?: Record<string, unknown>): Promise<JSONRPCMessage> {
    const [client, srv] = InMemoryTransport.createLinkedPair();
    await server.connect(srv);
    await client.start();

    try {
        const responsePromise = new Promise<JSONRPCMessage>(resolve => {
            client.onmessage = m => resolve(m);
        });

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method,
            ...(params === undefined ? {} : { params })
        } as JSONRPCMessage);

        return await responsePromise;
    } finally {
        await server.close();
    }
}

describe('registerTool/registerPrompt accept raw Zod shape (auto-wrapped)', () => {
    it('registerTool accepts a raw shape for inputSchema and auto-wraps it', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('a', { inputSchema: { x: z.number() } }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));
        server.registerTool('b', { inputSchema: { y: z.number() } }, async ({ y }) => ({
            content: [{ type: 'text' as const, text: String(y) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(Object.keys(tools)).toEqual(['a', 'b']);
        // raw shape was wrapped into a Standard Schema (z.object)
        expect(isStandardSchema(tools['a']?.inputSchema)).toBe(true);
    });

    it('registerTool accepts a raw shape for outputSchema and auto-wraps it', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('out', { inputSchema: { n: z.number() }, outputSchema: { result: z.string() } }, async ({ n }) => ({
            content: [{ type: 'text' as const, text: String(n) }],
            structuredContent: { result: String(n) }
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['out']?.outputSchema)).toBe(true);
    });

    it('registerTool with z.object() inputSchema also works (passthrough, no auto-wrap)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerTool('c', { inputSchema: z.object({ x: z.number() }) }, async ({ x }) => ({
            content: [{ type: 'text' as const, text: String(x) }]
        }));

        const tools = (server as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
        expect(isStandardSchema(tools['c']?.inputSchema)).toBe(true);
    });

    it('registerPrompt accepts a raw shape for argsSchema', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt('p', { argsSchema: { topic: z.string() } }, async ({ topic }) => ({
            messages: [{ role: 'user' as const, content: { type: 'text' as const, text: topic } }]
        }));

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(Object.keys(prompts)).toContain('p');
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('registerPrompt raw shape accepts completable() fields (v1 pattern)', () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        server.registerPrompt(
            'p',
            {
                argsSchema: {
                    language: completable(z.string(), v => ['typescript', 'python'].filter(l => l.startsWith(v)))
                }
            },
            async ({ language }) => ({
                messages: [{ role: 'user' as const, content: { type: 'text' as const, text: language } }]
            })
        );

        const prompts = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: unknown }> })._registeredPrompts;
        expect(isStandardSchema(prompts['p']?.argsSchema)).toBe(true);
    });

    it('callback receives validated, typed args end-to-end via tools/call', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });

        let received: { x: number } | undefined;
        server.registerTool('echo', { inputSchema: { x: z.number() } }, async args => {
            received = args;
            return { content: [{ type: 'text' as const, text: String(args.x) }] };
        });

        const [client, srv] = InMemoryTransport.createLinkedPair();
        await server.connect(srv);
        await client.start();

        const responses: JSONRPCMessage[] = [];
        client.onmessage = m => responses.push(m);

        await client.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'c', version: '1.0.0' }
            }
        } as JSONRPCMessage);
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
        await client.send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'echo', arguments: { x: 7 } }
        } as JSONRPCMessage);

        await vi.waitFor(() => expect(responses.some(r => 'id' in r && r.id === 2)).toBe(true));

        expect(received).toEqual({ x: 7 });
        const result = responses.find(r => 'id' in r && r.id === 2) as { result?: { content: Array<{ text: string }> } };
        expect(result.result?.content[0]?.text).toBe('7');

        await server.close();
    });
});

describe('InferRawShape', () => {
    it('preserves optionality from .optional() as ?: keys', () => {
        type S = InferRawShape<{ a: z.ZodString; b: z.ZodOptional<z.ZodString> }>;
        expectTypeOf<S>().toEqualTypeOf<{ a: string; b?: string | undefined }>();
    });
});

describe('high-level list pagination', () => {
    it('paginates registered tools', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        for (let i = 0; i < 101; i++) {
            server.registerTool(`tool-${i}`, { inputSchema: z.object({}) }, async () => ({ content: [] }));
        }

        const first = await sendRequest(server, 'tools/list');
        expect(isJSONRPCResultResponse(first)).toBe(true);
        if (!isJSONRPCResultResponse(first)) throw new Error('expected result');
        expect(first.result.tools).toHaveLength(100);
        expect(first.result.nextCursor).toBe('100');

        const second = await sendRequest(server, 'tools/list', { cursor: first.result.nextCursor });
        expect(isJSONRPCResultResponse(second)).toBe(true);
        if (!isJSONRPCResultResponse(second)) throw new Error('expected result');
        expect(second.result.tools).toHaveLength(1);
        expect(second.result.nextCursor).toBeUndefined();
    });

    it('paginates registered resources, resource templates, and prompts', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        for (let i = 0; i < 101; i++) {
            server.registerResource(`resource-${i}`, `file:///resource-${i}`, {}, async uri => ({
                contents: [{ uri: uri.href, text: '' }]
            }));
            server.registerResource(
                `template-${i}`,
                new ResourceTemplate(`file:///template-${i}/{id}`, { list: undefined }),
                {},
                async uri => ({
                    contents: [{ uri: uri.href, text: '' }]
                })
            );
            server.registerPrompt(`prompt-${i}`, {}, () => ({ messages: [] }));
        }

        const resources = await sendRequest(server, 'resources/list');
        expect(isJSONRPCResultResponse(resources)).toBe(true);
        if (!isJSONRPCResultResponse(resources)) throw new Error('expected result');
        expect(resources.result.resources).toHaveLength(100);
        expect(resources.result.nextCursor).toBe('100');

        const resourceTemplates = await sendRequest(server, 'resources/templates/list');
        expect(isJSONRPCResultResponse(resourceTemplates)).toBe(true);
        if (!isJSONRPCResultResponse(resourceTemplates)) throw new Error('expected result');
        expect(resourceTemplates.result.resourceTemplates).toHaveLength(100);
        expect(resourceTemplates.result.nextCursor).toBe('100');

        const prompts = await sendRequest(server, 'prompts/list');
        expect(isJSONRPCResultResponse(prompts)).toBe(true);
        if (!isJSONRPCResultResponse(prompts)) throw new Error('expected result');
        expect(prompts.result.prompts).toHaveLength(100);
        expect(prompts.result.nextCursor).toBe('100');
    });

    it('rejects invalid list cursors', async () => {
        const server = new McpServer({ name: 't', version: '1.0.0' });
        server.registerTool('echo', { inputSchema: z.object({}) }, async () => ({ content: [] }));

        const response = await sendRequest(server, 'tools/list', { cursor: 'not-a-cursor' });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (!isJSONRPCErrorResponse(response)) throw new Error('expected error');
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toContain('Invalid pagination cursor');
    });
});
