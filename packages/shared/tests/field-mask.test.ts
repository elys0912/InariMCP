/**
 * field-mask.ts: the one rule of which field values both backends mask,
 * and the selectors the reading tools refuse. The backends' use of it is
 * checked in a page: tests/contract/extension-content.test.ts and
 * packages/mcp-server/tests/headless-actions.test.ts.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertReadSelector,
  isMaskedField,
  MASKED_VALUE,
  maskedText,
  MAX_READ_SELECTOR_LENGTH,
  readSelectorProblem,
  selectorTestProblem,
  type MaskFieldInfo,
} from '@inari-mcp/shared/field-mask';

const field = (localName: string, type: string, autocomplete: string | null = null): MaskFieldInfo =>
  ({ localName, type, autocomplete });

const option = (select: MaskFieldInfo | null): MaskFieldInfo => ({ localName: 'option', type: '', autocomplete: null, select });

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
    ['autocomplete=cc-name (the card holder)', field('input', 'text', 'cc-name'), true],
    ['autocomplete=cc-family-name', field('input', 'text', 'cc-family-name'), true],
    ['autocomplete=cc-type', field('input', 'text', 'cc-type'), true],
    ['<select> autocomplete=cc-exp-month', field('select', 'select-one', 'cc-exp-month'), true],
    ['<select> autocomplete=cc-exp-year', field('select', 'select-one', 'cc-exp-year'), true],
    ['<textarea> autocomplete=one-time-code', field('textarea', 'textarea', 'one-time-code'), true],
    ['a token among others, in any case', field('input', 'text', 'section-pay billing CC-Number'), true],
    ['an <option> of a masked <select>', option(field('select', 'select-one', 'cc-exp-month')), true],
    ['input type=text', field('input', 'text'), false],
    ['autocomplete=username', field('input', 'text', 'username'), false],
    ['a token only as a substring', field('input', 'text', 'x-cc-number'), false],
    ['type=hidden on an element that is not an <input>', field('button', 'hidden'), false],
    ['a masked token on an element without a value', field('div', '', 'cc-number'), false],
    ['an <option> of a <select> that is not masked', option(field('select', 'select-one', 'country')), false],
    ['an <option> outside a <select> (a <datalist>)', option(null), false],
    ['an <option> whose select was not read', field('option', '', 'cc-number'), false],
  ])('%s → %s', (_what, info, masked) => {
    expect(isMaskedField(info)).toBe(masked);
  });

  it('maskedText masks the non-empty text of a masked field only', () => {
    expect([maskedText('05', true), maskedText('', true), maskedText('Japan', false)]).toEqual(['[MASKED]', '', 'Japan']);
  });

  it('masks as [MASKED], as every other mask of the project', () => {
    expect(MASKED_VALUE).toBe('[MASKED]');
  });

  it('imports nothing (the Extension bundles it)', () => {
    const text = fs.readFileSync(fileURLToPath(new URL('../src/field-mask.ts', import.meta.url)), 'utf-8');
    expect(text).not.toMatch(/^import /m);
  });
});

describe('readSelectorProblem', () => {
  it.each([
    ['[value^="a"] on a hidden field', 'input[type=hidden][name=csrf][value^="a"]'],
    ['[value] without an operator', 'input[value]'],
    ['every attribute operator', '[value~=a], [value|=a], [value$=a], [value*=a], [value=a]'],
    ['upper case', 'INPUT[VALUE="a"]'],
    ['white space inside the brackets', 'input[ value = "a" ]'],
    ['a namespace prefix', 'input[*|value="a"]'],
    ['an empty namespace prefix', 'input[|value="a"]'],
    ['a case flag', '[value="a" i]'],
    ['a hex escape in the name', 'input[\\76 alue="a"]'],
    ['a character escape in the name', 'input[va\\lue="a"]'],
    ['a comment inside the brackets', 'input[/* x */value="a"]'],
    ['a comment opened inside a string', 'input[title="/*"][value="a"][lang="*/"]'],
    ['inside :is()', 'form :is([value="a"])'],
    [':checked', 'select[autocomplete~=cc-exp-month] option:checked'],
    [':checked in upper case', 'input:CHECKED'],
    [':checked with an escape', 'option:\\63 hecked'],
    [':checked inside :not()', 'option:not(:not(:checked))'],
    ['[selected] (the option a page drew as chosen)', 'select[autocomplete~=cc-exp-month] option[selected]'],
    ['[selected] in upper case', 'option[SELECTED]'],
    ['[selected] with a namespace prefix', 'option[ns|selected]'],
    ['[selected] after another pseudo-class', 'option:nth-child(2)[selected]'],
    [':default', 'option:default'],
    [':default in upper case, inside :is()', 'select :is(OPTION:DEFAULT)'],
    ['a selector longer than the limit', `#a${' a'.repeat(MAX_READ_SELECTOR_LENGTH)}`],
  ])('refuses %s', (_what, selector) => {
    expect(readSelectorProblem(selector)).not.toBeNull();
  });

  it.each([
    ['an id', '#login'],
    ['a type and a name', 'input[type=hidden][name=csrf]'],
    ['an attribute whose name only contains value', 'li[data-value="3"]'],
    ['an attribute whose name starts with value', 'x-item[valued]'],
    ['value inside a string', 'a[title="[value=1]"]'],
    [':checked inside a string', 'a[title=":checked"]'],
    ['other pseudo-classes', 'input:disabled, li:nth-child(2), a:hover'],
    ['an attribute whose name only contains selected', 'li[data-selected]'],
    ['[checked] (no masked field has a checked state)', 'input[name=plan][checked]'],
    ['a selector of exactly the limit', `#${'a'.repeat(MAX_READ_SELECTOR_LENGTH - 1)}`],
    ['an empty selector (the element is required elsewhere)', ''],
  ])('accepts %s', (_what, selector) => {
    expect(readSelectorProblem(selector)).toBeNull();
  });

  it('says what was refused and what to use instead', () => {
    expect(readSelectorProblem('[value="a"]')).toMatch(/value or selected attribute.*id, name, type or position/);
    expect(readSelectorProblem('option:checked')).toMatch(/:checked or :default/);
    expect(readSelectorProblem('a'.repeat(MAX_READ_SELECTOR_LENGTH + 1))).toMatch(/longer than 1024 characters \(1025\)/);
  });

  // Quadratic scans took seconds on such inputs (100 000 '[' about 9 s).
  it.each([
    ['open brackets', '['],
    ['brackets with a letter', '[a'],
    ['backslashes', '\\'],
    ['quotes', '"\\'],
    ['namespace bars', '[|'],
  ])('reads 100 000 characters of %s in linear time', (_what, unit) => {
    const selector = unit.repeat(Math.ceil(100_000 / unit.length));
    const started = performance.now();
    selectorTestProblem(selector);
    expect(performance.now() - started).toBeLessThan(500);
    expect(readSelectorProblem(selector)).toMatch(/longer than/);
  });
});

describe('assertReadSelector', () => {
  it('throws the reason for a refused selector, and passes the others and a missing one', () => {
    expect(() => assertReadSelector('input[value^="a"]')).toThrow(/^Selector refused: it tests the value or selected attribute/);
    expect(() => assertReadSelector('#login')).not.toThrow();
    expect(() => assertReadSelector(undefined)).not.toThrow();
  });
});
