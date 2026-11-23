import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import {
  authorizeVerifiedRepository,
  repositoryMaintainer,
} from "../github/user-access.ts";
import { eligible } from "../workspaces/policy.ts";
import {
  effectiveRepositoryAutomationRule,
  type ReviewTask,
  type TriggerAuthors,
} from "./config.ts";

/** One PR destination, including after a GitHub connection changes its scope. */
export async function reviewDestination(
  store: Store,
  operatorId: string,
  installationId: number,
  repositoryId: number,
) {
  const result = await store.pool.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE data->>'operatorId'=$1
      AND data#>>'{github,installationId}'=$2
      AND data#>>'{reviewBot,settings,enabled}'='true'
      AND coalesce(data->'deletion','null'::jsonb)='null'::jsonb
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(data#>'{github,repositories}') repository WHERE repository->>'id'=$3)
      ORDER BY id LIMIT 1`,
    [operatorId, String(installationId), String(repositoryId)],
  );
  return result.rows[0]?.id;
}

export function reviewAuthority(w: Workspace, admin: Admin) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function reviewActor(
  w: Workspace,
  githubId: number,
  repositoryId: number,
  write: boolean,
) {
  // Admin-selected profile associations do not verify ownership.
  const member = w.members.find((m) => m.github?.id === githubId);
  requireThat(member && eligible(w, member.id), "review_actor_unverified", 403);
  authorizeVerifiedRepository(w, member.id, repositoryId, write);
  return member.id;
}

export function checkTriggerAuthor(
  w: Workspace,
  githubId: number,
  repositoryId: number,
  triggerAuthors: TriggerAuthors,
): string | undefined {
  if (triggerAuthors === "all") return w.operatorId;
  const member = w.members.find((m) => m.github?.id === githubId);
  if (!member || !eligible(w, member.id)) return undefined;
  try {
    if (triggerAuthors === "maintainers") {
      if (!repositoryMaintainer(w, member.id, repositoryId)) return undefined;
      authorizeVerifiedRepository(w, member.id, repositoryId, true);
    } else {
      authorizeVerifiedRepository(w, member.id, repositoryId, false);
    }
    return member.id;
  } catch {
    return undefined;
  }
}

export function checkReview(w: Workspace, task: ReviewTask, stopping = false) {
  const isIssue = task.targetKind === "issue";
  requireThat(
    !w.deletion &&
      (task.automatic
        ? (task.actor === w.operatorId || eligible(w, task.actor)) &&
          (isIssue
            ? ["answer", "fix", "close"].includes(task.mode)
            : ["review", "close"].includes(task.mode))
        : eligible(w, task.actor)),
    "access_denied",
    403,
  );
  if (stopping) return;
  const config = w.reviewBot;
  const rule = effectiveRepositoryAutomationRule(w, task.payload.repositoryId);
  requireThat(
    config?.settings.enabled &&
      config.revision === task.reviewRevision &&
      rule.enabled,
    "review_configuration_changed",
    409,
  );
  requireThat(
    !w.settings.paused && !task.cancelRequested,
    "review_cancelled",
    409,
  );
  if (isIssue) {
    requireThat(
      task.automatic
        ? task.mode === "fix"
          ? rule.issueAutoFix
          : rule.issueAutoReply || rule.issueAutoFix
        : rule.issueAcceptRequests,
      "review_requests_disabled",
      409,
    );
    requireThat(
      task.mode !== "fix" ||
        rule.issueAutoFix ||
        (!task.automatic && rule.allowFixes),
      "review_fixes_disabled",
      403,
    );
    requireThat(
      task.mode !== "close" || rule.issueAllowAutoClose || rule.allowAutoClose,
      "review_close_disabled",
      403,
    );
  } else {
    requireThat(
      task.automatic ? rule.autoReview : rule.acceptRequests,
      "review_requests_disabled",
      409,
    );
    requireThat(
      task.mode !== "fix" || rule.allowFixes,
      "review_fixes_disabled",
      403,
    );
    requireThat(
      task.mode !== "close" || rule.allowAutoClose,
      "review_close_disabled",
      403,
    );
  }
  const connection = w.github;
  requireThat(
    connection?.installationId === task.payload.installationId &&
      connection.revision === task.payload.githubRevision &&
      connection.repositories.some(
        (r) =>
          r.id === task.payload.repositoryId &&
          r.full_name === task.payload.repository &&
          !r.archived &&
          !r.disabled,
      ),
    "github_repository_not_connected",
    409,
  );
  const coding = w.coding;
  requireThat(
    coding?.settings.enabled && coding.revision === task.payload.configRevision,
    "coding_configuration_changed",
    409,
  );
  if (!task.automatic)
    authorizeVerifiedRepository(
      w,
      task.actor,
      task.payload.repositoryId,
      task.mode === "fix" || task.mode === "close",
    );
  if (!task.automatic)
    requireThat(
      w.members.find((m) => m.id === task.actor)?.github?.id ===
        task.githubUserId,
      "review_actor_unverified",
      403,
    );
}
