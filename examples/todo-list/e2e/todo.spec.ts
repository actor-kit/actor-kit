import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function createTodoList(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New Todo List" }).click();
  // Owner sees the add form on SSR
  await expect(page.locator("#add-form")).toBeVisible({ timeout: 10_000 });
  return page.url();
}

test.describe("Todo List — Owner", () => {
  test("home page loads", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Actor Kit Todo List" }),
    ).toBeVisible();
  });

  test("owner can add a todo", async ({ page }) => {
    await createTodoList(page);

    await page.locator("#todo-input").fill("Buy groceries");
    await page.locator("#add-btn").click();

    await expect(page.locator(".todo span").first()).toContainText(
      "Buy groceries",
      { timeout: 5_000 },
    );
  });

  test("owner can toggle a todo", async ({ page }) => {
    await createTodoList(page);

    await page.locator("#todo-input").fill("Toggle me");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toHaveCount(1, { timeout: 5_000 });

    // Toggle it done
    await page.locator('.todo input[type="checkbox"]').click();
    await expect(page.locator(".todo.done")).toHaveCount(1, { timeout: 5_000 });
  });

  test("owner can delete a todo", async ({ page }) => {
    await createTodoList(page);

    await page.locator("#todo-input").fill("Delete me");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toHaveCount(1, { timeout: 5_000 });

    await page.locator(".todo button").click();
    await expect(page.locator(".todo")).toHaveCount(0, { timeout: 5_000 });
  });

  test("todos persist across page reload", async ({ page }) => {
    const todoUrl = await createTodoList(page);

    await page.locator("#todo-input").fill("Persistent todo");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toHaveCount(1, { timeout: 5_000 });

    // Reload — SSR should show the todo
    await page.goto(todoUrl);
    await expect(page.locator(".todo span").first()).toContainText(
      "Persistent todo",
      { timeout: 10_000 },
    );
  });
});

test.describe("Todo List — Viewer", () => {
  test("viewer sees counts, not individual todos", async ({ browser }) => {
    // First context creates the list (becomes owner)
    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    const todoUrl = await createTodoList(ownerPage);

    // Owner adds a todo
    await ownerPage.locator("#todo-input").fill("Test todo");
    await ownerPage.locator("#add-btn").click();
    await expect(ownerPage.locator(".todo")).toHaveCount(1, { timeout: 5_000 });

    // Second context opens the same list (becomes viewer — different cookie)
    const viewerCtx = await browser.newContext();
    const viewerPage = await viewerCtx.newPage();
    await viewerPage.goto(todoUrl);

    // Viewer should see role info
    await expect(viewerPage.locator("#role-info")).toContainText("viewer", {
      timeout: 10_000,
    });

    // Viewer sees counts, not individual todos
    await expect(viewerPage.locator("#viewer-info")).toBeVisible({
      timeout: 5_000,
    });

    // Viewer should NOT see the add form
    await expect(viewerPage.locator("#add-form")).not.toBeVisible();

    await ownerCtx.close();
    await viewerCtx.close();
  });
});
