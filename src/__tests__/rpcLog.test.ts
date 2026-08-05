import { describe, it, expect } from 'vitest';
import { rpcHost, redact } from '../chain/rpcLog.js';

describe('rpcLog — never leak a credential into the logs', () => {
  it('reduces a keyed endpoint to its host', () => {
    // The shape that matters: Alchemy-style keys live in the PATH.
    expect(rpcHost('https://eth-mainnet.g.alchemy.com/v2/SuperSecretKey123')).toBe(
      'eth-mainnet.g.alchemy.com',
    );
    expect(rpcHost('wss://rpc.example.com:8546/ws?apikey=abcd1234')).toBe('rpc.example.com');
    // userinfo is a credential too, and .host/.href would both keep it.
    expect(rpcHost('https://user:hunter2@node.example.com/rpc')).toBe('node.example.com');
  });

  it('never throws on a malformed endpoint', () => {
    expect(rpcHost('')).toBe('<unparseable>');
    expect(rpcHost('not-a-url')).toBe('<unparseable>');
  });

  it('strips URLs out of messages we did not author', () => {
    // A node echoing the request back would otherwise reprint the key that
    // rpcHost exists to keep out of the logs.
    const out = redact('request to https://eth.g.alchemy.com/v2/SuperSecretKey123 failed');
    expect(out).not.toContain('SuperSecretKey123');
    expect(out).toContain('eth.g.alchemy.com');
  });

  it('masks bearer tokens and long opaque keys', () => {
    expect(redact('authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    const token = 'a'.repeat(40);
    expect(redact(`token ${token} rejected`)).not.toContain(token);
  });

  it('leaves ordinary diagnostic text intact', () => {
    expect(redact('AbortError: This operation was aborted')).toBe(
      'AbortError: This operation was aborted',
    );
    expect(redact('429 Rate Limit Hit')).toBe('429 Rate Limit Hit');
  });

  it('redacts the real-world strings from this incident', () => {
    // Both verbatim from today: the HyperSync 401 body and an RPC 429.
    const hs = redact(
      'Your token is malformed. API Tokens can be created at https://app.envio.dev/api-tokens.',
    );
    expect(hs).not.toContain('/api-tokens');
    expect(hs).toContain('app.envio.dev');
  });
});
