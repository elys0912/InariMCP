import { describe, expect, it } from 'vitest';
import { maskSensitiveArgs, sanitizeResult } from '../src/safety/sanitizer.js';

// Built at runtime so no token-shaped literal sits in the repository.
const FAKE_JWT = `eyJ${'a'.repeat(12)}.${'b'.repeat(10)}.${'c'.repeat(10)}`;

describe('maskSensitiveArgs', () => {
  it('replaces sensitive argument values with *** and keeps the rest', () => {
    const args = {
      text: 'hello',
      script: 'alert(1)',
      value: 'v',
      password: 'p',
      steps: [{ tool: 'fox_click' }],
      action_script: 'x()',
      condition: 'true',
      selector: '#login',
      url: 'https://example.test/',
    };
    expect(maskSensitiveArgs(args)).toEqual({
      text: '***',
      script: '***',
      value: '***',
      password: '***',
      steps: '***',
      action_script: '***',
      condition: '***',
      selector: '#login',
      url: 'https://example.test/',
    });
  });

  it('does not mutate its input', () => {
    const args = { text: 'hello' };
    maskSensitiveArgs(args);
    expect(args).toEqual({ text: 'hello' });
  });

  it('matches keys exactly (camelCase actionScript is not in the list)', () => {
    expect(maskSensitiveArgs({ actionScript: 'x()' })).toEqual({ actionScript: 'x()' });
  });
});

describe('sanitizeResult', () => {
  it('passes null, undefined and non-string primitives through', () => {
    expect(sanitizeResult(null)).toBeNull();
    expect(sanitizeResult(undefined)).toBeUndefined();
    expect(sanitizeResult(42)).toBe(42);
    expect(sanitizeResult(true)).toBe(true);
  });

  it('masks Bearer tokens but keeps the scheme', () => {
    expect(sanitizeResult('Authorization: Bearer abc.def-123 rest')).toBe(
      'Authorization: Bearer [MASKED] rest',
    );
    expect(sanitizeResult('bearer xyz')).toBe('bearer [MASKED]');
  });

  it('masks JWT-shaped strings', () => {
    expect(sanitizeResult(`token=${FAKE_JWT};`)).toBe('token=[MASKED];');
  });

  it('masks authorization / cookie / set-cookie keys case-insensitively, whatever the value', () => {
    expect(
      sanitizeResult({
        Authorization: 'Basic abc',
        cookie: 'sid=1',
        'Set-Cookie': ['a=1', 'b=2'],
        'content-type': 'text/html',
      }),
    ).toEqual({
      Authorization: '[MASKED]',
      cookie: '[MASKED]',
      'Set-Cookie': '[MASKED]',
      'content-type': 'text/html',
    });
  });

  it('recurses into arrays and nested objects', () => {
    expect(
      sanitizeResult({
        logs: [
          { headers: { authorization: 'x' }, body: `Bearer tok` },
          FAKE_JWT,
          3,
        ],
      }),
    ).toEqual({
      logs: [
        { headers: { authorization: '[MASKED]' }, body: 'Bearer [MASKED]' },
        '[MASKED]',
        3,
      ],
    });
  });

  it('leaves ordinary text alone and does not mutate its input', () => {
    const input = { title: 'Example page', count: 2 };
    expect(sanitizeResult(input)).toEqual({ title: 'Example page', count: 2 });
    expect(sanitizeResult(input)).not.toBe(input);
  });
});
