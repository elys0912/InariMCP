import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '../src/utils/endpoint.js';

describe('isLoopbackHost (FOX_HOST check, Po-09)', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.test', '127.0.0.1.example.test'])('%s is not', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
