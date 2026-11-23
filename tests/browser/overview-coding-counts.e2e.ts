import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { hash } from "../../src/setup/credentials.ts";
import { developmentTask, teamWorkspace } from "../team-workflows-fixture.ts";

for (const width of [1280, 390]) {
  test(`Overview coding count opens the matching task list at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = JSON.parse(
      await readFile(join(tmpdir(), "telo-browser-3107-db.json"), "utf8"),
    );
    const pool = database(fixture.url);
    const store = new Store(pool);
    const operatorId = randomUUID();
    const raw = randomUUID();
    const w = teamWorkspace();
    w.operatorId = operatorId;
    const direct = developmentTask(w);
    direct.payload.title = "Direct task waiting for an answer";
    const completed = developmentTask(w);
    completed.payload.title = "Direct task ready for review";
    completed.state = "review";
    completed.question = undefined;
    const completedTask = {
      ...direct,
      id: randomUUID(),
      state: "review" as const,
      payload: { ...direct.payload, title: "Completed task" },
    };
    // Retained tasks remain visible without an active GitHub connection.
    w.github = undefined;
    try {
      await pool.query(
        "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,$2,'unused',true)",
        [operatorId, `counts-${operatorId}`],
      );
      await pool.query(
        "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [hash(raw), operatorId, randomUUID()],
      );
      await pool.query(
        "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
        [w.id, operatorId, JSON.stringify(w)],
      );
      await page.context().addCookies([
        {
          name: "telo_session",
          value: raw,
          url: "http://127.0.0.1:3107",
        },
      ]);
      await page.route("**/api/setup/status", (route) =>
        route.fulfill({ json: { initialized: true } }),
      );
      const overviewUrl = `/admin/overview?workspace=${w.id}`;
      const counts = page.getByRole("region", { name: "Workspace counts" });
      await page.goto(overviewUrl);
      await expect(
        counts.getByRole("link", { name: "0 coding tasks. View details" }),
      ).toBeVisible();
      for (const task of [direct, completed])
        await pool.query(
          "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
          [w.id, task.id, JSON.stringify(task)],
        );
      await page.reload();
      await expect(
        counts.getByRole("link", { name: "2 coding tasks. View details" }),
      ).toBeVisible();
      await store.pool.query(
        "INSERT INTO coding_tasks(workspace_id,id,data) VALUES($1,$2,$3)",
        [w.id, completedTask.id, JSON.stringify(completedTask)],
      );
      await page.reload();
      const card = counts.getByRole("link", {
        name: "3 coding tasks. View details",
      });
      await expect(card).toBeVisible();
      await expect(card.locator(".stat-sub")).toContainText(
        "1 active · 2 in review",
      );
      for (const regionName of [
        "Model and capabilities",
        "Recent coding tasks",
        "Recent threads",
        "7-day model usage",
        "Missions and automations",
      ]) {
        await expect(
          page.getByRole("region", { name: regionName, exact: true }),
        ).toBeVisible();
      }
      const recentCoding = page.getByRole("region", {
        name: "Recent coding tasks",
        exact: true,
      });
      for (const task of [direct, completed, completedTask]) {
        await expect(
          recentCoding.getByText(task.payload.title, { exact: true }),
        ).toBeVisible();
      }
      await card.hover();
      expect(
        await card.evaluate((el) => ({
          before: getComputedStyle(el, "::before").content,
          after: getComputedStyle(el, "::after").content,
        })),
      ).toEqual({ before: "none", after: "none" });
      await expect(card).toHaveAttribute(
        "href",
        `/admin/plugins/codex?workspace=${w.id}#coding-tasks`,
      );
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      await page.screenshot({
        path: test.info().outputPath("overview-coding-count.png"),
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await card.hover();
      await page.screenshot({
        path: test.info().outputPath("overview-coding-count-dark.png"),
        fullPage: true,
      });
      await page.emulateMedia({ colorScheme: "light" });
      await page.evaluate(() => {
        delete document.documentElement.dataset.theme;
      });
      await card.click();
      await expect(page).toHaveURL(
        new RegExp(`/admin/plugins/codex\\?workspace=${w.id}#coding-tasks$`),
      );
      const tasks = page.getByRole("region", { name: "Coding tasks" });
      for (const task of [direct, completed, completedTask])
        await expect(
          tasks.getByRole("row").filter({ hasText: task.payload.title }),
        ).toBeVisible();
      await expect(tasks.getByRole("row")).toHaveCount(4);
      await page.screenshot({
        path: test.info().outputPath("coding-tasks.png"),
        fullPage: true,
      });
    } finally {
      await page.goto("about:blank");
      await pool.query("DELETE FROM coding_tasks WHERE workspace_id=$1", [
        w.id,
      ]);
      await pool.query("DELETE FROM workspaces WHERE id=$1", [w.id]);
      await pool.query("DELETE FROM sessions WHERE admin_id=$1", [operatorId]);
      await pool.query("DELETE FROM admins WHERE id=$1", [operatorId]);
      await pool.end();
    }
  });
}
