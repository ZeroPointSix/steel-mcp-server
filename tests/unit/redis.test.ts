// ABOUTME: Unit tests for the Redis client adapter: each registry command maps to the right client
// ABOUTME: call, including the millisecond expiry, and a connection error is reported, never thrown.
import { describe, expect, it } from 'vitest';
import { redisConnection } from '../../src/core/redis.js';
import { RecordingRedisClient } from '../helpers/fake-redis.js';

function connection(client: RecordingRedisClient, onError: (error: unknown) => void = () => {}) {
    return redisConnection(client, onError);
}

describe('redisConnection commands', () => {
    it('sets a value with a millisecond expiry, the only TTL unit the registry uses', async () => {
        const client = new RecordingRedisClient();
        await connection(client).commands.set('steel-mcp:handle:sess_1', '{}', 90_000);

        expect(client.calls).toEqual([{ command: 'set', args: ['steel-mcp:handle:sess_1', '{}', 'PX', 90_000] }]);
    });

    it('passes reads, deletes and set membership straight through', async () => {
        const client = new RecordingRedisClient({ get: '{"handle":"sess_1"}', del: 1, smembers: ['sess_1'] });
        const commands = connection(client).commands;

        expect(await commands.get('key')).toBe('{"handle":"sess_1"}');
        expect(await commands.del('key')).toBe(1);
        expect(await commands.smembers('index')).toEqual(['sess_1']);
        await commands.sadd('index', 'sess_1');
        await commands.srem('index', 'sess_1');

        expect(client.calls.map(call => call.command)).toEqual(['get', 'del', 'smembers', 'sadd', 'srem']);
        expect(client.calls.at(-1)?.args).toEqual(['index', 'sess_1']);
    });

    it('reports how many keys a delete removed, which is what settles a concurrent sweep', async () => {
        expect(await connection(new RecordingRedisClient({ del: 0 })).commands.del('gone')).toBe(0);
    });
});

describe('redisConnection lifecycle', () => {
    it('reports a client error instead of letting it take the replica down', () => {
        // An ioredis client with no error listener turns a reconnect into an uncaught exception.
        const failures: unknown[] = [];
        const client = new RecordingRedisClient();
        connection(client, error => failures.push(error));

        client.emitError(new Error('ECONNREFUSED'));

        expect(failures.map(String)).toEqual(['Error: ECONNREFUSED']);
    });

    it('quits the client on close, so a shutting-down replica frees its connection', async () => {
        const client = new RecordingRedisClient();
        await connection(client).close();

        expect(client.calls.map(call => call.command)).toEqual(['quit']);
    });
});
