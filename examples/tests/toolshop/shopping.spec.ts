// Toolshop: cart and checkout. Real AI calls (tagged @llm): npx playwright test --project toolshop --headed
// The checkout uses the shop's guest path with generated (valid, fictional) data, so no account is needed.
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test.describe('Toolshop shopping', { tag: '@llm' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('product-name').first()).toBeVisible();
  });

  test('add a quantity to the cart', async ({ page, ai }) => {
    await ai.act('Open "Combination Pliers", set the quantity to 3 and add it to the cart');
    await ai.assert('A message says the product was added to the cart');
    await expect(page.getByTestId('cart-quantity')).toHaveText('3');
  });

  test('edit the cart', async ({ page, ai }) => {
    await ai.act('Add "Combination Pliers" to the cart, go back to the shop and add "Bolt Cutters" too');
    await expect(page.getByTestId('cart-quantity')).toHaveText('2');
    await ai.act('Open the cart, change the quantity of the Bolt Cutters to 2, and remove the Combination Pliers');
    const cart = await ai.extract(
      'every cart line (product name, quantity, line total) and the cart total, as numbers',
      z.object({
        lines: z.array(z.object({ name: z.string(), quantity: z.number(), lineTotal: z.number() })),
        total: z.number(),
      }),
    );
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ name: 'Bolt Cutters', quantity: 2 });
    expect(cart.total).toBeCloseTo(cart.lines[0]!.lineTotal, 2);
  });

  test('guest checkout, paid cash on delivery', async ({ page, ai, gen }) => {
    test.setTimeout(10 * 60_000);
    const guest = gen.person('GB');
    const address = gen.address('GB');
    await ai.act('Add "Combination Pliers" and "Bolt Cutters" to the cart, then open the cart');
    const total = await ai.extract('the cart total, as a number', z.number());
    await ai.act('Proceed to checkout and continue as a guest', {
      data: { email: guest.email, firstName: guest.firstName, lastName: guest.lastName },
    });
    await ai.act('Fill in the billing address and proceed to payment', {
      data: {
        street: address.street,
        city: address.city,
        state: 'England',
        postalCode: address.postalCode,
        country: 'United Kingdom',
        houseNumber: '12',
      },
    });
    await ai.act('Choose "Cash on Delivery" as the payment method and confirm the order');
    await ai.assert('The order was placed: a success message or an invoice number is shown');
    expect(total).toBeGreaterThan(0);
    await expect(page.getByTestId('cart-quantity')).toHaveCount(0);
  });

  test('checkout validation: an empty billing address can’t continue', async ({ ai, gen }) => {
    const guest = gen.person('GB');
    await ai.act('Add "Combination Pliers" to the cart, open the cart and proceed to checkout as a guest', {
      data: { email: guest.email, firstName: guest.firstName, lastName: guest.lastName },
    });
    await ai.act('On the billing address step, clear the street and try to proceed');
    await ai.assert('The address step is still shown: it is not possible to continue to payment');
  });
});
