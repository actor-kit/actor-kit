import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Helper: navigate to a fresh list and wait for hydration
async function createList(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New List" }).click();
  // Wait for the input to become enabled (hydration complete + WebSocket connected)
  await expect(page.getByPlaceholder("Add a new todo")).toBeEnabled({
    timeout: 15_000,
  });
  return page.url();
}

// Helper: add a todo by text
async function addTodo(page: Page, text: string) {
  const input = page.getByPlaceholder("Add a new todo");
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.fill(text);
  await page.getByRole("button", { name: "Add" }).click();
  // Wait for the todo to appear via WebSocket patch
  await expect(
    page.locator("li").filter({ hasText: text })
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Todo CRUD", () => {
  test("create a todo", async ({ page }) => {
    await createList(page);
    await addTodo(page, "Buy groceries");
  });

  test("create multiple todos", async ({ page }) => {
    await createList(page);
    await addTodo(page, "First item");
    await addTodo(page, "Second item");
    await addTodo(page, "Third item");

    await expect(page.getByText("First item")).toBeVisible();
    await expect(page.getByText("Second item")).toBeVisible();
    await expect(page.getByText("Third item")).toBeVisible();
  });

  test("toggle a todo complete and undo", async ({ page }) => {
    await createList(page);
    await addTodo(page, "Toggle me");

    // Complete it
    await page.getByRole("button", { name: "Complete" }).click();

    // Wait for the state to update — "Undo" button proves the toggle took effect
    await expect(
      page.getByRole("button", { name: "Undo" })
    ).toBeVisible({ timeout: 10_000 });

    // Text should be struck through
    const todoText = page.getByText("Toggle me");
    await expect(todoText).toHaveCSS("text-decoration-line", "line-through");

    // Undo it
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(
      page.getByRole("button", { name: "Complete" })
    ).toBeVisible({ timeout: 10_000 });
    await expect(todoText).toHaveCSS("text-decoration-line", "none");
  });

  test("delete a todo", async ({ page }) => {
    await createList(page);
    await addTodo(page, "Delete me");
    await addTodo(page, "Keep me");

    // Delete the first one
    const deleteButton = page
      .locator("li")
      .filter({ hasText: "Delete me" })
      .getByRole("button", { name: "Delete" });
    await deleteButton.click();

    // "Delete me" gone, "Keep me" remains
    await expect(
      page.locator("li").filter({ hasText: "Delete me" })
    ).not.toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("li").filter({ hasText: "Keep me" })
    ).toBeVisible();
  });

  test("empty text is not submitted", async ({ page }) => {
    await createList(page);

    // Try to submit empty
    await page.getByRole("button", { name: "Add" }).click();

    // No list items should appear
    await expect(page.locator("li")).toHaveCount(0);
  });
});

test.describe("Persistence", () => {
  test("todos survive page reload", async ({ page }) => {
    const listUrl = await createList(page);
    await addTodo(page, "Persistent todo");
    await addTodo(page, "Another persistent");

    // Reload the page
    await page.goto(listUrl);
    await expect(page.getByPlaceholder("Add a new todo")).toBeEnabled({
      timeout: 15_000,
    });

    // Todos should still be there
    await expect(page.getByText("Persistent todo")).toBeVisible();
    await expect(page.getByText("Another persistent")).toBeVisible();
  });

  test("completed state persists across reload", async ({ page }) => {
    const listUrl = await createList(page);
    await addTodo(page, "Complete and reload");

    // Complete it
    await page.getByRole("button", { name: "Complete" }).click();
    await expect(
      page.getByRole("button", { name: "Undo" })
    ).toBeVisible({ timeout: 10_000 });

    // Reload
    await page.goto(listUrl);
    await expect(page.getByPlaceholder("Add a new todo")).toBeEnabled({
      timeout: 15_000,
    });

    // Should still be completed
    await expect(page.getByText("Complete and reload")).toHaveCSS(
      "text-decoration-line",
      "line-through"
    );
    await expect(
      page.getByRole("button", { name: "Undo" })
    ).toBeVisible();
  });

  test("deleted todos stay deleted after reload", async ({ page }) => {
    const listUrl = await createList(page);
    await addTodo(page, "To delete");
    await addTodo(page, "To keep");

    // Delete one
    await page
      .locator("li")
      .filter({ hasText: "To delete" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(
      page.locator("li").filter({ hasText: "To delete" })
    ).not.toBeVisible({ timeout: 10_000 });

    // Reload
    await page.goto(listUrl);
    await expect(page.getByPlaceholder("Add a new todo")).toBeEnabled({
      timeout: 15_000,
    });

    await expect(
      page.getByText("To delete", { exact: true })
    ).not.toBeVisible();
    await expect(
      page.getByText("To keep", { exact: true })
    ).toBeVisible();
  });
});

test.describe("Multi-client sync", () => {
  test("second client sees todos added by first client", async ({
    browser,
  }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Page 1 creates a list and adds a todo
    const listUrl = await createList(page1);
    await addTodo(page1, "Synced todo");

    // Page 2 opens the same list — sees the todo via SSR snapshot
    await page2.goto(listUrl);
    await expect(page2.getByText("Synced todo")).toBeVisible();

    await context1.close();
    await context2.close();
  });

  test("real-time sync: todo appears on second client without reload", async ({
    browser,
  }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Page 1 creates a list
    const listUrl = await createList(page1);

    // Page 2 opens the same list (both connected via WebSocket)
    await page2.goto(listUrl);
    await expect(page2.getByText("Todo List")).toBeVisible();

    // Page 1 adds a todo — page 2 should see it via WebSocket patch
    await addTodo(page1, "Live update");
    await expect(page2.getByText("Live update")).toBeVisible({
      timeout: 10_000,
    });

    await context1.close();
    await context2.close();
  });

  test("toggle syncs in real-time to second client", async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const listUrl = await createList(page1);
    await addTodo(page1, "Toggle sync test");

    // Page 2 opens same list
    await page2.goto(listUrl);
    await expect(page2.getByText("Toggle sync test")).toBeVisible({
      timeout: 10_000,
    });

    // Page 1 toggles complete
    await page1.getByRole("button", { name: "Complete" }).click();
    await expect(
      page1.getByRole("button", { name: "Undo" })
    ).toBeVisible({ timeout: 10_000 });

    // Page 2 should see the strikethrough via WebSocket sync
    await expect(page2.getByText("Toggle sync test")).toHaveCSS(
      "text-decoration-line",
      "line-through",
      { timeout: 10_000 }
    );

    await context1.close();
    await context2.close();
  });

  test("delete syncs in real-time to second client", async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    const listUrl = await createList(page1);
    await addTodo(page1, "Delete sync test");

    // Page 2 opens same list
    await page2.goto(listUrl);
    await expect(page2.getByText("Delete sync test")).toBeVisible({
      timeout: 10_000,
    });

    // Page 1 deletes
    await page1.getByRole("button", { name: "Delete" }).click();
    await expect(
      page1.getByText("Delete sync test")
    ).not.toBeVisible({ timeout: 10_000 });

    // Page 2 should see it disappear via WebSocket sync
    await expect(
      page2.getByText("Delete sync test")
    ).not.toBeVisible({ timeout: 10_000 });

    await context1.close();
    await context2.close();
  });
});

test.describe("Navigation", () => {
  test("each New List creates a unique list", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "New List" }).click();
    const firstUrl = page.url();

    await page.goto("/");
    await page.getByRole("button", { name: "New List" }).click();
    const secondUrl = page.url();

    expect(firstUrl).not.toEqual(secondUrl);
  });

  test("direct URL to list works", async ({ page }) => {
    const listUrl = await createList(page);
    await addTodo(page, "Direct URL todo");

    // Navigate away and back
    await page.goto("/");
    await page.goto(listUrl);

    await expect(page.getByText("Direct URL todo")).toBeVisible();
  });
});
