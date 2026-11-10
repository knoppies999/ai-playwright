import { describe, expect, it } from 'vitest';
import { urlPattern } from '../src/cache/plan.js';
import { isGeneratedId } from '../src/locators/generated.js';
import { DEFAULT_REJECT_TEST_ID_VALUES, isRejectedTestIdValue } from '../src/locators/test-ids.js';
import { isIdSegment, stableNamePrefix, withoutCounter } from '../src/locators/volatile.js';

describe('volatile values (docs/12 §5)', () => {
  it.each(['product-01M4KFJHJFJBXR3A2RWKK2Z7GK', 'row_507f1f77bcf86cd799439011', 'V1StGXR8Z5jdHi6BmyT'])(
    'rejects record-id test ids: %s',
    (value) => expect(isRejectedTestIdValue(value, DEFAULT_REJECT_TEST_ID_VALUES)).toBe(true),
  );

  it.each(['save-user', 'nav-sign-in', 'product-name', 'checkout-step-2', 'internationalization'])(
    'keeps ordinary test ids: %s',
    (value) => expect(isRejectedTestIdValue(value, DEFAULT_REJECT_TEST_ID_VALUES)).toBe(false),
  );

  it('treats ULID-like ids as generated element ids', () => {
    expect(isGeneratedId('card-01M4KFJHJFJBXR3A2RWKK2Z7GK')).toBe(true);
    expect(isGeneratedId('user-email')).toBe(false);
  });

  it('wildcards ULID path segments in URL patterns', () => {
    expect(urlPattern('https://shop.test/product/01M4KFJHQ7DCZPAAVBCF32CGAH')).toBe('https://shop.test/product/*');
    expect(isIdSegment('categories')).toBe(false);
  });

  it('takes the stable start of a name that embeds a price', () => {
    expect(stableNamePrefix('Combination Pliers Compare Combination Pliers CO₂: A B C D E $14.15')).toBe(
      'Combination Pliers Compare Combination',
    );
    expect(stableNamePrefix('Thor Hammer R 1 299,00')).toBe('Thor Hammer');
    expect(stableNamePrefix('Add to cart')).toBeUndefined();
    expect(stableNamePrefix('$9.99')).toBeUndefined();
  });
});

describe('counters in names', () => {
  it('drops a trailing "N of M" counter and what joins it', () => {
    expect(withoutCounter('Next page : 2 of 1,395')).toBe('Next page');
    expect(withoutCounter('Photo (3 of 12)')).toBe('Photo');
    expect(withoutCounter('Step 2 / 5')).toBe('Step');
    expect(withoutCounter('Slide 10 of 10 - Summer sale')).toBeUndefined(); // not at the end
    expect(withoutCounter('2 of 5')).toBeUndefined(); // nothing left
    expect(withoutCounter('Order 1002')).toBeUndefined(); // a record number is not a counter
    expect(withoutCounter('Add to cart')).toBeUndefined();
  });
});

describe('keyboard-shortcut hints in names', () => {
  it('drops a trailing shortcut hint, on any platform', async () => {
    const { withoutShortcutHint } = await import('../src/locators/volatile.js');
    expect(withoutShortcutHint('Search Ctrl K')).toBe('Search');
    expect(withoutShortcutHint('Search ⌘ K')).toBe('Search');
    expect(withoutShortcutHint('Command palette Ctrl+Shift+P')).toBe('Command palette');
    expect(withoutShortcutHint('Search')).toBeUndefined();
    expect(withoutShortcutHint('Shift schedule')).toBeUndefined();
  });
});
