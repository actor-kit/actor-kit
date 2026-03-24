import { expect, test } from "@playwright/test";

test.describe("Todo List Example", () => {
  test("page loads with title", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Todo List");
  });

  test("owner can add a todo", async ({ page }) => {
    const listId = "e2e-add-" + Date.now();
    await page.goto("/?list=" + listId + "&user=alice");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await expect(page.locator("#role-info")).toHaveText("Role: owner", { timeout: 5000 });

    // Add a todo
    await page.locator("#todo-input").fill("Buy milk");
    await page.locator("#add-btn").click();

    // Should appear in the list
    await expect(page.locator(".todo span")).toHaveText("Buy milk", { timeout: 3000 });
  });

  test("owner can toggle a todo", async ({ page }) => {
    const listId = "e2e-toggle-" + Date.now();
    await page.goto("/?list=" + listId + "&user=alice");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });

    await page.locator("#todo-input").fill("Walk dog");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toBeVisible({ timeout: 3000 });

    // Toggle it
    await page.locator(".todo input[type='checkbox']").click();
    await expect(page.locator(".todo.done")).toBeVisible({ timeout: 3000 });
  });

  test("owner can delete a todo", async ({ page }) => {
    const listId = "e2e-delete-" + Date.now();
    await page.goto("/?list=" + listId + "&user=alice");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });

    await page.locator("#todo-input").fill("Temporary");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toBeVisible({ timeout: 3000 });

    // Delete it
    await page.locator(".todo button").click();
    await expect(page.locator(".todo")).not.toBeVisible({ timeout: 3000 });
  });

  test("viewer sees counts, not todos", async ({ page }) => {
    const listId = "e2e-viewer-" + Date.now();

    // First, create the list as owner and add a todo
    await page.goto("/?list=" + listId + "&user=alice");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });
    await page.locator("#todo-input").fill("A todo");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toBeVisible({ timeout: 3000 });

    // Now open as a different user (viewer)
    const viewerPage = await page.context().newPage();
    await viewerPage.goto("/?list=" + listId + "&user=bob");
    await expect(viewerPage.locator("#status")).toContainText("Connected", { timeout: 5000 });

    // Viewer should see role info
    await expect(viewerPage.locator("#role-info")).toHaveText("Role: viewer");

    // Viewer sees counts, not individual todos
    await expect(viewerPage.locator("#viewer-info")).toContainText("1 todos", { timeout: 3000 });

    // Viewer should not see the add form
    await expect(viewerPage.locator("#add-form")).not.toBeVisible();

    await viewerPage.close();
  });

  test("multiple todos persist across page reload", async ({ page }) => {
    const listId = "e2e-persist-" + Date.now();
    await page.goto("/?list=" + listId + "&user=alice");
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });

    // Add two todos
    await page.locator("#todo-input").fill("First");
    await page.locator("#add-btn").click();
    await page.locator("#todo-input").fill("Second");
    await page.locator("#add-btn").click();
    await expect(page.locator(".todo")).toHaveCount(2, { timeout: 3000 });

    // Reload
    await page.reload();
    await expect(page.locator("#status")).toContainText("Connected", { timeout: 5000 });

    // Todos should still be there
    await expect(page.locator(".todo")).toHaveCount(2, { timeout: 3000 });
  });
});
