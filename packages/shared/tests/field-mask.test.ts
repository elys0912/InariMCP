/**
 * field-mask.ts: the one rule of which field values both backends mask
 * (decision #4, Fo-03). The backends' use of it is checked in a page:
 * tests/contract/extension-content.test.ts and
 * packages/mcp-server/tests/headless-actions.test.ts.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMaskedField, MASKED_VALUE, type MaskFieldInfo } from '@inari-mcp/shared/field-mask';

const field = (localName: string, type: string, autocomplete: string | null = null): MaskFieldInfo =>
  ({ localName, type, autocomplete });

describe('isMaskedField', () => {
  it.each([
    ['input type=password', field('input', 'password'), true],
    ['input type=PASSWORD (type compared in lower case)', field('input', 'PASSWORD'), true],
    ['input type=hidden', field('input', 'hidden'), true],
    ['autocomplete=current-password', field('input', 'text', 'current-password'), true],
    ['autocomplete=new-password', field('input', 'text', 'new-password'), true],
    ['autocomplete=one-time-code', field('input', 'text', 'one-time-code'), true],
    ['autocomplete=cc-number', field('input', 'tel', 'cc-number'), true],
    ['autocomplete=cc-csc', field('input', 'text', 'cc-csc'), true],
    ['autocomplete=cc-exp', field('input', 'text', 'cc-exp'), true],
    ['<select> autocomplete=cc-exp-month', field('select', 'select-one', 'cc-exp-month'), true],
    ['<select> autocomplete=cc-exp-year', field('select', 'select-one', 'cc-exp-year'), true],
    ['<textarea> autocomplete=one-time-code', field('textarea', 'textarea', 'one-time-code'), true],
    ['a token among others, in any case', field('input', 'text', 'section-pay billing CC-Number'), true],
    ['input type=text', field('input', 'text'), false],
    ['autocomplete=username', field('input', 'text', 'username'), false],
    ['autocomplete=cc-name (not a secret)', field('input', 'text', 'cc-name'), false],
    ['a token only as a substring', field('input', 'text', 'x-cc-number'), false],
    ['type=hidden on an element that is not an <input>', field('button', 'hidden'), false],
    ['a masked token on an element without a value', field('div', '', 'cc-number'), false],
  ])('%s → %s', (_what, info, masked) => {
    expect(isMaskedField(info)).toBe(masked);
  });

  it('masks as [MASKED], as every other mask of the project', () => {
    expect(MASKED_VALUE).toBe('[MASKED]');
  });

  it('imports nothing (the Extension bundles it)', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/field-mask.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
  });
});
