import { randomUUID } from "node:crypto";
import { z } from "zod";
import { evaluateAutonomy } from "../autonomy/policy.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Approval,
  Fault,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { decrypt, encrypt, fingerprint } from "../setup/credentials.ts";
import { audit, authorize, runAllowed } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import type {
  GitHubApp,
  GitHubOrganizationMembership,
  GitHubOrganizationPolicy,
} from "./app.ts";
import { githubConnectionRevision } from "./config.ts";
import { GitHubApps } from "./registry.ts";

export const repositoryVisibilitySchema = z.enum([
  "public",
  "private",
  "internal",
]);
export type RepositoryVisibility = z.infer<typeof repositoryVisibilitySchema>;

export const repositoryCreateInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => value !== "." && value !== ".."),
    description: z
      .string()
      .trim()
      .max(350)
      .optional()
      .transform((value) => (value ? value : undefined)),
    visibility: repositoryVisibilitySchema.default("private"),
    autoInit: z.boolean().optional(),
    gitignoreTemplate: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.+-]{1,100}$/)
      .optional(),
    licenseTemplate: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9.-]{1,100}$/)
      .optional(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const repositoryCreatePayload = repositoryCreateInput.extend({
  installationId: z.number().int().positive().safe(),
  ownerType: z.enum(["personal", "organization"]),
  owner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
  ownerId: z.number().int().positive().safe(),
  githubUserId: z.number().int().positive().safe(),
  githubUserLogin: z.string().min(1).max(100),
});

export type RepositoryCreateInput = z.infer<typeof repositoryCreateInput>;
export type RepositoryCreatePayload = z.infer<typeof repositoryCreatePayload>;

export const repositoryCreateGuidance: Readonly<Record<string, string>> = {
  github_user_connection_required:
    "Send /github in this bot's private chat to connect and verify your GitHub account, then retry your request.",
  github_credentials_unavailable:
    "GitHub user credentials are not configured on this server. Contact the deployment operator.",
  github_authorization_expired:
    "Your GitHub authorization expired or was revoked. Send /github in this bot's private chat to reconnect your GitHub account, then retry.",
  github_identity_changed:
    "Your connected GitHub identity no longer matches. Send /github in this bot's private chat to reconnect your GitHub account.",
  github_app_permissions_missing:
    "Ask the GitHub App owner to grant Repository permissions -> Repository creation: Read and write (or Administration: Read and write), then accept the updated permissions for the matching installation in GitHub. Reconnecting Telo alone does not grant missing permissions.",
  github_repo_create_owner_required:
    "Only the owner of the connected personal GitHub account can create repositories under it.",
  github_repo_invalid_visibility:
    "Personal GitHub accounts only support public or private repositories (internal visibility is only available for Enterprise organizations).",
  github_repo_private_chat_required:
    "Creating a private or internal GitHub repository must be requested in a private Telegram chat with the bot.",
  github_org_membership_required:
    "You must be an active member of this GitHub organization with repository creation permission.",
  github_org_repo_creation_denied:
    "This GitHub organization's permission setup does not allow your GitHub account to create a repository with that visibility. Ask an organization owner or check the organization's member repository creation settings.",
  github_repo_already_exists:
    "A repository with that name already exists under this GitHub account or organization. Choose a different name.",
  github_repo_access_denied:
    "GitHub denied repository creation. Check your GitHub account permissions, organization member privileges (or SAML SSO), and the GitHub App's accepted Repository creation permission.",
  github_repo_rejected:
    "GitHub rejected the repository settings (name, visibility, or template). Check the parameters before requesting a new proposal.",
  github_access_denied:
    "GitHub denied access to the installation or organization. Check your connected GitHub account and App installation status.",
  github_rate_limited:
    "GitHub rate-limited the request. Wait a moment before trying again.",
};

/**
 * Evaluate GitHub organization repository-creation policy returned by `GET /orgs/{org}`.
 * Organization owners (`role === "admin"`) are not restricted by base member privileges;
 * regular members (`role === "member"`) follow the org's `members_can_create_*` settings.
 * When GitHub omits org policy fields (e.g. for non-owners), returns true here and relies on
 * GitHub enforcing the org's exact permission setup on `POST /orgs/{org}/repos` with the user's token.
 */
export function evaluateOrgRepoCreationPolicy(
  policy: Pick<
    GitHubOrganizationPolicy,
    | "members_can_create_repositories"
    | "members_can_create_public_repositories"
    | "members_can_create_private_repositories"
    | "members_can_create_internal_repositories"
    | "members_allowed_repository_creation_type"
  >,
  role: GitHubOrganizationMembership["role"],
  visibility: RepositoryVisibility,
): boolean {
  if (role === "admin") return true;
  const specific =
    visibility === "public"
      ? policy.members_can_create_public_repositories
      : visibility === "private"
        ? policy.members_can_create_private_repositories
        : policy.members_can_create_internal_repositories;
  if (specific === false) return false;
  if (policy.members_allowed_repository_creation_type === "none") return false;
  if (
    policy.members_allowed_repository_creation_type === "private" &&
    visibility === "public"
  )
    return false;
  if (policy.members_can_create_repositories === false && specific !== true)
    return false;
  return true;
}

function checkLocalScope(
  w: Workspace,
  actor: string,
  runId: string | undefined,
  input: RepositoryCreateInput,
  expectedInstallationId?: number,
  expectedGitHubUserId?: number,
) {
  authorize(w, actor);
  requireThat(!w.settings.paused, "access_denied", 403);
  requireThat(w.github?.installationId, "github_repository_not_connected", 409);
  if (expectedInstallationId !== undefined)
    requireThat(
      w.github.installationId === expectedInstallationId,
      "approval_stale",
      409,
    );
  requireThat(
    input.revision >= githubConnectionRevision(w.github) &&
      input.revision <= w.github.revision,
    expectedInstallationId !== undefined
      ? "approval_stale"
      : "version_conflict",
    409,
  );
  const member = w.members.find((m) => m.id === actor);
  requireThat(
    member?.github && member.github.status !== "disconnected",
    "github_user_connection_required",
    403,
  );
  if (expectedGitHubUserId !== undefined)
    requireThat(
      member.github.id === expectedGitHubUserId,
      "github_identity_changed",
      403,
    );
  const run = w.runs.find((r) => r.id === runId);
  requireThat(
    run && run.actor === actor && !run.workflowId && runAllowed(w, run),
    expectedInstallationId !== undefined ? "run_revoked" : "tool_policy_denied",
    expectedInstallationId !== undefined ? 409 : 403,
  );
  requireThat(
    run.chatId === run.actor || input.visibility === "public",
    "github_repo_private_chat_required",
    403,
  );
  return {
    run,
    installationId: w.github.installationId,
    githubUserId: member.github.id,
  };
}

export function checkRepositoryCreateApproval(w: Workspace, a: Approval) {
  requireThat(
    a.kind === "github_repository" && fingerprint(a.payload) === a.hash,
    "approval_changed",
    409,
  );
  requireThat(Date.parse(a.expiresAt) > Date.now(), "approval_expired", 409);
  const payload = repositoryCreatePayload.parse(a.payload);
  const {
    installationId,
    ownerType,
    owner,
    ownerId: _,
    githubUserId,
    githubUserLogin: __,
    ...input
  } = payload;
  if (ownerType === "personal")
    requireThat(
      input.visibility !== "internal",
      "github_repo_invalid_visibility",
      400,
    );
  checkLocalScope(w, a.actor, a.runId, input, installationId, githubUserId);
  if (w.github?.account)
    requireThat(
      w.github.account.toLowerCase() === owner.toLowerCase(),
      "approval_stale",
      409,
    );
  return payload;
}

/** Models can propose; this service alone creates repositories using the requester's verified GitHub token. */
export class GitHubRepositories {
  constructor(
    private store: Store,
    private apps: GitHubApp | GitHubApps,
    private encryptionKey?: string,
  ) {}

  private async app(operatorId: string) {
    const app =
      this.apps instanceof GitHubApps
        ? await this.apps.get(operatorId)
        : this.apps;
    requireThat(app, "github_app_not_configured", 409);
    return app;
  }

  private scope(workspaceId: string, actor: string) {
    return `github-user:${workspaceId}:${actor}`;
  }

  private async resolveUserToken(
    w: Workspace,
    actor: string,
    app: GitHubApp,
  ): Promise<{ token: string; identity: { id: number; login: string } }> {
    const member = w.members.find((m) => m.id === actor);
    requireThat(
      member?.github && member.github.status !== "disconnected",
      "github_user_connection_required",
      403,
    );
    const key = this.encryptionKey;
    requireThat(key, "github_credentials_unavailable", 503);
    const row = (
      await this.store.pool.query(
        "SELECT app_id,user_token,refresh_token,token_expires_at FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2",
        [w.id, actor],
      )
    ).rows[0];
    requireThat(row, "github_user_connection_required", 403);
    requireThat(
      Number(row.app_id) === app.config.id,
      "github_connection_changed",
      409,
    );
    let userToken = decrypt(key, this.scope(w.id, actor), row.user_token);
    if (
      row.token_expires_at &&
      new Date(row.token_expires_at).getTime() < Date.now() + 60000
    ) {
      userToken = await this.store.change(w.id, async (current, sql) => {
        authorize(current, actor);
        const locked = (
          await sql.query(
            "SELECT app_id,user_token,refresh_token,token_expires_at FROM github_user_accounts WHERE workspace_id=$1 AND actor=$2 FOR UPDATE",
            [w.id, actor],
          )
        ).rows[0];
        requireThat(locked, "github_user_connection_required", 403);
        requireThat(
          Number(locked.app_id) === app.config.id,
          "github_connection_changed",
          409,
        );
        if (
          !locked.token_expires_at ||
          new Date(locked.token_expires_at).getTime() >= Date.now() + 60000
        )
          return decrypt(key, this.scope(w.id, actor), locked.user_token);
        requireThat(locked.refresh_token, "github_authorization_expired", 409);
        const rotated = await app.refresh(
          decrypt(
            key,
            `${this.scope(w.id, actor)}:refresh`,
            locked.refresh_token,
          ),
        );
        await sql.query(
          "UPDATE github_user_accounts SET user_token=$3,refresh_token=$4,token_expires_at=$5 WHERE workspace_id=$1 AND actor=$2",
          [
            w.id,
            actor,
            encrypt(key, this.scope(w.id, actor), rotated.token),
            rotated.refreshToken
              ? encrypt(
                  key,
                  `${this.scope(w.id, actor)}:refresh`,
                  rotated.refreshToken,
                )
              : null,
            rotated.expiresAt ?? null,
          ],
        );
        return rotated.token;
      });
    }
    let identity: { id: number; login: string };
    try {
      identity = await app.user(userToken);
    } catch (error) {
      if (error instanceof Fault && error.code === "github_access_denied")
        throw new Fault("github_authorization_expired", 403);
      throw error;
    }
    requireThat(
      identity.id === member.github.id,
      "github_identity_changed",
      403,
    );
    return { token: userToken, identity };
  }

  private async verifyAuthority(
    w: Workspace,
    actor: string,
    app: GitHubApp,
    input: RepositoryCreateInput,
    installationId: number,
    signal?: AbortSignal,
  ) {
    const installation = await app.installation(installationId, signal);
    requireThat(
      installation.permissions.repository_creation === "write" ||
        installation.permissions.administration === "write",
      "github_app_permissions_missing",
      409,
    );
    if (w.github?.account)
      requireThat(
        w.github.account.toLowerCase() ===
          installation.account.login.toLowerCase(),
        "approval_stale",
        409,
      );
    const { token: userToken, identity } = await this.resolveUserToken(
      w,
      actor,
      app,
    );
    if (installation.account.type === "User") {
      requireThat(
        input.visibility !== "internal",
        "github_repo_invalid_visibility",
        400,
      );
      requireThat(
        identity.id === installation.account.id &&
          identity.login.toLowerCase() ===
            installation.account.login.toLowerCase(),
        "github_repo_create_owner_required",
        403,
      );
      return {
        userToken,
        ownerType: "personal" as const,
        owner: installation.account.login,
        ownerId: installation.account.id,
        githubUserId: identity.id,
        githubUserLogin: identity.login,
      };
    }
    // Organization account: follow GitHub organization membership and permission setup.
    const hasMembersGrant = ["read", "write"].includes(
      installation.permissions.members ?? "",
    );
    let membership: GitHubOrganizationMembership | undefined;
    if (hasMembersGrant) {
      try {
        membership = await app.organizationMembership(
          userToken,
          installation.account.login,
          signal,
        );
      } catch (error) {
        if (error instanceof Fault && error.code === "github_access_denied")
          throw new Fault("github_org_membership_required", 403);
        throw error;
      }
      requireThat(
        membership.state === "active",
        "github_org_membership_required",
        403,
      );
    }
    const orgPolicy = await app.organization(
      userToken,
      installation.account.login,
      signal,
    );
    if (membership)
      requireThat(
        evaluateOrgRepoCreationPolicy(
          orgPolicy,
          membership.role,
          input.visibility,
        ),
        "github_org_repo_creation_denied",
        403,
      );
    return {
      userToken,
      ownerType: "organization" as const,
      owner: installation.account.login,
      ownerId: installation.account.id,
      githubUserId: identity.id,
      githubUserLogin: identity.login,
    };
  }

  async propose(
    workspaceId: string,
    runId: string,
    callId: string,
    value: unknown,
    revision: number,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ) {
    const input = repositoryCreateInput.parse({
      ...(value as object),
      revision,
    });
    const target = `${runId}:${callId}`;
    const check = (w: Workspace) => {
      signal.throwIfAborted();
      const run = w.runs.find((r) => r.id === runId);
      requireThat(
        run &&
          run.status === "running" &&
          !run.workflowId &&
          runAllowed(w, run),
        "tool_policy_denied",
        403,
      );
      const local = checkLocalScope(w, run.actor, runId, input);
      const prior = w.approvals.find(
        (a) => a.kind === "github_repository" && a.target === target,
      );
      if (prior) {
        const {
          installationId: _,
          ownerType: __,
          owner: ___,
          ownerId: ____,
          githubUserId: _____,
          githubUserLogin: ______,
          ...saved
        } = repositoryCreatePayload.parse(prior.payload);
        requireThat(
          prior.actor === run.actor &&
            fingerprint(saved) === fingerprint(input),
          "tool_call_conflict",
          409,
        );
      } else
        requireThat(
          !w.approvals.some(
            (a) =>
              a.actor === run.actor &&
              !a.decision &&
              Date.parse(a.expiresAt) > Date.now(),
          ),
          "resolve_existing_proposal_first",
          409,
        );
      return { local, run, prior };
    };
    signal.throwIfAborted();
    await guard();
    const w = await this.store.read(workspaceId);
    const initial = check(w);
    if (initial.prior) return initial.prior.id;
    const app = await this.app(w.operatorId);
    const verified = await this.verifyAuthority(
      w,
      initial.run.actor,
      app,
      input,
      initial.local.installationId,
      signal,
    );
    signal.throwIfAborted();
    await guard();
    return this.store.change(workspaceId, (current) => {
      const { local, run, prior } = check(current);
      if (prior) return prior.id;
      requireThat(
        local.installationId === initial.local.installationId &&
          local.githubUserId === verified.githubUserId,
        "approval_stale",
        409,
      );
      const payload = repositoryCreatePayload.parse({
        ...input,
        installationId: local.installationId,
        ownerType: verified.ownerType,
        owner: verified.owner,
        ownerId: verified.ownerId,
        githubUserId: verified.githubUserId,
        githubUserLogin: verified.githubUserLogin,
      });
      const a: Approval = {
        id: randomUUID(),
        actor: run.actor,
        runId,
        kind: "github_repository",
        target,
        version: revision,
        payload,
        hash: fingerprint(payload),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      };
      current.approvals.push(a);
      const decision = evaluateAutonomy(current, "github_repo_create");
      if (decision.allowedAutomatic) {
        a.decision = "approved";
        a.autonomyMode = decision.effectiveMode;
        audit(current, run.actor, "github.repository_auto_approved", a.id);
      } else {
        const ownerLabel =
          payload.ownerType === "organization"
            ? `${payload.owner} (Organization)`
            : `${payload.owner} (Personal account)`;
        const lines = [
          `Create GitHub repository ${payload.owner}/${payload.name}?`,
          `Owner: ${ownerLabel}`,
          `Visibility: ${payload.visibility}`,
          ...(payload.description
            ? [`Description: ${payload.description}`]
            : []),
          ...(payload.autoInit ? ["Initialize with README: yes"] : []),
          ...(payload.gitignoreTemplate
            ? [`.gitignore template: ${payload.gitignoreTemplate}`]
            : []),
          ...(payload.licenseTemplate
            ? [`License: ${payload.licenseTemplate}`]
            : []),
          "",
          `Approving creates this repository under your GitHub account (${payload.githubUserLogin})${payload.ownerType === "organization" ? " following the organization's permission setup" : ""}.`,
        ];
        deliver(current, run.actor, run.chatId, lines.join("\n"), {
          runId,
          topicId: run.topicId,
          id: `github-repo:${a.id}:review`,
          buttons: [
            [
              { text: "Approve", callback_data: `approve:${a.id}` },
              { text: "Reject", callback_data: `reject:${a.id}` },
            ],
          ],
        });
        audit(current, run.actor, "github.repository_proposed", a.id);
      }
      return a.id;
    });
  }

  async send(workspaceId: string, id: string) {
    const w = await this.store.read(workspaceId);
    const candidate = w.approvals.find((a) => a.id === id);
    if (
      candidate?.kind !== "github_repository" ||
      candidate.decision !== "approved"
    )
      return;
    if (candidate.repository) {
      if (
        candidate.repository.state === "sending" &&
        Date.parse(candidate.repository.startedAt) + 60000 < Date.now()
      )
        await this.finish(workspaceId, id, {
          state: "unknown",
          error: "github_repo_outcome_unknown",
        });
      return;
    }
    let app: GitHubApp;
    let userToken: string;
    let payload: RepositoryCreatePayload;
    try {
      payload = checkRepositoryCreateApproval(w, candidate);
      app = await this.app(w.operatorId);
      const {
        installationId,
        ownerType,
        owner,
        ownerId,
        githubUserId,
        githubUserLogin: _,
        ...input
      } = payload;
      const verified = await this.verifyAuthority(
        w,
        candidate.actor,
        app,
        input,
        installationId,
      );
      requireThat(
        verified.ownerType === ownerType &&
          verified.ownerId === ownerId &&
          verified.owner.toLowerCase() === owner.toLowerCase() &&
          verified.githubUserId === githubUserId,
        "approval_stale",
        409,
      );
      userToken = verified.userToken;
    } catch (error) {
      await this.store.change(workspaceId, (current) => {
        const a = current.approvals.find((a) => a.id === id);
        if (a?.decision === "approved" && !a.repository)
          this.fail(current, a, error);
      });
      return;
    }
    const reserved = await this.store.change(
      workspaceId,
      async (current, sql) => {
        const a = current.approvals.find((a) => a.id === id);
        if (a?.decision !== "approved" || a.repository) return false;
        try {
          checkRepositoryCreateApproval(current, a);
          const deployment = await this.store.deployment(sql);
          requireThat(
            deployment.active && !deployment.paused,
            "deployment_paused",
            409,
          );
          a.repository = {
            state: "sending",
            startedAt: new Date().toISOString(),
          };
          audit(current, a.actor, "github.repository_sending", id);
          return true;
        } catch (error) {
          this.fail(current, a, error);
          return false;
        }
      },
    );
    if (!reserved) return;
    try {
      const created = await app.createRepository(userToken, {
        ownerType: payload.ownerType,
        owner: payload.owner,
        name: payload.name,
        description: payload.description,
        visibility: payload.visibility,
        autoInit: payload.autoInit,
        gitignoreTemplate: payload.gitignoreTemplate,
        licenseTemplate: payload.licenseTemplate,
      });
      await this.finish(
        workspaceId,
        id,
        {
          state: "created",
          repositoryId: created.repository.id,
          fullName: created.repository.full_name,
          url: created.url,
        },
        created.repository,
      );
    } catch (error) {
      const code =
        error instanceof Fault ? error.code : "github_repo_outcome_unknown";
      await this.finish(workspaceId, id, {
        state: code === "github_repo_outcome_unknown" ? "unknown" : "failed",
        error: code,
      });
    }
  }

  private fail(w: Workspace, a: Approval, error: unknown) {
    a.repository = {
      state: "failed",
      startedAt: new Date().toISOString(),
      error: error instanceof Fault ? error.code : "github_unavailable",
    };
    this.notify(w, a, false);
  }

  private async finish(
    workspaceId: string,
    id: string,
    result: Omit<NonNullable<Approval["repository"]>, "startedAt">,
    createdRepository?: {
      id: number;
      full_name: string;
      default_branch?: string;
      private?: boolean;
      archived?: boolean;
      disabled?: boolean;
      pushed_at?: string | null;
      updated_at?: string | null;
    },
  ) {
    await this.store.change(workspaceId, async (w, sql) => {
      const a = w.approvals.find((a) => a.id === id);
      if (a?.repository?.state !== "sending") return;
      Object.assign(a.repository, result);
      let syncedToWorkspace = false;
      if (result.state === "created" && createdRepository && w.github) {
        const payload = repositoryCreatePayload.parse(a.payload);
        if (
          w.github.installationId === payload.installationId &&
          w.github.allRepositories
        ) {
          if (
            !w.github.repositories.some((r) => r.id === createdRepository.id)
          ) {
            w.github.connectionRevision = githubConnectionRevision(w.github);
            w.github.repositories.push({
              id: createdRepository.id,
              full_name: createdRepository.full_name,
              ...(createdRepository.default_branch
                ? { default_branch: createdRepository.default_branch }
                : {}),
              ...(createdRepository.private !== undefined
                ? { private: createdRepository.private }
                : {}),
              ...(createdRepository.archived !== undefined
                ? { archived: createdRepository.archived }
                : {}),
              ...(createdRepository.disabled !== undefined
                ? { disabled: createdRepository.disabled }
                : {}),
            });
            w.github.repositoryRevisions ??= {};
            w.github.repositoryRevisions[createdRepository.id] =
              w.github.revision + 1;
            w.github.revision++;
            await sql.query(
              "UPDATE github_user_accounts SET next_sync_at=LEAST(next_sync_at, now()) WHERE workspace_id=$1",
              [w.id],
            );
          }
          syncedToWorkspace = true;
        }
      }
      this.notify(w, a, syncedToWorkspace);
    });
  }

  private notify(w: Workspace, a: Approval, syncedToWorkspace: boolean) {
    audit(w, a.actor, `github.repository_${a.repository?.state}`, a.id);
    const run = w.runs.find((r) => r.id === a.runId);
    if (!run || !runAllowed(w, run)) return;
    const p = repositoryCreatePayload.parse(a.payload);
    const result = a.repository;
    const text =
      result?.state === "created"
        ? syncedToWorkspace
          ? `GitHub repository created: ${result.url}\nAdded to this workspace's connected repositories.`
          : `GitHub repository created: ${result.url}\n\nThis workspace uses selected repositories only; add it in Manage GitHub (or enable auto-sync all repositories) if you want Telo to work on it.`
        : result?.state === "unknown"
          ? `GitHub repository creation outcome is unknown for ${p.owner}/${p.name}. Check GitHub before making a new request; this request will not be retried.`
          : `GitHub repository ${p.owner}/${p.name} was not created. ${repositoryCreateGuidance[result?.error ?? ""] ?? "Access or configuration changed, or GitHub is unavailable. Check permissions and settings before requesting a new proposal."}`;
    deliver(w, a.actor, run.chatId, text, {
      runId: run.id,
      topicId: run.topicId,
      id: `github-repo:${a.id}:result`,
    });
  }
}
