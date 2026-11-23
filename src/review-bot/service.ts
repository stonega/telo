import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deploymentOrigin } from "../admin/site.ts";
import { branchName, codingPayload } from "../coding/config.ts";
import { appendGitHubDevelopment } from "../coding/github-inputs.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import {
  GitHubWebhooks,
  githubHookSecret,
  verifyGitHubSignature,
} from "../github/webhooks.ts";
import { ModelProviders } from "../models/service.ts";
import { fingerprint } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import {
  effectiveRepositoryAutomationRule,
  emptyReview,
  type ReviewPage,
  type ReviewTask,
  repositoryAutomationRuleSchema,
  reviewSave,
  reviewTerminal,
} from "./config.ts";
import { reviewMention } from "./mentions.ts";
import {
  checkReview,
  checkTriggerAuthor,
  reviewActor,
  reviewAuthority,
  reviewDestination,
} from "./policy.ts";

export const repositoryRuleUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    mode: z.enum(["inherit", "custom", "disabled"]).optional(),
    rule: repositoryAutomationRuleSchema.partial().optional(),
  })
  .strict();
export type RepositoryRuleUpdate = z.infer<typeof repositoryRuleUpdateSchema>;

export function updateRepositoryAutomationRule(
  w: Workspace,
  actor: string,
  repositoryId: number,
  raw: unknown,
) {
  const input = repositoryRuleUpdateSchema.parse(raw);
  const repository = w.github?.repositories.find((r) => r.id === repositoryId);
  requireThat(
    repository && !repository.archived && !repository.disabled,
    "github_repository_not_connected",
    404,
  );
  const currentRevision = w.reviewBot?.revision ?? 0;
  if (input.revision !== undefined) {
    requireThat(input.revision === currentRevision, "version_conflict", 409);
  }
  const hadReviewBot = !!w.reviewBot?.settings.enabled;
  const currentSettings = w.reviewBot?.settings ?? {
    ...emptyReview,
    autoReview: false,
  };
  const rules = { ...(currentSettings.repositoryRules ?? {}) };
  const key = String(repositoryId);
  if (input.mode === "inherit") {
    delete rules[key];
  } else if (input.mode === "disabled") {
    rules[key] = repositoryAutomationRuleSchema.parse({
      ...(rules[key] ?? {}),
      ...(input.rule ?? {}),
      enabled: false,
    });
  } else {
    rules[key] = repositoryAutomationRuleSchema.parse({
      ...(rules[key] ?? {}),
      ...(input.rule ?? {}),
      enabled: input.rule?.enabled ?? true,
    });
  }
  const hasAnyActiveRule = Object.values(rules).some((r) => r.enabled);
  const canEnableReviewBot = Boolean(
    w.github?.installationId && w.coding?.settings.enabled,
  );
  const nextSettings = {
    ...currentSettings,
    enabled: hadReviewBot || (hasAnyActiveRule && canEnableReviewBot),
    ...(Object.keys(rules).length > 0 ? { repositoryRules: rules } : {}),
  };
  if (Object.keys(rules).length === 0) {
    delete nextSettings.repositoryRules;
  }
  w.reviewBot = {
    revision: currentRevision + 1,
    settings: nextSettings,
  };
  for (const task of w.reviewTasks ?? []) {
    if (
      task.payload.repositoryId === repositoryId &&
      !reviewTerminal(task.state)
    ) {
      task.cancelRequested = true;
    }
  }
  audit(
    w,
    actor,
    "review.repository_rule_updated",
    String(repositoryId),
    w.reviewBot.revision,
  );
  return effectiveRepositoryAutomationRule(w, repositoryId);
}

const githubActor = z.object({
  id: z.number().int().positive().safe(),
  type: z.string(),
});
const eventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number().int().positive() }),
  repository: z.object({
    id: z.number().int().positive(),
    full_name: z.string(),
  }),
  sender: githubActor,
  label: z.object({ name: z.string().min(1).max(100) }).optional(),
  pull_request: z
    .object({
      number: z.number().int().positive(),
      draft: z.boolean(),
      head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
    })
    .optional(),
  issue: z
    .object({
      number: z.number().int().positive(),
      title: z.string().max(4096).optional(),
      body: z.string().max(20000).nullable().optional(),
      state: z.string().optional(),
      labels: z
        .array(z.union([z.string(), z.object({ name: z.string() })]))
        .optional(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  comment: z
    .object({
      id: z.number().int().positive(),
      body: z.string().max(20000),
      user: githubActor,
    })
    .optional(),
});

export { verifyGitHubSignature as verifyReviewSignature } from "../github/webhooks.ts";
export class ReviewService {
  readonly webhooks: GitHubWebhooks;
  constructor(
    readonly store: Store,
    readonly apps: GitHubApps,
    private key: string,
    private origin: string,
  ) {
    this.webhooks = new GitHubWebhooks(store, apps, key);
  }
  async hookSecret(operatorId: string) {
    return githubHookSecret(this.store, this.apps, this.key, operatorId);
  }
  async view(admin: Admin, workspaceId: string): Promise<ReviewPage> {
    const w = await this.store.read(workspaceId);
    reviewAuthority(w, admin);
    const app = await this.apps.get(w.operatorId);
    const origin = deploymentOrigin(await this.store.deployment(), this.origin);
    return {
      revision: w.reviewBot?.revision ?? 0,
      settings: w.reviewBot?.settings ?? emptyReview,
      botHandle: app ? `${app.config.slug}[bot]` : undefined,
      webhookUrl: `${origin}/github/webhook/${w.operatorId}`,
      webhookConfigured: !!(await this.hookSecret(w.operatorId)),
      tasks: [...(w.reviewTasks ?? [])].reverse(),
    };
  }
  async configureHook(admin: Admin, workspaceId: string, value: unknown) {
    const { secret } = await this.webhooks.configure(admin, workspaceId, value);
    return { secret, url: (await this.view(admin, workspaceId)).webhookUrl };
  }
  async save(admin: Admin, workspaceId: string, value: unknown) {
    const input = reviewSave.parse(value);
    await this.store.change(workspaceId, async (w, sql) => {
      reviewAuthority(w, admin);
      if (input.settings.model)
        await new ModelProviders(this.store, this.key ?? "").selected(
          w,
          input.settings.model,
        );
      requireThat(
        input.revision === (w.reviewBot?.revision ?? 0),
        "version_conflict",
        409,
      );
      // An App/repository has one review destination, even across the operator's workspaces.
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `review-settings:${w.operatorId}`,
      ]);
      if (input.settings.enabled) {
        requireThat(
          w.github?.installationId && w.coding?.settings.enabled,
          "review_repository_required",
          409,
        );
        requireThat(
          await this.hookSecret(w.operatorId),
          "review_webhook_required",
          409,
        );
        const others = await sql.query(
          "SELECT data FROM workspaces WHERE id<>$1 AND data->>'operatorId'=$2 AND data#>>'{reviewBot,settings,enabled}'='true'",
          [w.id, w.operatorId],
        );
        for (const { data } of others.rows as { data: Workspace }[])
          requireThat(
            data.deletion ||
              data.github?.installationId !== w.github.installationId ||
              !data.github?.repositories.some((r) =>
                w.github?.repositories.some((t) => t.id === r.id),
              ),
            "review_repository_already_configured",
            409,
          );
      }
      w.reviewBot = { revision: input.revision + 1, settings: input.settings };
      for (const task of w.reviewTasks ?? [])
        if (!reviewTerminal(task.state)) task.cancelRequested = true;
      audit(w, admin.id, "review.settings_updated", w.id, w.reviewBot.revision);
    });
    return this.view(admin, workspaceId);
  }
  async cancel(admin: Admin, workspaceId: string, id: string) {
    await this.store.change(workspaceId, (w) => {
      reviewAuthority(w, admin);
      const task = w.reviewTasks?.find((t) => t.id === id);
      requireThat(task, "not_found", 404);
      task.cancelRequested = true;
      audit(w, admin.id, "review.cancel_requested", id);
    });
    return this.view(admin, workspaceId);
  }
  async saveRepositoryRule(
    admin: Admin,
    workspaceId: string,
    repositoryId: number,
    value: unknown,
  ) {
    await this.store.change(workspaceId, async (w, sql) => {
      reviewAuthority(w, admin);
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `review-settings:${w.operatorId}`,
      ]);
      updateRepositoryAutomationRule(w, admin.id, repositoryId, value);
    });
    return this.view(admin, workspaceId);
  }
  async accept(
    operatorId: string,
    event: string,
    delivery: string,
    signature: string,
    body: Buffer,
  ) {
    z.uuid().parse(operatorId);
    requireThat(
      /^[a-zA-Z0-9-]{1,100}$/.test(delivery),
      "invalid_github_delivery",
      400,
    );
    const secret = await this.hookSecret(operatorId);
    requireThat(secret, "unauthorized_webhook", 401);
    verifyGitHubSignature(secret, body, signature);
    if (
      ![
        "pull_request",
        "issues",
        "issue_comment",
        "pull_request_review_comment",
        "installation",
        "installation_repositories",
      ].includes(event)
    )
      return { accepted: true };
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Fault("invalid_github_event");
    }
    const app = await this.apps.get(operatorId);
    requireThat(app, "github_app_not_configured", 409);
    if (event === "installation" || event === "installation_repositories") {
      const data = z
        .object({
          action: z.string(),
          installation: z.object({ id: z.number().int().positive() }),
          repositories_removed: z
            .array(z.object({ id: z.number().int().positive() }))
            .optional(),
        })
        .parse(raw);
      if (["deleted", "suspend", "removed"].includes(data.action))
        for (const w of await this.store.all())
          if (
            w.operatorId === operatorId &&
            w.github?.installationId === data.installation.id
          )
            await this.store.change(w.id, (current) => {
              for (const t of current.reviewTasks ?? [])
                if (
                  !data.repositories_removed ||
                  data.repositories_removed.some(
                    (r) => r.id === t.payload.repositoryId,
                  )
                )
                  t.cancelRequested = true;
            });
      return { accepted: true };
    }
    const data = eventSchema.parse(raw);
    const destination = await reviewDestination(
      this.store,
      operatorId,
      data.installation.id,
      data.repository.id,
    );
    for (const id of destination ? [destination] : [])
      await this.store.change(id, async (w, sql) => {
        const target = w.reviewBot?.settings;
        const repositoryId = data.repository.id;
        if (
          !target ||
          w.deletion ||
          w.operatorId !== operatorId ||
          w.github?.installationId !== data.installation.id ||
          !w.reviewBot?.settings.enabled ||
          !w.github.repositories.some(
            (r) =>
              r.id === repositoryId &&
              r.full_name === data.repository.full_name,
          )
        )
          return;
        const receipt = await sql.query(
          "INSERT INTO review_bot_receipts(workspace_id,app_id,delivery_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [w.id, app.config.id, delivery],
        );
        if (!receipt.rowCount) return;
        w.reviewTasks ??= [];
        const tasks = w.reviewTasks;
        const isIssueTarget =
          event === "issues" ||
          (event === "issue_comment" &&
            !!data.issue &&
            data.issue.pull_request === undefined);
        const targetKind: "pull_request" | "issue" = isIssueTarget
          ? "issue"
          : "pull_request";
        const number =
          data.pull_request?.number ??
          (isIssueTarget
            ? data.issue?.number
            : data.issue?.pull_request
              ? data.issue.number
              : undefined);
        if (!number) return;
        if (event === "issues" && data.issue?.pull_request !== undefined)
          return;
        const rule = effectiveRepositoryAutomationRule(w, repositoryId);
        if (
          event === "pull_request" &&
          ["closed", "converted_to_draft"].includes(data.action)
        ) {
          for (const t of tasks)
            if (
              (t.targetKind ?? "pull_request") === "pull_request" &&
              t.number === number &&
              t.payload.repositoryId === repositoryId &&
              (data.action === "closed" || t.automatic)
            )
              t.cancelRequested = true;
          return;
        }
        if (event === "issues" && data.action === "closed") {
          for (const t of tasks)
            if (
              t.targetKind === "issue" &&
              t.number === number &&
              t.payload.repositoryId === repositoryId
            )
              t.cancelRequested = true;
          return;
        }
        if (!rule.enabled) return;
        let mode: ReviewTask["mode"],
          actor: string,
          statusOnly: boolean | undefined,
          autoFixFollowup: boolean | undefined,
          githubUserId: number | undefined,
          text: string,
          source: ReviewTask["sources"][number] | undefined;
        const automatic = event === "pull_request" || event === "issues";
        let key = automatic
          ? targetKind === "issue"
            ? `auto-issue:${repositoryId}:${number}:${data.action === "labeled" ? `label:${data.label?.name?.toLowerCase() ?? delivery}` : "open"}`
            : `auto:${repositoryId}:${number}:${data.pull_request?.head.sha}`
          : `comment:${event}:${data.comment?.id}`;
        if (tasks.some((t) => t.key === key)) {
          const resumable =
            automatic &&
            (targetKind === "issue"
              ? ["reopened", "labeled"].includes(data.action)
              : ["reopened", "ready_for_review"].includes(data.action));
          const existing = tasks.filter(
            (t) => t.key === key || t.key.startsWith(`${key}:`),
          );
          if (
            !resumable ||
            existing.some((t) => !t.cancelRequested && t.state !== "cancelled")
          )
            return;
          key = `${key}:${delivery}`;
        }
        if (automatic && targetKind === "pull_request") {
          if (
            !rule.autoReview ||
            data.pull_request?.draft ||
            !["opened", "synchronize", "reopened", "ready_for_review"].includes(
              data.action,
            )
          )
            return;
          const allowedActor = checkTriggerAuthor(
            w,
            data.sender.id,
            repositoryId,
            rule.prTriggerAuthors,
          );
          if (!allowedActor) return;
          mode = "review";
          actor = allowedActor;
          text = rule.prInstructions
            ? `Review this pull request.\n\nRepository PR rules:\n${rule.prInstructions}`
            : "Review this pull request.";
          for (const t of tasks)
            if (
              t.automatic &&
              (t.targetKind ?? "pull_request") === "pull_request" &&
              t.payload.repositoryId === repositoryId &&
              t.number === number &&
              !reviewTerminal(t.state)
            )
              t.cancelRequested = true;
        } else if (automatic && targetKind === "issue") {
          if (
            (!rule.issueAutoReply && !rule.issueAutoFix) ||
            !["opened", "reopened", "labeled"].includes(data.action)
          )
            return;
          const requiredLabels = rule.issueTriggerLabels.map((l) =>
            l.toLowerCase(),
          );
          if (data.action === "labeled" && requiredLabels.length === 0) return;
          if (requiredLabels.length > 0) {
            const candidateLabels =
              data.action === "labeled"
                ? data.label?.name
                  ? [data.label.name.toLowerCase()]
                  : []
                : (data.issue?.labels ?? []).map((l) =>
                    (typeof l === "string" ? l : l.name).toLowerCase(),
                  );
            if (!candidateLabels.some((l) => requiredLabels.includes(l)))
              return;
          }
          const allowedActor = checkTriggerAuthor(
            w,
            data.sender.id,
            repositoryId,
            rule.issueTriggerAuthors,
          );
          if (!allowedActor) return;
          actor = allowedActor;
          if (rule.issueAutoReply) {
            mode = "answer";
            autoFixFollowup = rule.issueAutoFix || undefined;
            text = rule.issueInstructions
              ? `Analyze and reply to this issue.\n\nRepository issue rules:\n${rule.issueInstructions}`
              : "Analyze and reply to this issue.";
          } else {
            mode = "fix";
            text = rule.issueInstructions
              ? `Investigate and fix this issue, then open a pull request.\n\nRepository issue rules:\n${rule.issueInstructions}`
              : "Investigate and fix this issue, then open a pull request.";
          }
          for (const t of tasks)
            if (
              t.automatic &&
              t.targetKind === "issue" &&
              t.payload.repositoryId === repositoryId &&
              t.number === number &&
              !reviewTerminal(t.state)
            )
              t.cancelRequested = true;
        } else {
          const acceptsComments =
            targetKind === "issue"
              ? rule.issueAcceptRequests
              : rule.acceptRequests;
          if (
            data.action !== "created" ||
            !acceptsComments ||
            !data.comment ||
            data.comment.user.type !== "User" ||
            data.sender.id !== data.comment.user.id
          )
            return;
          const mention = reviewMention(
            data.comment.body,
            `${app.config.slug}[bot]`,
            targetKind,
          );
          if (!mention) return;
          try {
            actor = reviewActor(
              w,
              data.comment.user.id,
              repositoryId,
              mention.mode === "fix" || mention.mode === "close",
            );
          } catch {
            return;
          }
          const active = [...tasks]
            .reverse()
            .find(
              (t) =>
                (t.targetKind ?? "pull_request") === targetKind &&
                t.payload.repositoryId === repositoryId &&
                t.number === number &&
                !reviewTerminal(t.state),
            );
          if (mention.mode === "cancel") {
            if (active) {
              active.cancelRequested = true;
              audit(w, actor, "review.cancel_requested", active.id);
            }
            return;
          }
          githubUserId = data.comment.user.id;
          source = {
            id: data.comment.id,
            kind: event === "issue_comment" ? "issue" : "review",
            hash: fingerprint(data.comment.body),
            githubId: githubUserId,
          };
          if (mention.mode === "fix" && targetKind === "pull_request") {
            if (!rule.allowFixes) return;
            if (
              await appendGitHubDevelopment(sql, w, {
                installationId: data.installation.id,
                repositoryId,
                number,
                actor,
                githubId: githubUserId,
                kind: source.kind,
                id: source.id,
                body: data.comment.body,
                text: mention.text,
              })
            )
              return;
          }
          if (
            active?.state === "waiting" &&
            active.actor === actor &&
            ["answer", "fix"].includes(mention.mode)
          ) {
            requireThat(active.revision < 100, "coding_input_capacity", 429);
            active.revision++;
            active.inputs.push({
              revision: active.revision,
              actor,
              sourceId: `github:${source.kind}:${source.id}`,
              text: mention.text,
              kind: "answer",
            });
            active.sources.push(source);
            active.previousAttemptId = active.attemptId;
            active.attemptIds ??= [];
            active.attemptIds.push(active.attemptId);
            active.attemptId = randomUUID();
            active.run = undefined;
            active.state = "queued";
            active.nextPollAt = undefined;
            active.updatedAt = new Date().toISOString();
            return;
          }
          mode =
            mention.mode === "status"
              ? "answer"
              : targetKind === "issue" && mention.mode === "review"
                ? "answer"
                : mention.mode;
          statusOnly = mention.mode === "status";
          if (mode === "fix") {
            const allowFix =
              targetKind === "issue"
                ? rule.issueAutoFix || rule.allowFixes
                : rule.allowFixes;
            if (!allowFix) return;
          }
          if (mode === "close") {
            const allowClose =
              targetKind === "issue"
                ? rule.issueAllowAutoClose || rule.allowAutoClose
                : rule.allowAutoClose;
            if (!allowClose) return;
          }
          text = mention.text;
        }
        if (
          tasks.length >= 200 ||
          tasks.filter((t) => !reviewTerminal(t.state)).length >= 20
        )
          throw new Fault("review_capacity_reached", 429);
        const coding = w.coding;
        const repository = w.github.repositories.find(
          (r) => r.id === repositoryId,
        );
        if (
          !coding?.settings.enabled ||
          !repository ||
          !w.github.installationId
        )
          return;
        const at = new Date().toISOString();
        const task: ReviewTask = {
          id: randomUUID(),
          key,
          actor,
          githubUserId,
          payload: codingPayload.parse({
            repositoryId: repositoryId,
            repository: data.repository.full_name,
            installationId: data.installation.id,
            githubRevision: w.github.revision,
            configRevision: coding.revision,
            baseBranch: branchName.parse(repository.default_branch),
            backend: "podman",
            authMode: coding.settings.authMode,
            title: `${targetKind === "issue" ? "Issue" : "PR"} #${number}`,
            body: text.slice(0, 2500),
          }),
          reviewRevision: w.reviewBot.revision,
          number,
          ...(targetKind === "issue" ? { targetKind: "issue" as const } : {}),
          ...(autoFixFollowup ? { autoFixFollowup: true } : {}),
          mode,
          statusOnly,
          automatic,
          inputs: [
            {
              revision: 1,
              actor,
              sourceId: source
                ? `github:${source.kind}:${source.id}`
                : `github:auto:${delivery}`,
              text,
              kind: "request",
            },
          ],
          sources: source ? [source] : [],
          revision: 1,
          consumedRevision: 0,
          state: "queued",
          attemptId: randomUUID(),
          headSha:
            automatic && targetKind === "pull_request"
              ? data.pull_request?.head.sha
              : undefined,
          progress:
            automatic && !(targetKind === "issue" && mode === "fix")
              ? undefined
              : { state: "pending" },
          createdAt: at,
          updatedAt: at,
        };
        try {
          checkReview(w, task);
        } catch {
          return;
        }
        tasks.push(task);
        audit(w, actor, "review.task_accepted", task.id);
      });
    return { accepted: true };
  }
}
