import { describe, expect, test } from "bun:test";
import {
  checkRepositoryCreateApproval,
  evaluateOrgRepoCreationPolicy,
  repositoryCreateInput,
  repositoryCreatePayload,
} from "../../src/github/repositories.ts";
import { fingerprint } from "../../src/setup/credentials.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

describe("GitHub repository creation policy & validation", () => {
  test("repositoryCreateInput validates names, visibility default and optional fields", () => {
    const parsed = repositoryCreateInput.parse({
      name: "  my-new_repo.v1  ",
      description: "  Service repo  ",
      revision: 1,
    });
    expect(parsed).toEqual({
      name: "my-new_repo.v1",
      description: "Service repo",
      visibility: "private",
      revision: 1,
    });
    expect(
      repositoryCreateInput.parse({
        name: "blank-desc",
        description: "   ",
        visibility: "public",
        autoInit: true,
        gitignoreTemplate: "Node",
        licenseTemplate: "mit",
        revision: 2,
      }),
    ).toEqual({
      name: "blank-desc",
      description: undefined,
      visibility: "public",
      autoInit: true,
      gitignoreTemplate: "Node",
      licenseTemplate: "mit",
      revision: 2,
    });
    for (const invalid of [
      ".",
      "..",
      "",
      "   ",
      "owner/repo",
      "bad name",
      "a".repeat(101),
    ])
      expect(() =>
        repositoryCreateInput.parse({ name: invalid, revision: 1 }),
      ).toThrow();
    expect(() =>
      repositoryCreateInput.parse({
        name: "ok",
        gitignoreTemplate: "../secret",
        revision: 1,
      }),
    ).toThrow();
    expect(() =>
      repositoryCreateInput.parse({
        name: "ok",
        licenseTemplate: "mit/../../etc",
        revision: 1,
      }),
    ).toThrow();
  });

  test("evaluateOrgRepoCreationPolicy allows org admins regardless of base member restrictions", () => {
    const lockedDown = {
      members_can_create_repositories: false,
      members_can_create_public_repositories: false,
      members_can_create_private_repositories: false,
      members_can_create_internal_repositories: false,
      members_allowed_repository_creation_type: "none" as const,
    };
    expect(evaluateOrgRepoCreationPolicy(lockedDown, "admin", "public")).toBe(
      true,
    );
    expect(evaluateOrgRepoCreationPolicy(lockedDown, "admin", "private")).toBe(
      true,
    );
    expect(evaluateOrgRepoCreationPolicy(lockedDown, "admin", "internal")).toBe(
      true,
    );
  });

  test("evaluateOrgRepoCreationPolicy enforces org member repository creation setup", () => {
    expect(
      evaluateOrgRepoCreationPolicy(
        { members_can_create_repositories: false },
        "member",
        "private",
      ),
    ).toBe(false);
    expect(
      evaluateOrgRepoCreationPolicy(
        { members_can_create_repositories: false },
        "member",
        "public",
      ),
    ).toBe(false);
    expect(
      evaluateOrgRepoCreationPolicy(
        {
          members_can_create_repositories: true,
          members_can_create_public_repositories: false,
          members_can_create_private_repositories: true,
          members_can_create_internal_repositories: false,
        },
        "member",
        "public",
      ),
    ).toBe(false);
    expect(
      evaluateOrgRepoCreationPolicy(
        {
          members_can_create_repositories: true,
          members_can_create_public_repositories: false,
          members_can_create_private_repositories: true,
          members_can_create_internal_repositories: false,
        },
        "member",
        "private",
      ),
    ).toBe(true);
    expect(
      evaluateOrgRepoCreationPolicy(
        {
          members_can_create_repositories: true,
          members_can_create_public_repositories: false,
          members_can_create_private_repositories: true,
          members_can_create_internal_repositories: false,
        },
        "member",
        "internal",
      ),
    ).toBe(false);
    expect(
      evaluateOrgRepoCreationPolicy(
        { members_allowed_repository_creation_type: "private" },
        "member",
        "public",
      ),
    ).toBe(false);
    expect(
      evaluateOrgRepoCreationPolicy(
        { members_allowed_repository_creation_type: "private" },
        "member",
        "private",
      ),
    ).toBe(true);
    expect(
      evaluateOrgRepoCreationPolicy(
        { members_allowed_repository_creation_type: "none" },
        "member",
        "private",
      ),
    ).toBe(false);
    // When GitHub omits admin-only fields for non-owner members, defer to GitHub's POST check.
    expect(evaluateOrgRepoCreationPolicy({}, "member", "private")).toBe(true);
    expect(evaluateOrgRepoCreationPolicy({}, "member", "public")).toBe(true);
  });

  test("checkRepositoryCreateApproval enforces hash, expiry, scope, chat boundary and linked identity", () => {
    const w = workspace();
    w.github = {
      revision: 2,
      connectionRevision: 1,
      installationId: 501,
      account: "alice",
      repositories: [],
    };
    const member = w.members.find((m) => m.id === "101");
    if (!member) throw new Error("missing fixture member");
    member.github = {
      id: 42,
      login: "alice",
      status: "connected",
      connectionRevision: 2,
      syncedAt: new Date().toISOString(),
      repositories: [],
    };
    const run = createRun(w, "101", "Create repo", "101", 0, "gpt-4.1-mini");
    run.status = "running";
    const payload = repositoryCreatePayload.parse({
      name: "demo",
      visibility: "private",
      revision: 1,
      installationId: 501,
      ownerType: "personal",
      owner: "alice",
      ownerId: 42,
      githubUserId: 42,
      githubUserLogin: "alice",
    });
    const approval = {
      id: "a1",
      actor: "101",
      runId: run.id,
      kind: "github_repository" as const,
      target: `${run.id}:call1`,
      version: 1,
      payload,
      hash: fingerprint(payload),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    // Metadata-only revision bump (connectionRevision stayed 1) keeps approval valid.
    expect(checkRepositoryCreateApproval(w, approval).name).toBe("demo");

    // Reconnect (connectionRevision advanced past approval revision) invalidates it.
    w.github.connectionRevision = 2;
    expect(() => checkRepositoryCreateApproval(w, approval)).toThrow(
      "approval_stale",
    );
    w.github.connectionRevision = 1;

    // Disconnecting member's GitHub account denies it.
    member.github.status = "disconnected";
    expect(() => checkRepositoryCreateApproval(w, approval)).toThrow(
      "github_user_connection_required",
    );
    member.github.status = "connected";

    // Switching linked GitHub identity denies it.
    member.github.id = 99;
    expect(() => checkRepositoryCreateApproval(w, approval)).toThrow(
      "github_identity_changed",
    );
    member.github.id = 42;

    // Group chat cannot create private repository.
    run.chatId = "-1001234";
    w.chats.push({
      id: "-1001234",
      active: true,
      collection: true,
      linkedAt: new Date().toISOString(),
      visibleAll: true,
    });
    expect(() => checkRepositoryCreateApproval(w, approval)).toThrow(
      "github_repo_private_chat_required",
    );
  });
});
