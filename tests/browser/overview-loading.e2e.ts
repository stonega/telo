import { expect, type Page, type Route, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const overviewEndpoint = `/api/admin/workspaces/${workspaceId}/overview`;
const settingsEndpoint = `/api/admin/workspaces/${workspaceId}/settings`;

async function overviewFixture(page: Page, operator = true) {
  const held: Route[] = [];
  const data = {
    version: 3,
    settings: settingsSchema.parse({
      name: "Overview fixture",
      timezone: "Asia/Taipei",
    }),
    counts: {
      members: 8,
      runs: 12,
      threads: 4,
      workflows: 2,
      ...(operator ? { codingTasks: 4 } : {}),
    },
    ...(operator
      ? {
          connections: {
            bot: { configured: true, username: "fixture_bot" },
            github: {
              connected: true,
              account: "fixture-org",
              repositories: 3,
            },
          },
        }
      : {}),
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === overviewEndpoint) {
      held.push(route);
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: {
                  id: "fixture",
                  username: "fixture",
                  operator,
                  ...(operator ? {} : { telegramId: "123" }),
                },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: data.settings.name }]
              : {},
    });
  });
  await page.goto(`/admin/overview?workspace=${workspaceId}`);
  await expect.poll(() => held.length).toBe(1);
  return { held, data };
}

async function settingsFixture(page: Page, holdSaves = false) {
  const loads: Route[] = [];
  const saves: Route[] = [];
  const data = {
    version: 3,
    settings: settingsSchema.parse({
      name: "Settings fixture",
      timezone: "Asia/Taipei",
    }),
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === settingsEndpoint) {
      if (route.request().method() === "PUT") {
        if (holdSaves) {
          saves.push(route);
          return;
        }
        data.settings = route.request().postDataJSON().settings;
        data.version++;
        await route.fulfill({ json: data });
        return;
      }
      loads.push(route);
      return;
    }
    await route.fulfill({
      json:
        path === "/api/setup/status"
          ? { initialized: true }
          : path === "/api/admin/auth/session"
            ? {
                admin: { id: "fixture", username: "fixture", operator: true },
                csrf: "test",
              }
            : path === "/api/admin/workspaces"
              ? [{ id: workspaceId, name: data.settings.name }]
              : {},
    });
  });
  await page.goto(`/admin/settings?workspace=${workspaceId}`);
  await expect.poll(() => loads.length).toBe(1);
  return { loads, saves, data };
}

for (const width of [1280, 390]) {
  test(`Team budgets support None, explicit values and zero without model-call settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { loads, saves, data } = await settingsFixture(page, true);
    const team = page.getByRole("region", { name: "Team", exact: true });
    await expect(
      team.getByText("Model calls per run", { exact: true }),
    ).toHaveCount(0);
    await loads.shift()?.fulfill({ json: data });
    const runRow = team
      .getByRole("listitem")
      .filter({ hasText: "Run budget (USD)" });
    const monthRow = team
      .getByRole("listitem")
      .filter({ hasText: "Monthly budget (USD)" });
    await expect(runRow).toContainText("None");
    await expect(monthRow).toContainText("None");
    await expect(team.locator("input,form")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("budgets-summary-none.png"),
      fullPage: true,
    });
    const edit = page.getByRole("button", { name: "Edit team configuration" });
    await edit.click();
    const dialog = page.getByRole("dialog", {
      name: "Edit team configuration",
    });
    const run = dialog.getByLabel("Run budget (USD)");
    const month = dialog.getByLabel("Monthly budget (USD)");
    await expect(
      dialog.getByLabel("Model calls per run", { exact: true }),
    ).toHaveCount(0);
    await expect(run).toHaveValue("");
    await expect(run).toHaveAttribute("placeholder", "None");
    await expect(month).toHaveValue("");
    await run.fill("100");
    await month.fill("1000");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(runRow).toContainText("None");
    await edit.click();
    await expect(run).toHaveValue("");
    await run.fill("0");
    await month.fill("1000");
    const save = dialog.getByRole("button", { name: "Save configuration" });
    await save.click();
    await expect.poll(() => saves.length).toBe(1);
    await expect(
      dialog.getByRole("button", { name: "Working…" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const pending = saves.shift();
    expect(pending?.request().postDataJSON().settings).toMatchObject({
      runBudgetUsd: 0,
      monthlyBudgetUsd: 1000,
    });
    expect(pending?.request().postDataJSON().settings).not.toHaveProperty(
      "maxTurns",
    );
    await page.screenshot({
      path: test.info().outputPath("budgets-editor-pending.png"),
      fullPage: true,
    });
    await pending?.fulfill({
      status: 503,
      json: { error: "fixture_save_failed" },
    });
    await expect(dialog.getByRole("alert")).toContainText(
      "fixture_save_failed",
    );
    await expect(run).toHaveValue("0");
    await expect(month).toHaveValue("1000");
    await save.scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("alert")).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("budgets-editor-error.png"),
      fullPage: true,
    });
    await month.fill("");
    await save.click();
    await expect.poll(() => saves.length).toBe(1);
    const successful = saves.shift();
    data.settings = successful?.request().postDataJSON().settings;
    data.version++;
    await successful?.fulfill({ json: data });
    await expect(dialog).toHaveCount(0);
    await expect(runRow).toContainText("$0");
    await expect(monthRow).toContainText("None");
    await expect.poll(() => loads.length).toBe(1);
    await loads.shift()?.fulfill({ json: data });
    await edit.click();
    await expect(run).toHaveValue("0");
    await run.fill("");
    await save.click();
    await expect.poll(() => saves.length).toBe(1);
    const cleared = saves.shift();
    data.settings = cleared?.request().postDataJSON().settings;
    expect(data.settings.runBudgetUsd).toBeNull();
    expect(data.settings.monthlyBudgetUsd).toBeNull();
    data.version++;
    await cleared?.fulfill({ json: data });
    await expect(dialog).toHaveCount(0);
    await expect(runRow).toContainText("None");
    await expect(monthRow).toContainText("None");
    await expect(team.locator("input,form")).toHaveCount(0);
    await expect(
      team.getByText("Model calls per run", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await expect.poll(() => loads.length).toBe(1);
    await loads.shift()?.fulfill({ json: data });
    await edit.click();
    await run.fill("10");
    await save.click();
    await expect.poll(() => saves.length).toBe(1);
    await saves
      .shift()
      ?.fulfill({ status: 409, json: { error: "version_conflict" } });
    await expect(dialog.getByRole("alert")).toContainText("version_conflict");
    await expect(run).toHaveValue("10");
    await dialog
      .getByRole("button", { name: "Reload current version" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => loads.length).toBe(1);
    await loads.shift()?.fulfill({ json: data });
    await expect(runRow).toContainText("None");
  });

  test(`Overview keeps its own layout while loading without team configuration at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const { held, data } = await overviewFixture(page);
    await expect(
      page.getByRole("heading", { name: "Your team, in view" }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Team", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Edit team configuration" }),
    ).toHaveCount(0);
    const counts = page.getByRole("region", { name: "Workspace counts" });
    await expect(counts.getByRole("link")).toHaveCount(4);
    for (const name of ["Workspace counts", "Telegram bot", "GitHub"]) {
      const section = page.getByRole("region", { name, exact: true });
      await expect(section).toBeVisible();
      await expect(section).toHaveAttribute("aria-busy", "true");
      await expect(section.locator(".skeleton").first()).toBeVisible();
    }
    for (const label of ["Manage bot", "Manage GitHub"])
      await expect(page.getByRole("button", { name: label })).toBeDisabled();
    await expect(
      page.getByText(/Not configured|Not connected|Connect a Telegram bot/),
    ).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    await page.screenshot({
      path: test.info().outputPath("overview-pending.png"),
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(counts.locator(".skeleton").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    await held.shift()?.fulfill({ json: data });
    await expect(counts).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("main .skeleton")).toHaveCount(0);
    await expect(
      counts.getByRole("link", { name: "8 members. View details" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Team", exact: true }),
    ).toHaveCount(0);
    for (const label of ["Manage bot", "Manage GitHub"])
      await expect(page.getByRole("button", { name: label })).toBeEnabled();
    await page.screenshot({
      path: test.info().outputPath("overview-loaded.png"),
      fullPage: true,
    });
  });

  for (const theme of ["light", "dark"]) {
    test(`Settings team card keeps layout, spacing and recovery at ${width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("telo.theme", value),
        theme,
      );
      const { loads, data } = await settingsFixture(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const team = page.getByRole("region", { name: "Team", exact: true });
      const edit = team.getByRole("button", {
        name: "Edit team configuration",
      });
      const checkTeamCardLayout = async () => {
        const bounds = await team.boundingBox();
        const editBounds = await edit.boundingBox();
        const listBounds = await team.locator(".settings-list").boundingBox();
        const inset = await team.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            top:
              Number.parseFloat(style.paddingTop) +
              Number.parseFloat(style.borderTopWidth),
            right:
              Number.parseFloat(style.paddingRight) +
              Number.parseFloat(style.borderRightWidth),
            bottom:
              Number.parseFloat(style.paddingBottom) +
              Number.parseFloat(style.borderBottomWidth),
          };
        });
        if (!bounds || !editBounds || !listBounds)
          throw Error("Team card must be visible");
        expect(
          Math.abs(
            bounds.x +
              bounds.width -
              editBounds.x -
              editBounds.width -
              inset.right,
          ),
        ).toBeLessThan(2);
        expect(Math.abs(editBounds.y - bounds.y - inset.top)).toBeLessThan(2);
        expect(
          Math.abs(
            bounds.y +
              bounds.height -
              listBounds.y -
              listBounds.height -
              inset.bottom,
          ),
        ).toBeLessThan(2);
      };
      await expect(team).toHaveAttribute("aria-busy", "true");
      await expect(team.locator(".skeleton").first()).toBeVisible();
      await expect(edit).toBeDisabled();
      await expect(
        team.getByText("Workspace name", { exact: true }),
      ).toBeVisible();
      await expect(team.getByText("Timezone", { exact: true })).toBeVisible();
      await checkTeamCardLayout();
      await loads.shift()?.fulfill({
        status: 503,
        json: { error: "settings_unavailable" },
      });
      await expect(team).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("main .skeleton")).toHaveCount(0);
      await expect(team).toContainText("Unavailable");
      await expect(edit).toBeDisabled();
      await checkTeamCardLayout();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => loads.length).toBe(1);
      await loads.shift()?.fulfill({ json: data });
      await expect(team).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("main .skeleton")).toHaveCount(0);
      await expect(
        team.getByRole("heading", { name: "Settings fixture" }),
      ).toBeVisible();
      await expect(edit).toBeEnabled();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await checkTeamCardLayout();
      const cards = await page
        .locator("main > section.card")
        .evaluateAll((elements) =>
          elements.map((el) => el.getAttribute("aria-label")),
        );
      expect(cards).toEqual(["Team", "Team currency", "Workspace activity"]);
      await page.screenshot({
        path: test.info().outputPath(`settings-loaded-${theme}.png`),
        fullPage: true,
      });
    });
  }
}

test("Overview hides deployment controls for a workspace administrator while loading", async ({
  page,
}) => {
  const { held, data } = await overviewFixture(page, false);
  const counts = page.getByRole("region", { name: "Workspace counts" });
  await expect(counts.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Connections" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage bot" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage GitHub" })).toHaveCount(
    0,
  );
  await held.shift()?.fulfill({ json: data });
  await expect(counts).toHaveAttribute("aria-busy", "false");
  await expect(counts.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("region", { name: "Connections" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("region", { name: "Team", exact: true }),
  ).toHaveCount(0);
});

test("Overview ends skeletons on failure and retries without showing audit history", async ({
  page,
}) => {
  const { held, data } = await overviewFixture(page);
  await held.shift()?.fulfill({
    status: 503,
    json: { error: "overview_unavailable" },
  });
  await expect(page.getByRole("alert")).toContainText("overview_unavailable");
  await expect(page.locator("main .skeleton")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  const counts = page.getByRole("region", { name: "Workspace counts" });
  await expect(counts).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Manage bot" })).toBeDisabled();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(counts).toHaveAttribute("aria-busy", "true");
  await held.shift()?.fulfill({ json: data });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage bot" })).toBeEnabled();
});

test("Settings preserves saved team values during the refresh after editing", async ({
  page,
}) => {
  const { loads, data } = await settingsFixture(page);
  await loads.shift()?.fulfill({ json: data });
  await page.getByRole("button", { name: "Edit team configuration" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit team configuration" });
  await dialog
    .getByLabel("Workspace name", { exact: true })
    .fill("Updated team");
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => loads.length).toBe(1);
  const team = page.getByRole("region", { name: "Team", exact: true });
  await expect(team).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("heading", { name: "Updated team" }),
  ).toBeVisible();
  await expect(page.locator("main .skeleton")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit team configuration" }),
  ).toBeDisabled();
  await loads.shift()?.fulfill({ json: data });
  await expect(team).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByRole("button", { name: "Edit team configuration" }),
  ).toBeEnabled();
});
