import { expect, test } from "@playwright/test";

test("tanstack start todo flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New List" }).click();
  await page.getByPlaceholder("Add a new todo").fill("Learn Actor Kit");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Learn Actor Kit")).toBeVisible();
});
