import { expect, test } from "@playwright/test";

test("remix todo flow", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New List" }).click();
  await page.getByPlaceholder("Add a new todo").fill("Ship feature");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Ship feature")).toBeVisible();
});
