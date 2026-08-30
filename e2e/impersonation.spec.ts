import { expect, test, type Page } from "@playwright/test";

const DEV_EMAIL = "admin@solar.local";
const DEV_PASSWORD = "password";

async function signIn(page: Page) {
	await page.goto("/");
	await page.getByPlaceholder("Email").fill(DEV_EMAIL);
	await page.getByPlaceholder("Password (min 8)").fill(DEV_PASSWORD);
	await page.getByRole("button", { name: "Sign in" }).click();
}

async function openSettings(page: Page) {
	await page.locator(".avatar-placeholder").click();
	await page.getByRole("button", { name: "Admin settings" }).click();
}

test.describe("Admin Impersonation E2E", () => {
	test("admin can start and stop impersonating another user", async ({
		page,
	}) => {
		await signIn(page);

		// Open Admin Settings -> Users tab
		await openSettings(page);
		await page.getByRole("tab", { name: "users" }).click();

		// Add a standard test user to impersonate
		const testUserName = "Impersonated Standard User";
		const testUserEmail = "standard-user@solar.local";
		await page.getByPlaceholder("Name").fill(testUserName);
		await page.getByPlaceholder("Email").fill(testUserEmail);
		await page.getByPlaceholder("Password (min 8)").fill("password123");
		await page.getByRole("button", { name: "Add user" }).click();

		// Locate the row for this specific user in the users list
		const targetUserRow = page
			.locator("div.divide-y > div")
			.filter({ hasText: testUserEmail });

		const impersonateBtn = targetUserRow.getByRole("button", {
			name: "Impersonate",
		});
		await expect(impersonateBtn).toBeEnabled();

		// Click "Impersonate"
		await impersonateBtn.click();

		// Verify the ImpersonationBanner appears at the top of the app
		const bannerText = `Impersonating ${testUserName} (${testUserEmail})`;
		await expect(page.getByText(bannerText)).toBeVisible();

		// Verify "Return to admin" button exists on the banner
		const returnBtn = page.getByRole("button", { name: "Return to admin" });
		await expect(returnBtn).toBeVisible();

		// Verify user menu shows impersonated user's details and NO "Admin settings" button
		await page.locator(".avatar-placeholder").click();
		await expect(
			page
				.locator(".dropdown-content")
				.getByText(testUserName, { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Admin settings" }),
		).toBeHidden();

		// Dismiss dropdown by clicking outside
		await page.mouse.click(10, 10);

		// Click "Return to admin"
		await returnBtn.click();
		// Verify ImpersonationBanner disappears
		await expect(page.getByText(bannerText)).toBeHidden();

		// Verify user menu restores admin role and options
		await page.locator(".avatar-placeholder").click();
		await expect(
			page.getByRole("button", { name: "Admin settings" }),
		).toBeVisible();
	});

	test("disables impersonate button for disabled users and current admin user", async ({
		page,
	}) => {
		await signIn(page);

		await openSettings(page);
		await page.getByRole("tab", { name: "users" }).click();

		// Verify current logged-in admin user cannot impersonate self
		const adminUserRow = page
			.locator("div.divide-y > div")
			.filter({ hasText: DEV_EMAIL });
		await expect(
			adminUserRow.getByRole("button", { name: "Impersonate" }),
		).toBeDisabled();

		// Add a user and disable them
		const disabledName = "Disabled Test User";
		const disabledEmail = "disabled-user@solar.local";
		await page.getByPlaceholder("Name").fill(disabledName);
		await page.getByPlaceholder("Email").fill(disabledEmail);
		await page.getByPlaceholder("Password (min 8)").fill("password123");
		await page.getByRole("button", { name: "Add user" }).click();

		const disabledUserRow = page
			.locator("div.divide-y > div")
			.filter({ hasText: disabledEmail });
		await expect(disabledUserRow).toBeVisible();

		// Click "Disable"
		await disabledUserRow.getByRole("button", { name: "Disable" }).click();
		await expect(
			disabledUserRow.getByRole("button", { name: "Enable" }),
		).toBeVisible();

		// Verify Impersonate button is disabled for disabled user
		await expect(
			disabledUserRow.getByRole("button", { name: "Impersonate" }),
		).toBeDisabled();
	});
});
