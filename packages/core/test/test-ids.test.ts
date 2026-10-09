import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REJECT_TEST_ID_VALUES,
  detectTestIdAttributes,
  isConfiguredTestIdAttribute,
  isRejectedTestIdValue,
  looksLikeTestIdAttribute,
  normaliseAttributeName,
} from '../src/locators/test-ids.js';

describe('normaliseAttributeName', () => {
  it.each([
    ['data-testid', 'datatestid'],
    ['data-test-id', 'datatestid'],
    ['data_test_id', 'datatestid'],
    ['datatestid', 'datatestid'],
    ['data-testId', 'datatestid'],
    ['data-test', 'datatest'],
    ['data-qa-id', 'dataqaid'],
    ['qa-id', 'qaid'],
    ['data-automation-id', 'dataautomationid'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseAttributeName(input)).toBe(expected);
  });
});

describe('looksLikeTestIdAttribute', () => {
  it.each(['data-testid', 'data-test', 'data-qa', 'qa-id', 'data-cy', 'data-pw', 'data-e2e', 'automation-id'])(
    'accepts %s',
    (name) => expect(looksLikeTestIdAttribute(name)).toBe(true),
  );

  it.each(['data-id', 'data-testing', 'class', 'id', 'data-test-value', 'aria-label'])('rejects %s', (name) =>
    expect(looksLikeTestIdAttribute(name)).toBe(false),
  );
});

describe('isConfiguredTestIdAttribute', () => {
  it('matches across spellings', () => {
    expect(isConfiguredTestIdAttribute('data-test-id', ['data-testid'])).toBe(true);
    expect(isConfiguredTestIdAttribute('data-test', ['data-testid'])).toBe(false);
  });
});

describe('isRejectedTestIdValue', () => {
  it.each(['a81f9c2d0b', 'row-200394', '', '  '])('rejects generated-looking %j', (value) =>
    expect(isRejectedTestIdValue(value, DEFAULT_REJECT_TEST_ID_VALUES)).toBe(true),
  );

  it.each(['save-user', 'add-to-cart-sauce-labs-backpack', 'item-4-title-link'])('keeps %j', (value) =>
    expect(isRejectedTestIdValue(value, DEFAULT_REJECT_TEST_ID_VALUES)).toBe(false),
  );

  it('ignores lastIndex on global patterns', () => {
    const global = [/\d{5,}/g];
    expect(isRejectedTestIdValue('row-200394', global)).toBe(true);
    expect(isRejectedTestIdValue('row-200394', global)).toBe(true);
  });
});

describe('detectTestIdAttributes', () => {
  it('keeps test-id attributes with at least minCount elements, ordered deterministically', () => {
    const counts = { 'data-test': 412, 'data-testid': 37, 'data-qa': 4, 'data-id': 900, class: 2000, 'data-cy': 37 };
    expect(detectTestIdAttributes(counts)).toEqual([
      { attribute: 'data-test', count: 412 },
      { attribute: 'data-cy', count: 37 },
      { attribute: 'data-testid', count: 37 },
    ]);
  });
});
