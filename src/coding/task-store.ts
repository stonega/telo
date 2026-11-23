import type { Sql } from "../db/pool.ts";
import { requireThat } from "../domain.ts";
import type { GitHubApp } from "../github/app.ts";
import type { DevelopmentInput, DevelopmentTask } from "./development.ts";

export async function taskList(
  sql: Sql,
  workspaceId: string,
): Promise<DevelopmentTask[]> {
  return (
    await sql.query(
      "SELECT data FROM coding_tasks WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 200",
      [workspaceId],
    )
  ).rows.map((r) => r.data);
}
export async function taskFind(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<DevelopmentTask | undefined> {
  const result = await sql.query(
    "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND id=$2",
    [workspaceId, id],
  );
  return result.rows[0]?.data as DevelopmentTask | undefined;
}
export async function taskGet(
  sql: Sql,
  workspaceId: string,
  id: string,
): Promise<DevelopmentTask> {
  const result = await sql.query(
    "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
    [workspaceId, id],
  );
  requireThat(result.rows[0], "not_found", 404);
  return result.rows[0].data;
}
export async function taskSave(
  sql: Sql,
  task: DevelopmentTask,
  touchUpdatedAt = true,
) {
  if (touchUpdatedAt) task.updatedAt = new Date().toISOString();
  await sql.query(
    touchUpdatedAt
      ? "UPDATE coding_tasks SET data=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2"
      : "UPDATE coding_tasks SET data=$3 WHERE workspace_id=$1 AND id=$2",
    [task.workspaceId, task.id, JSON.stringify(task)],
  );
}
export async function updateCodingPullState(
  sql: Sql,
  workspaceId: string,
  match: {
    installationId?: number;
    repositoryId: number;
    number: number;
    state: "open" | "merged" | "closed";
  },
): Promise<number> {
  const candidates = (await taskList(sql, workspaceId)).filter(
    (t) =>
      !t.contentRemoved &&
      t.payload.repositoryId === match.repositoryId &&
      (match.installationId === undefined ||
        t.payload.installationId === match.installationId) &&
      t.pr?.number === match.number &&
      (t.pr.state ?? "open") !== match.state,
  );
  let updated = 0;
  for (const candidate of candidates) {
    const task = await taskGet(sql, workspaceId, candidate.id);
    if (
      task.contentRemoved ||
      task.payload.repositoryId !== match.repositoryId ||
      (match.installationId !== undefined &&
        task.payload.installationId !== match.installationId) ||
      task.pr?.number !== match.number ||
      (task.pr.state ?? "open") === match.state
    )
      continue;
    task.pr.state = match.state;
    await taskSave(sql, task, false);
    updated++;
  }
  return updated;
}
export async function syncWorkspaceCodingPullStates(
  sql: Sql,
  workspaceId: string,
  app?: GitHubApp,
  filter?: (task: DevelopmentTask) => boolean,
): Promise<DevelopmentTask[]> {
  const tasks = await taskList(sql, workspaceId);
  if (!app) return tasks;
  const candidates = tasks
    .filter(
      (t) =>
        !t.contentRemoved &&
        (!filter || filter(t)) &&
        t.state === "review" &&
        t.pr &&
        (t.pr.state === undefined || t.pr.state === "open"),
    )
    .slice(0, 10);
  if (!candidates.length) return tasks;
  const byInstallation = new Map<number, DevelopmentTask[]>();
  for (const task of candidates) {
    const group = byInstallation.get(task.payload.installationId) ?? [];
    group.push(task);
    byInstallation.set(task.payload.installationId, group);
  }
  let changed = false;
  for (const [installationId, group] of byInstallation) {
    const repoIds = [...new Set(group.map((t) => t.payload.repositoryId))];
    let token: string;
    try {
      token = (
        await app.installationToken(installationId, repoIds, "pulls_read")
      ).token;
    } catch {
      continue;
    }
    for (const candidate of group) {
      if (!candidate.pr) continue;
      try {
        const status = await app.codingPullStatus(
          token,
          candidate.payload.repository,
          candidate.pr.number,
        );
        if ((candidate.pr.state ?? "open") !== status.state) {
          const count = await updateCodingPullState(sql, workspaceId, {
            installationId,
            repositoryId: candidate.payload.repositoryId,
            number: candidate.pr.number,
            state: status.state,
          });
          if (count > 0) changed = true;
        }
      } catch {
        /* Best-effort status reconciliation must not fail read views. */
      }
    }
  }
  return changed ? taskList(sql, workspaceId) : tasks;
}
export async function taskInputs(
  sql: Sql,
  task: DevelopmentTask,
): Promise<DevelopmentInput[]> {
  return (
    await sql.query(
      "SELECT data FROM coding_task_inputs WHERE workspace_id=$1 AND task_id=$2 ORDER BY revision",
      [task.workspaceId, task.id],
    )
  ).rows.map((r) => r.data);
}
export async function taskEvent(
  sql: Sql,
  task: DevelopmentTask,
  id: string,
  data: unknown,
) {
  await sql.query(
    "INSERT INTO coding_task_events(workspace_id,task_id,id,data,created_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT DO NOTHING",
    [task.workspaceId, task.id, id, JSON.stringify(data)],
  );
}
export async function finishAttempt(
  sql: Sql,
  task: DevelopmentTask,
  state = "done",
  data: unknown = {},
) {
  if (task.attemptId)
    await sql.query(
      "UPDATE coding_task_attempts SET state=$3,data=data || $4::jsonb WHERE workspace_id=$1 AND id=$2 AND fence=$5",
      [
        task.workspaceId,
        task.attemptId,
        state,
        JSON.stringify(data),
        task.fence,
      ],
    );
}
