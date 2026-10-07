import { describe, expect, it } from 'vitest';
import { maskSensitiveArgs, sanitizeResult, sanitizeString } from '../src/safety/sanitizer.js';

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

  it('matches keys whatever their case or separator (actionScript as in the schema)', () => {
    expect(maskSensitiveArgs({ actionScript: 'x()', promptText: 'p', Password: 'q', selector: 's' }))
      .toEqual({ actionScript: '***', promptText: '***', Password: '***', selector: 's' });
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

describe('sanitizeResult: secret keys', () => {
  it('masks API-key and token headers in any spelling', () => {
    expect(
      sanitizeResult({
        'X-API-Key': 'k',
        'x-auth-token': 't',
        'Proxy-Authorization': 'p',
        'X-CSRF-Token': 'c',
        accessToken: 'a',
        'x-request-id': 'keep',
      }),
    ).toEqual({
      'X-API-Key': '[MASKED]',
      'x-auth-token': '[MASKED]',
      'Proxy-Authorization': '[MASKED]',
      'X-CSRF-Token': '[MASKED]',
      accessToken: '[MASKED]',
      'x-request-id': 'keep',
    });
  });
});

describe('sanitizeString', () => {
  it('masks Basic credentials', () => {
    expect(sanitizeString('Authorization: Basic dXNlcjpwYXNzd29yZA==')).toBe(
      'Authorization: Basic [MASKED]',
    );
  });

  it('masks secret query parameters and form fields', () => {
    expect(sanitizeString('https://a.test/cb?code=1&access_token=abc&state=s')).toBe(
      'https://a.test/cb?code=1&access_token=[MASKED]&state=s',
    );
    expect(sanitizeString('user=me&password=hunter2&remember=1')).toBe(
      'user=me&password=[MASKED]&remember=1',
    );
  });

  it('masks secret JSON fields, including escaped quotes', () => {
    expect(sanitizeString('{"user":"me","password":"a\\"b","api_key": "k1"}')).toBe(
      '{"user":"me","password":"[MASKED]","api_key": "[MASKED]"}',
    );
  });

  it('leaves prose that mentions a secret name alone', () => {
    expect(sanitizeString('Enter your password: at least 8 characters')).toBe(
      'Enter your password: at least 8 characters',
    );
    expect(sanitizeString('pageToken=abc')).toBe('pageToken=abc');
  });

  it('strips bidi controls, zero-width characters, tag characters and C0/C1 controls', () => {
    const ch = (...codes: number[]) => String.fromCodePoint(...codes);
    const hidden =
      'pay' + ch(0x202e) + 'lapyap' + ch(0x202c) + ch(0x200b) + ch(0x2066) + 'x' + ch(0x2069) +
      ch(0xfeff) + ch(0xe0041, 0xe0042) + ch(0x0007) + ch(0x009b) + 'end';
    expect(sanitizeString(hidden)).toBe('paylapyapxend');
  });

  it('keeps tab, newline, carriage return and ordinary non-ASCII text', () => {
    const [tab, lf, cr] = [0x09, 0x0a, 0x0d].map((c) => String.fromCharCode(c));
    const text = `a${tab}b${lf}c${cr}${lf}d ` + String.fromCodePoint(0x65e5, 0x672c) + ' caf' +
      String.fromCodePoint(0xe9);
    expect(sanitizeString(text)).toBe(text);
  });

  it('is applied to strings and keys inside results', () => {
    const zw = String.fromCodePoint(0x200b);
    expect(sanitizeResult({ ['ti' + zw + 'tle']: 'a' + zw + 'b', logs: ['?token=x'] })).toEqual({
      title: 'ab',
      logs: ['?token=[MASKED]'],
    });
  });
});

describe('sanitizeResult: network log bodies', () => {
  it('masks secrets in request and response bodies and headers', () => {
    expect(
      sanitizeResult({
        logs: [{
          url: 'https://a.test/login',
          requestHeaders: { 'Content-Type': 'application/json', 'X-Auth-Token': 't' },
          requestBody: '{"username":"me","password":"pw"}',
          responseBody: '{"access_token":"tok","expires_in":3600}',
        }],
      }),
    ).toEqual({
      logs: [{
        url: 'https://a.test/login',
        requestHeaders: { 'Content-Type': 'application/json', 'X-Auth-Token': '[MASKED]' },
        requestBody: '{"username":"me","password":"[MASKED]"}',
        responseBody: '{"access_token":"[MASKED]","expires_in":3600}',
      }],
    });
  });
});

describe('review follow-ups', () => {
  const ch = (...codes: number[]) => String.fromCodePoint(...codes);

  it('masks secrets in URL fragments and camelCase JSON fields', () => {
    expect(sanitizeString('https://a.test/cb#access_token=abc&state=s')).toBe(
      'https://a.test/cb#access_token=[MASKED]&state=s',
    );
    expect(sanitizeString('{"accessToken":"a","refreshToken":"b","user":"u"}')).toBe(
      '{"accessToken":"[MASKED]","refreshToken":"[MASKED]","user":"u"}',
    );
    expect(sanitizeString('?api-key=k&csrf_token=c')).toBe('?api-key=[MASKED]&csrf_token=[MASKED]');
  });

  it('masks token / private-token / secret-key / subscription-key keys', () => {
    expect(sanitizeResult({ token: 't', 'Private-Token': 'p', secretKey: 's', 'Ocp-Apim-Subscription-Key': 'o' }))
      .toEqual({ token: '[MASKED]', 'Private-Token': '[MASKED]', secretKey: '[MASKED]', 'Ocp-Apim-Subscription-Key': '[MASKED]' });
  });

  it('masks secrets inside non-sensitive audit arguments such as url', () => {
    expect(maskSensitiveArgs({ url: 'https://a.test/?token=abc' })).toEqual({ url: 'https://a.test/?token=[MASKED]' });
  });

  it('keeps ZWJ / ZWNJ and emoji variation selectors, strips supplementary variation selectors', () => {
    const family = ch(0x1f468, 0x200d, 0x1f469);
    const heart = ch(0x2764, 0xfe0f);
    const zwnj = 'a' + ch(0x200c) + 'b';
    expect(sanitizeString(family + heart + zwnj)).toBe(family + heart + zwnj);
    expect(sanitizeString('x' + ch(0xe0100, 0xe01ef) + 'y' + ch(0x00ad) + 'z')).toBe('xyz');
  });

  it('does not let a stripped key overwrite another key', () => {
    const zw = ch(0x200b);
    expect(sanitizeResult({ ['a' + zw]: 'page', a: 'real' })).toEqual({ ['a' + zw]: 'page', a: 'real' });
  });
});
