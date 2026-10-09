# SauceDemo usability scenarios

The Phase 1 scenario list for the first public target ([docs/10](../../../docs/10-implementation-plan.md) Phase 1).
Each one is written the way a tester would write it, as plain English steps. In Phase 2 they become `@llm`-tagged
specs in `examples/tests/saucedemo/`, and the write-up notes which steps worked as written and which needed more detail.

✅ = also covered by the plain-Playwright smoke spec ([smoke.spec.ts](../../tests/saucedemo/smoke.spec.ts)).

| # | Scenario | Exercises |
|---|---|---|
| 1 ✅ | **Log in.** Log in as the standard user. Assert the product list is visible. | Form fill with a `{{secret}}`, navigation |
| 2 ✅ | **Locked-out user.** Log in as the locked-out user. Assert an error says the user is locked out. | `assert` on an error message, negative path |
| 3 | **Menu navigation.** Open the menu and go to "All Items". Then open the menu again and close it without choosing anything. | Hamburger/flyout menu, icon button with a label |
| 4 | **Sort.** Sort the products by price, low to high. Extract the list of prices and check that they're ascending (code `expect`). | Native `<select>`, `extract` with `z.array(z.number())` |
| 5 | **Product detail.** Open the "Sauce Labs Bolt T-Shirt". Assert the price is $15.99. Go back to the products. | Link inside a repeated list item (anchored locators) |
| 6 ✅ | **Add to cart.** Add the backpack and the bike light to the cart. Assert the cart badge shows 2. | Repeated "Add to cart" buttons (ambiguity resolved by product name) |
| 7 | **Cart read.** Open the cart. Extract the item names and quantities as a table. Remove the bike light. Assert one item is left. | `extract` with `z.array(z.object(...))`, row actions |
| 8 | **Checkout validation.** Start checkout and click Continue with the form empty. Assert the error says first name is required. Fill in only the first name, then assert the error asks for the last name. | Client-side validation, multiple `assert`s |
| 9 ✅ | **Checkout.** Fill in first name, last name and a postal code (`{{data.*}}`). Continue and finish. Assert "Thank you for your order!" is shown. | `fill_form`, success message |
| 10 | **Totals.** On the checkout overview, extract the item total, tax and total. Check in code that item total + tax = total. | `extract` of currency values, `z.object` |
| 11 | **Reset app state.** With items in the cart, choose "Reset App State" from the menu. Assert the cart badge is gone. | Menu item that is hidden until the menu opens |
| 12 | **Log out.** Log out from the menu. Assert the login form is shown. | Menu → logout, navigation back to `/` |

## Known quirks (hints for Phase 2)

- SauceDemo is a React SPA. The URL changes before the next view renders, so wait for the next view's content,
  not the URL (spike 0.1).
- Product images load late and change the AI snapshot for a few hundred ms after the page appears (spike 0.1).
  Observer settling has to cover that.
- The cart lives in `localStorage`. Every test needs a fresh browser context (Playwright Test gives you one per test).
- `problem_user`, `error_user` and `visual_user` have deliberately broken behaviour. They're useful later for
  `assert` false-pass checks (risk R6).
