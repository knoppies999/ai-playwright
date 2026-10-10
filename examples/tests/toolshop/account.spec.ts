// Toolshop: accounts and the contact form. Real AI calls (tagged @llm): npx playwright test --project toolshop --headed
// Registration creates a new user with generated data every run. Its password is generated here at run time and
// reaches the browser only as a secret ({{secret.password}}), so it never appears in prompts, plans or reports.
import { expect, test } from '@aipw/test';
import { randomBytes } from 'node:crypto';
import { toolshop } from '../../targets/toolshop/target.js';

// Upper, lower, digit and symbol: the shop's password rules.
process.env[toolshop.secrets.password] ??= `Aipw-${randomBytes(6).toString('hex')}-Zq7!`;

test.use({ aiConfig: { secrets: { map: { password: toolshop.secrets.password } } } });

test.describe('Toolshop accounts', { tag: '@llm' }, () => {
  test('register, sign in and look around the account', async ({ page, ai, gen }) => {
    test.setTimeout(10 * 60_000);
    const person = gen.person('GB');
    const address = gen.address('GB');
    await page.goto('/auth/register');
    await ai.act('Fill in the registration form and register', {
      data: {
        firstName: person.firstName,
        lastName: person.lastName,
        dateOfBirth: person.dateOfBirth,
        country: 'United Kingdom',
        postalCode: address.postalCode,
        houseNumber: '12',
        street: address.street,
        city: address.city,
        state: 'England',
        phone: gen.phone('GB', { format: 'national' }).replace(/\D/g, ''),
        email: person.email,
      },
      secrets: ['password'],
    });
    await ai.assert('The sign-in page is shown, so the registration worked');
    await ai.act('Sign in with the new account', { data: { email: person.email }, secrets: ['password'] });
    await ai.assert(`The account page greets ${person.firstName} or shows "My account"`);
    await ai.act('Open my profile');
    await ai.assert(`The profile shows the first name ${person.firstName} and the last name ${person.lastName}`);
    await ai.act('Go to the shop, open "Combination Pliers" and add it to my favourites');
    await ai.act('Open my favourites from the account menu');
    await ai.assert('"Combination Pliers" is in my favourites');
    await ai.act('Sign out');
    await expect(page.getByTestId('nav-sign-in')).toBeVisible();
  });

  test('sign-in with a wrong password is refused', async ({ page, ai, gen }) => {
    await page.goto('/auth/login');
    // Not a secret: a deliberately wrong value.
    await ai.act('Sign in with this email and password', {
      data: { email: gen.email(), password: 'Not-The-Password-1!' },
    });
    await ai.assert('An error says the email or password is invalid');
    await expect(page.getByTestId('login-submit')).toBeVisible();
  });

  test('contact form: validation, then a sent message', async ({ page, ai, gen }) => {
    const person = gen.person('GB');
    await page.goto('/contact');
    await ai.act('Send the contact form without filling anything in');
    await ai.assert('Errors say which fields are required');
    await ai.act('Fill in the contact form about a warranty question and send it', {
      data: {
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        subject: 'Warranty',
        message:
          'My combination pliers came loose at the joint after a week of normal use. Is this covered by the warranty?',
      },
    });
    await ai.assert('A message thanks me and says the message was sent');
  });
});
