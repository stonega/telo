import { expect, type Page, test } from "@playwright/test";
import { settingsSchema } from "../../src/domain.ts";
import type { GitHubPage } from "../../src/github/config.ts";

const workspaceId = "d2ce2eab-3b09-4e8e-858e-75c20d832517";
const endpoint = `/api/admin/workspaces/${workspaceId}/github`;

async function fixture(page: Page) {
  const data: GitHubPage = {
    configured: true,
    revision: 1,
    pending: false,
    installations: [],
    connection: {
      revision: 1,
      installationId: 501,
      account: "example",
      connectedBy: "fixture",
      repositories: Array.from({ length: 7 }, (_, i) => ({
        id: i + 1,
        full_name: `example/repository-${i + 1}`,
      })),
    },
  };
  const state = {
    calls: 0,
    syncCalls: 0,
    lastSyncBody: undefined as Record<string, unknown> | undefined,
    ruleCalls: 0,
    lastRuleBody: undefined as Record<string, unknown> | undefined,
    unavailable: false,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      path.startsWith(`${endpoint}/repositories/`) &&
      path.endsWith("/rules") &&
      route.request().method() === "PUT"
    ) {
      state.ruleCalls++;
      const repoId = Number(path.split("/").at(-2));
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.lastRuleBody = body;
      const rule = (body.rule ?? {}) as Record<string, unknown>;
      data.repositoryRules = {
        ...(data.repositoryRules ?? {}),
        [String(repoId)]: {
          enabled: body.mode !== "disabled",
          hasOverride: body.mode !== "inherit",
          autoReview: Boolean(rule.autoReview ?? true),
          allowAutoClose: Boolean(rule.allowAutoClose ?? false),
          acceptRequests: Boolean(rule.acceptRequests ?? true),
          allowFixes: Boolean(rule.allowFixes ?? false),
          prTriggerAuthors:
            (rule.prTriggerAuthors as
              | "all"
              | "collaborators"
              | "maintainers") ?? "all",
          prInstructions: rule.prInstructions as string | undefined,
          issueAutoReply: Boolean(rule.issueAutoReply ?? false),
          issueAutoFix: Boolean(rule.issueAutoFix ?? false),
          issueAllowAutoClose: Boolean(rule.issueAllowAutoClose ?? false),
          issueAcceptRequests: Boolean(rule.issueAcceptRequests ?? false),
          issueTriggerAuthors:
            (rule.issueTriggerAuthors as
              | "all"
              | "collaborators"
              | "maintainers") ?? "all",
          issueTriggerLabels: (rule.issueTriggerLabels as string[]) ?? [],
          issueInstructions: rule.issueInstructions as string | undefined,
          instructions: rule.instructions as string | undefined,
        },
      };
      if (body.notificationAction === "subscribe") {
        data.subscriptions = [
          {
            id: "sub-1",
            actor: "101",
            repositoryId: repoId,
            repository: `example/repository-${repoId}`,
            installationId: 501,
            connectionRevision: 1,
            botId: "900",
            events: (body.notificationEvents as (
              | "pull_request"
              | "issues"
            )[]) ?? ["pull_request", "issues"],
            enabled: true,
            revision: 1,
            since: new Date().toISOString(),
          },
        ];
      }
      await route.fulfill({ json: data });
      return;
    }
    if (path === `${endpoint}/sync` && route.request().method() === "POST") {
      state.syncCalls++;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.lastSyncBody = body;
      if (state.unavailable) {
        await route.fulfill({
          status: 502,
          json: { error: "github_unavailable" },
        });
        return;
      }
      if (data.connection) {
        const before = data.connection.repositories.length;
        if (typeof body.allRepositories === "boolean") {
          if (body.allRepositories) data.connection.allRepositories = true;
          else delete data.connection.allRepositories;
        }
        let added = 0;
        if (
          data.connection.allRepositories &&
          !data.connection.repositories.some((r) => r.id === 8)
        ) {
          data.connection.repositories = [
            ...data.connection.repositories,
            { id: 8, full_name: "example/new-auto-repo" },
          ];
          added = 1;
        }
        data.connection.revision++;
        data.revision = data.connection.revision;
        await route.fulfill({
          json: {
            ...data,
            syncResult: {
              changed: added > 0 || typeof body.allRepositories === "boolean",
              total: data.connection.repositories.length,
              added,
              removed: 0,
              addedNames: added ? ["example/new-auto-repo"] : [],
              allRepositories: !!data.connection.allRepositories,
            },
          },
        });
        void before;
        return;
      }
    }
    if (path === endpoint) {
      state.calls++;
      if (state.unavailable) {
        await route.fulfill({
          status: 503,
          json: { error: "github_unavailable" },
        });
        return;
      }
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
              ? [{ id: workspaceId, name: "Repository sync fixture" }]
              : path === endpoint
                ? data
                : path.endsWith("/overview")
                  ? {
                      version: 1,
                      settings: settingsSchema.parse({
                        name: "Repository sync fixture",
                        timezone: "Asia/Taipei",
                      }),
                      counts: {
                        members: 1,
                        runs: 0,
                        workflows: 0,
                        codingTasks: 0,
                      },
                      connections: {
                        bot: { configured: false },
                        github: {
                          connected: true,
                          account: "example",
                          repositories: 7,
                        },
                      },
                    }
                  : {},
    });
  });
  await page.goto(`/admin/overview?workspace=${workspaceId}`);
  expect(state.calls).toBe(0);
  await page.getByRole("button", { name: "Manage GitHub" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage GitHub" });
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-1 on GitHub" }),
  ).toBeVisible();
  return { dialog, data, state };
}

test("GitHub list polls while open, preserves expansion and updates renamed links", async ({
  page,
}) => {
  const { dialog, data, state } = await fixture(page);
  await dialog.getByRole("button", { name: "2 more" }).click();
  if (data.connection) {
    data.connection.repositories = data.connection.repositories.map((repo) =>
      repo.id === 1 ? { ...repo, full_name: "example/renamed" } : repo,
    );
    data.connection.repositories = data.connection.repositories.slice(0, 6);
  }
  const link = dialog.getByRole("link", {
    name: "Open example/renamed on GitHub",
  });
  await expect(link).toBeVisible({ timeout: 10000 });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/example/renamed",
  );
  await expect(dialog.getByRole("button", { name: "Show less" })).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-6 on GitHub" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-7 on GitHub" }),
  ).toHaveCount(0);
  await expect(dialog.locator(".skeleton")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  const calls = state.calls;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(state.calls).toBe(calls);
});

test("returning from GitHub refreshes and transient failures keep the saved list", async ({
  page,
}) => {
  const { dialog, data, state } = await fixture(page);
  state.unavailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("alert")).toContainText(
    "GitHub is unavailable",
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/repository-1 on GitHub" }),
  ).toBeVisible();
  state.unavailable = false;
  if (data.connection)
    data.connection.repositories = data.connection.repositories.map((repo) =>
      repo.id === 1 ? { ...repo, full_name: "example/renamed" } : repo,
    );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/renamed on GitHub" }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  data.refreshError = "github_access_denied";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("status")).toContainText(
    "Showing the last saved list",
  );
  await expect(
    dialog.getByRole("link", { name: "Open example/renamed on GitHub" }),
  ).toBeVisible();
});

test("operator can enable all-repository auto-sync and manually sync from Manage GitHub at desktop and mobile widths", async ({
  page,
}) => {
  const { dialog, state } = await fixture(page);
  await expect(dialog).toContainText("Selected repositories");
  await expect(dialog.locator(".github-repositories-count")).toHaveText(
    "7 repositories",
  );
  await expect(
    dialog.getByRole("button", { name: "Sync repositories" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Auto-sync all repositories" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Change repositories" }),
  ).toBeVisible();

  // Enable all-repository auto-sync and verify new repo appears immediately.
  await dialog
    .getByRole("button", { name: "Auto-sync all repositories" })
    .click();
  expect(state.syncCalls).toBe(1);
  expect(state.lastSyncBody).toEqual({ revision: 1, allRepositories: true });
  await expect(dialog).toContainText("All repositories (auto-sync)");
  await expect(dialog.locator(".github-repositories-count")).toHaveText(
    "8 repositories",
  );
  await expect(dialog.getByRole("status")).toContainText(
    "All-repository auto-sync enabled. 8 repositories connected (1 added).",
  );
  await expect(
    dialog.getByRole("button", { name: "Use selected only" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "3 more" }).click();
  await expect(
    dialog.getByRole("link", { name: "Open example/new-auto-repo on GitHub" }),
  ).toBeVisible();

  // Manual Sync repositories reports up-to-date status.
  await dialog.getByRole("button", { name: "Sync repositories" }).click();
  expect(state.syncCalls).toBe(2);
  expect(state.lastSyncBody).toEqual({ revision: 2 });
  await expect(dialog.getByRole("status")).toContainText(
    "Repositories are up to date (8 connected).",
  );

  // Desktop and mobile layout verification (light + dark, alignment, zero empty wrappers or overflow).
  await page.setViewportSize({ width: 1280, height: 720 });
  const desktopMetrics = await dialog.evaluate((element) => {
    const emptyRows = Array.from(element.querySelectorAll(".row")).filter(
      (row) => row.children.length === 0,
    ).length;
    const lastCard = element
      .querySelectorAll(".repository-card-compact")
      .item(element.querySelectorAll(".repository-card-compact").length - 1);
    const toggle = element.querySelector(".github-repository-more");
    if (!lastCard || !toggle) throw new Error("Missing repo list controls");
    const cardRect = lastCard.getBoundingClientRect();
    const toggleRect = toggle.getBoundingClientRect();
    return {
      emptyRows,
      heightDelta: Math.abs(cardRect.height - toggleRect.height),
      centerDelta: Math.abs(
        cardRect.top +
          cardRect.height / 2 -
          (toggleRect.top + toggleRect.height / 2),
      ),
      overflow: element.scrollWidth > element.clientWidth,
    };
  });
  expect(desktopMetrics.emptyRows).toBe(0);
  expect(desktopMetrics.heightDelta).toBeLessThanOrEqual(2);
  expect(desktopMetrics.centerDelta).toBeLessThanOrEqual(2);
  expect(desktopMetrics.overflow).toBe(false);
  const screenshotDir = process.env.BROWSER_SCREENSHOT_DIR ?? "test-results";
  await page.screenshot({
    path: `${screenshotDir}/github-sync-desktop-light.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  const mobileMetrics = await dialog.evaluate((element) => {
    const list = element.querySelector(".repository-list");
    const cards = Array.from(element.querySelectorAll(".repository-card"));
    const toggle = element.querySelector(".github-repository-more");
    if (!list || !cards.length || !toggle)
      throw new Error("Missing mobile repository list");
    const listWidth = list.getBoundingClientRect().width;
    return {
      cardsFullWidth: cards.every(
        (card) => Math.abs(card.getBoundingClientRect().width - listWidth) <= 2,
      ),
      toggleFullWidth:
        Math.abs(toggle.getBoundingClientRect().width - listWidth) <= 2,
    };
  });
  expect(mobileMetrics).toEqual({
    cardsFullWidth: true,
    toggleFullWidth: true,
  });
  await page.screenshot({
    path: `${screenshotDir}/github-sync-mobile-light.png`,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({
    path: `${screenshotDir}/github-sync-mobile-dark.png`,
  });
});

test("Manage GitHub opens per-repository automation rules and notification modal and shows saved summary without inline forms", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { dialog, state } = await fixture(page);
  await dialog
    .getByRole("button", { name: "Configure example/repository-1" })
    .click();
  const ruleDialog = page.getByRole("dialog", {
    name: "Configure example/repository-1",
  });
  await expect(ruleDialog).toBeVisible();
  await ruleDialog.getByLabel("Automation mode").click();
  await page
    .getByRole("option", { name: "Custom repository rules", exact: true })
    .click();
  await ruleDialog
    .getByLabel("Allow automatic PR closing when rules match")
    .check();
  await ruleDialog
    .getByLabel("PR natural-language rules (optional)")
    .fill("Close PRs without a linked issue.");
  await ruleDialog
    .getByLabel("Automatically analyze and reply to new issues")
    .check();
  await ruleDialog
    .getByLabel("Automatically fix issues and open a pull request")
    .check();
  await ruleDialog
    .getByLabel("Issue natural-language rules (optional)")
    .fill("Reply in Chinese and auto-fix reproducible bugs.");
  await ruleDialog.getByLabel("Personal Telegram notifications").click();
  await page
    .getByRole("option", { name: "Subscribe to notifications", exact: true })
    .click();
  await ruleDialog.getByRole("button", { name: "Save rules" }).click();
  await expect(ruleDialog).toHaveCount(0);
  expect(state.ruleCalls).toBe(1);
  expect(state.lastRuleBody).toMatchObject({
    mode: "custom",
    notificationAction: "subscribe",
    rule: {
      autoReview: true,
      allowAutoClose: true,
      prInstructions: "Close PRs without a linked issue.",
      issueAutoReply: true,
      issueAutoFix: true,
      issueInstructions: "Reply in Chinese and auto-fix reproducible bugs.",
    },
  });
  const card = dialog
    .getByRole("article", { name: "example/repository-1" })
    .first();
  await expect(card).toContainText("PR: auto-review, auto-close");
  await expect(card).toContainText("Issue: auto-reply, auto-fix");
  await expect(card).toContainText("Natural-language rules");
  await expect(card).toContainText("Notifications: PRs & issues");
  await expect(card.locator("input,select,textarea,form")).toHaveCount(0);
});
