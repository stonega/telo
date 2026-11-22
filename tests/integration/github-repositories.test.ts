import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { requireThat, type Workspace } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubExtension } from "../../src/github/extension.ts";
import { GitHubRepositories } from "../../src/github/repositories.ts";
import { invalidateGitHubWork } from "../../src/github/user-access.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { decide } from "../../src/workflows/service.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("GitHub repository creation", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `telo_repos_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  const key = "ab".repeat(32);
  let store: Store;

  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url ?? "");
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'repos','unused',true)",
      [operatorId],
    );
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(data,'{active}','true')",
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });

  const signal = () => new AbortController().signal;
  const guard = async () => {};

  async function linkUserAccount(
    workspaceId: string,
    actor: string,
    githubId: number,
    userToken: string,
    options: {
      refreshToken?: string;
      expiresAt?: string;
      appId?: number;
    } = {},
  ) {
    const scope = `github-user:${workspaceId}:${actor}`;
    await store.pool.query(
      `INSERT INTO github_user_accounts(workspace_id,actor,github_id,app_id,user_token,refresh_token,token_expires_at,next_sync_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')
       ON CONFLICT(workspace_id,actor) DO UPDATE SET github_id=EXCLUDED.github_id,app_id=EXCLUDED.app_id,user_token=EXCLUDED.user_token,refresh_token=EXCLUDED.refresh_token,token_expires_at=EXCLUDED.token_expires_at,next_sync_at=EXCLUDED.next_sync_at`,
      [
        workspaceId,
        actor,
        githubId,
        options.appId ?? githubFixtureConfig.id,
        encrypt(key, scope, userToken),
        options.refreshToken
          ? encrypt(key, `${scope}:refresh`, options.refreshToken)
          : null,
        options.expiresAt ?? null,
      ],
    );
  }

  async function fixture(
    options: {
      actor?: string;
      actorRole?: "owner" | "admin" | "member";
      chatId?: string;
      account?: string;
      allRepositories?: boolean;
      repositories?: { id: number; full_name: string; private?: boolean }[];
      githubUser?: { id: number; login: string; token: string } | null;
      refreshToken?: string;
      tokenExpiresAt?: string;
    } = {},
  ) {
    const actor = options.actor ?? "101";
    const chatId = options.chatId ?? actor;
    const w = workspace();
    w.operatorId = operatorId;
    if (actor !== "101") {
      w.members.push({
        id: actor,
        role: options.actorRole ?? "member",
        active: true,
      });
    } else if (options.actorRole) {
      requireThat(w.members[0], "missing owner");
      w.members[0].role = options.actorRole;
    }
    if (chatId !== actor) {
      w.chats.push({
        id: chatId,
        active: true,
        collection: true,
        linkedAt: new Date().toISOString(),
        visibleAll: true,
      });
    }
    w.github = {
      revision: 1,
      installationId: 501,
      account: options.account ?? "example",
      ...(options.allRepositories ? { allRepositories: true } : {}),
      repositories: options.repositories ?? [
        { id: 7001, full_name: "example/workspace", private: true },
      ],
    };
    const member = w.members.find((m) => m.id === actor);
    requireThat(member, "missing member");
    const ghUser =
      options.githubUser === undefined
        ? { id: 42, login: "alice", token: "ghu_alice_secret" }
        : options.githubUser;
    if (ghUser) {
      member.github = {
        id: ghUser.id,
        login: ghUser.login,
        status: "connected",
        connectionRevision: 1,
        syncedAt: new Date().toISOString(),
        repositories: [],
      };
    }
    const run = createRun(
      w,
      actor,
      "Create a new repo",
      chatId,
      3,
      "gpt-4.1-mini",
    );
    run.status = "running";
    run.fence = 1;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    if (ghUser) {
      await linkUserAccount(w.id, actor, ghUser.id, ghUser.token, {
        refreshToken: options.refreshToken,
        expiresAt: options.tokenExpiresAt,
      });
    }
    return { w, run, actor };
  }

  function provider(
    options: {
      accountType?: "User" | "Organization";
      accountId?: number;
      accountLogin?: string;
      installationPermissions?: Record<string, string>;
      usersByToken?: Record<string, { id: number; login: string }>;
      membershipByToken?: Record<
        string,
        { state: "active" | "pending"; role: "admin" | "member" } | number
      >;
      orgPolicy?: Record<string, unknown>;
      refreshResponse?: {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      onCreate?: (
        url: string,
        init: RequestInit,
      ) => Promise<Response> | Response;
    } = {},
  ) {
    const requests: { url: string; init: RequestInit }[] = [];
    const accountType = options.accountType ?? "Organization";
    const accountId = options.accountId ?? (accountType === "User" ? 42 : 100);
    const accountLogin =
      options.accountLogin ?? (accountType === "User" ? "alice" : "example");
    const usersByToken: Record<string, { id: number; login: string }> = {
      ghu_alice_secret: { id: 42, login: "alice" },
      ghu_bob_secret: { id: 43, login: "bob" },
      ghu_rotated_secret: { id: 42, login: "alice" },
      ...options.usersByToken,
    };
    const fallback = githubTransport();
    const app = new GitHubApp(githubFixtureConfig, (async (
      input,
      init = {},
    ) => {
      const targetUrl = String(input);
      requests.push({ url: targetUrl, init });
      const authHeader = String(
        (init.headers as Record<string, string> | undefined)?.authorization ??
          "",
      );
      const bearer = authHeader.replace(/^Bearer\s+/i, "");

      if (targetUrl === "https://api.github.com/app/installations/501") {
        return Response.json({
          id: 501,
          app_id: githubFixtureConfig.id,
          account: { id: accountId, login: accountLogin, type: accountType },
          suspended_at: null,
          permissions: options.installationPermissions ?? {
            members: "read",
            repository_creation: "write",
          },
        });
      }
      if (targetUrl === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init.body));
        if (body.grant_type === "refresh_token" && options.refreshResponse) {
          return Response.json(options.refreshResponse);
        }
      }
      if (targetUrl === "https://api.github.com/user") {
        const u = usersByToken[bearer];
        if (!u)
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json(u);
      }
      if (
        targetUrl ===
        `https://api.github.com/user/memberships/orgs/${accountLogin}`
      ) {
        const m = options.membershipByToken?.[bearer];
        if (typeof m === "number")
          return Response.json({ message: "Not Found" }, { status: m });
        if (m) return Response.json(m);
        return Response.json({ state: "active", role: "member" });
      }
      if (targetUrl === `https://api.github.com/orgs/${accountLogin}`) {
        return Response.json({
          id: accountId,
          login: accountLogin,
          ...options.orgPolicy,
        });
      }
      if (
        init.method === "POST" &&
        (targetUrl === "https://api.github.com/user/repos" ||
          targetUrl === `https://api.github.com/orgs/${accountLogin}/repos`)
      ) {
        if (options.onCreate) return options.onCreate(targetUrl, init);
        const body = JSON.parse(String(init.body));
        return Response.json(
          {
            id: 9001,
            full_name: `${accountLogin}/${body.name}`,
            default_branch: "main",
            private: body.private ?? true,
            archived: false,
            disabled: false,
          },
          { status: 201 },
        );
      }
      return fallback(input, init);
    }) as typeof fetch);

    return {
      app,
      requests,
      service: new GitHubRepositories(store, app, key),
      creates: () =>
        requests.filter(
          (r) =>
            r.init.method === "POST" &&
            (r.url.endsWith("/user/repos") || r.url.endsWith("/repos")),
        ),
    };
  }

  const savedApproval = async (workspaceId: string, id: string) =>
    (await store.read(workspaceId)).approvals.find((a) => a.id === id);

  const approve = (workspaceId: string, actor: string, id: string) =>
    store.change(workspaceId, (w) => decide(w, actor, id, true));

  test("personal account: only the connected personal account owner can propose and create a repo via POST /user/repos", async () => {
    const f = await fixture({
      account: "alice",
      allRepositories: true,
      githubUser: { id: 42, login: "alice", token: "ghu_alice_secret" },
    });
    const p = provider({
      accountType: "User",
      accountId: 42,
      accountLogin: "alice",
    });

    const id = await p.service.propose(
      f.w.id,
      f.run.id,
      "call1",
      {
        name: "my-personal-tool",
        description: "Personal helper",
        visibility: "private",
        autoInit: true,
        gitignoreTemplate: "Node",
        licenseTemplate: "mit",
      },
      1,
      signal(),
      guard,
    );
    expect(p.creates()).toHaveLength(0);
    const review = (await store.read(f.w.id)).deliveries[0];
    expect(review?.text).toContain(
      "Create GitHub repository alice/my-personal-tool?",
    );
    expect(review?.text).toContain("Owner: alice (Personal account)");
    expect(review?.text).toContain("Visibility: private");
    expect(review?.text).toContain("Initialize with README: yes");
    expect(review?.buttons?.[0]?.map((b) => b.text)).toEqual([
      "Approve",
      "Reject",
    ]);

    // Before approval, send is a no-op.
    await p.service.send(f.w.id, id);
    expect(p.creates()).toHaveLength(0);

    await approve(f.w.id, f.actor, id);
    await Promise.all([p.service.send(f.w.id, id), p.service.send(f.w.id, id)]);
    expect(p.creates()).toHaveLength(1);
    const createReq = p.creates()[0];
    expect(createReq?.url).toBe("https://api.github.com/user/repos");
    expect(
      (createReq?.init.headers as Record<string, string>)?.authorization,
    ).toBe("Bearer ghu_alice_secret");
    expect(JSON.parse(String(createReq?.init.body))).toEqual({
      name: "my-personal-tool",
      description: "Personal helper",
      private: true,
      auto_init: true,
      gitignore_template: "Node",
      license_template: "mit",
    });

    const after = await store.read(f.w.id);
    const approval = after.approvals.find((a) => a.id === id);
    expect(approval?.repository).toMatchObject({
      state: "created",
      repositoryId: 9001,
      fullName: "alice/my-personal-tool",
      url: "https://github.com/alice/my-personal-tool",
    });
    // allRepositories=true immediately adds the created repo to workspace repositories.
    expect(after.github?.repositories.map((r) => r.full_name)).toContain(
      "alice/my-personal-tool",
    );
    expect(after.deliveries.at(-1)?.text).toContain(
      "https://github.com/alice/my-personal-tool",
    );
    expect(after.deliveries.at(-1)?.text).toContain(
      "Added to this workspace's connected repositories",
    );
    expect(JSON.stringify(after)).not.toContain("ghu_alice_secret");
  });

  test("personal account: another workspace member (even admin) cannot create a repo in alice's personal account, and internal visibility is rejected", async () => {
    const f = await fixture({
      actor: "202",
      actorRole: "admin",
      account: "alice",
      githubUser: { id: 43, login: "bob", token: "ghu_bob_secret" },
    });
    const p = provider({
      accountType: "User",
      accountId: 42,
      accountLogin: "alice",
    });
    await expect(
      p.service.propose(
        f.w.id,
        f.run.id,
        "call1",
        { name: "hijack", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_repo_create_owner_required" });
    expect(p.creates()).toHaveLength(0);

    const ownerFixture = await fixture({
      account: "alice",
      githubUser: { id: 42, login: "alice", token: "ghu_alice_secret" },
    });
    await expect(
      p.service.propose(
        ownerFixture.w.id,
        ownerFixture.run.id,
        "call1",
        { name: "bad-vis", visibility: "internal" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_repo_invalid_visibility" });
  });

  test("organization: org owner can create repos even when members_can_create_repositories is false", async () => {
    const f = await fixture({
      actor: "202",
      actorRole: "member", // Ordinary Telo member, but GitHub Org owner!
      account: "example",
      allRepositories: false, // Selected-only workspace
      githubUser: { id: 42, login: "alice", token: "ghu_alice_secret" },
    });
    const p = provider({
      accountType: "Organization",
      accountId: 100,
      accountLogin: "example",
      membershipByToken: {
        ghu_alice_secret: { state: "active", role: "admin" },
      },
      orgPolicy: {
        members_can_create_repositories: false,
        members_can_create_public_repositories: false,
        members_can_create_private_repositories: false,
      },
    });
    const id = await p.service.propose(
      f.w.id,
      f.run.id,
      "call1",
      { name: "org-platform", visibility: "public" },
      1,
      signal(),
      guard,
    );
    await approve(f.w.id, f.actor, id);
    await p.service.send(f.w.id, id);

    expect(p.creates()).toHaveLength(1);
    expect(p.creates()[0]?.url).toBe(
      "https://api.github.com/orgs/example/repos",
    );
    expect(
      (p.creates()[0]?.init.headers as Record<string, string>)?.authorization,
    ).toBe("Bearer ghu_alice_secret");
    expect(JSON.parse(String(p.creates()[0]?.init.body))).toEqual({
      name: "org-platform",
      visibility: "public",
      private: false,
    });
    const after = await store.read(f.w.id);
    // Selected-only workspace does NOT silently widen selected repositories.
    expect(after.github?.repositories.map((r) => r.full_name)).toEqual([
      "example/workspace",
    ]);
    expect(after.deliveries.at(-1)?.text).toContain(
      "This workspace uses selected repositories only",
    );
  });

  test("organization: regular org member follows org permission setup (private allowed, public denied, disabled denied)", async () => {
    // Even a Telo workspace owner must follow GitHub org permission setup.
    const f = await fixture({
      actor: "101",
      actorRole: "owner",
      account: "example",
      githubUser: { id: 43, login: "bob", token: "ghu_bob_secret" },
    });
    const privateOnlyOrg = provider({
      accountType: "Organization",
      accountId: 100,
      accountLogin: "example",
      membershipByToken: {
        ghu_bob_secret: { state: "active", role: "member" },
      },
      orgPolicy: {
        members_can_create_repositories: true,
        members_can_create_public_repositories: false,
        members_can_create_private_repositories: true,
        members_can_create_internal_repositories: false,
      },
    });
    // Public repo denied by org policy before approval.
    await expect(
      privateOnlyOrg.service.propose(
        f.w.id,
        f.run.id,
        "call-pub",
        { name: "public-nope", visibility: "public" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_org_repo_creation_denied" });
    // Private repo allowed by org policy.
    const id = await privateOnlyOrg.service.propose(
      f.w.id,
      f.run.id,
      "call-priv",
      { name: "private-ok", visibility: "private" },
      1,
      signal(),
      guard,
    );
    await approve(f.w.id, f.actor, id);
    await privateOnlyOrg.service.send(f.w.id, id);
    expect((await savedApproval(f.w.id, id))?.repository?.state).toBe(
      "created",
    );

    // When org disables member creation completely, member is denied.
    const f2 = await fixture({
      actor: "202",
      actorRole: "member",
      account: "example",
      githubUser: { id: 43, login: "bob", token: "ghu_bob_secret" },
    });
    const disabledOrg = provider({
      accountType: "Organization",
      accountId: 100,
      accountLogin: "example",
      membershipByToken: {
        ghu_bob_secret: { state: "active", role: "member" },
      },
      orgPolicy: {
        members_can_create_repositories: false,
      },
    });
    await expect(
      disabledOrg.service.propose(
        f2.w.id,
        f2.run.id,
        "call1",
        { name: "blocked", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_org_repo_creation_denied" });
  });

  test("organization: non-members/pending members are rejected; when GitHub omits admin fields, POST with user token enforces org policy", async () => {
    const fOutside = await fixture({
      account: "example",
      githubUser: { id: 43, login: "bob", token: "ghu_bob_secret" },
    });
    const outsideProvider = provider({
      accountType: "Organization",
      accountLogin: "example",
      membershipByToken: { ghu_bob_secret: 404 },
    });
    await expect(
      outsideProvider.service.propose(
        fOutside.w.id,
        fOutside.run.id,
        "call1",
        { name: "outside", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_org_membership_required" });

    const pendingProvider = provider({
      accountType: "Organization",
      accountLogin: "example",
      membershipByToken: {
        ghu_bob_secret: { state: "pending", role: "member" },
      },
    });
    await expect(
      pendingProvider.service.propose(
        fOutside.w.id,
        fOutside.run.id,
        "call2",
        { name: "pending", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_org_membership_required" });

    // Org omits members_can_create_* for regular member -> proposal succeeds, GitHub rejects POST with 403.
    const fOmitted = await fixture({
      account: "example",
      githubUser: { id: 43, login: "bob", token: "ghu_bob_secret" },
    });
    const githubEnforced = provider({
      accountType: "Organization",
      accountLogin: "example",
      membershipByToken: {
        ghu_bob_secret: { state: "active", role: "member" },
      },
      orgPolicy: {}, // omitted by GitHub for non-owner
      onCreate: () =>
        Response.json(
          {
            message:
              "Members are not allowed to create repositories in this organization.",
          },
          { status: 403 },
        ),
    });
    const id = await githubEnforced.service.propose(
      fOmitted.w.id,
      fOmitted.run.id,
      "call1",
      { name: "rejected-by-github", visibility: "private" },
      1,
      signal(),
      guard,
    );
    await approve(fOmitted.w.id, fOmitted.actor, id);
    await githubEnforced.service.send(fOmitted.w.id, id);
    expect((await savedApproval(fOmitted.w.id, id))?.repository).toMatchObject({
      state: "failed",
      error: "github_org_repo_creation_denied",
    });
  });

  test("missing GitHub user connection, missing App permission, token rotation and 422/500 error handling", async () => {
    // 1. Unlinked user -> github_user_connection_required
    const fUnlinked = await fixture({ githubUser: null });
    const pDefault = provider();
    await expect(
      pDefault.service.propose(
        fUnlinked.w.id,
        fUnlinked.run.id,
        "call1",
        { name: "unlinked", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_user_connection_required" });

    // 2. Installation missing repository_creation / administration write -> github_app_permissions_missing
    const fNoPerm = await fixture();
    const pNoPerm = provider({
      installationPermissions: {
        contents: "write",
        metadata: "read",
        members: "read",
      },
    });
    await expect(
      pNoPerm.service.propose(
        fNoPerm.w.id,
        fNoPerm.run.id,
        "call1",
        { name: "no-perm", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_app_permissions_missing" });

    // 3. Existing App with administration: write (instead of repository_creation: write) is also accepted,
    //    and expiring user token rotates cleanly!
    const fRotate = await fixture({
      account: "alice",
      githubUser: { id: 42, login: "alice", token: "ghu_expired_token" },
      refreshToken: "ghr_refresh_secret",
      tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const pRotate = provider({
      accountType: "User",
      accountId: 42,
      accountLogin: "alice",
      installationPermissions: { administration: "write" },
      refreshResponse: {
        access_token: "ghu_rotated_secret",
        refresh_token: "ghr_rotated_next",
        expires_in: 3600,
      },
    });
    const rotateId = await pRotate.service.propose(
      fRotate.w.id,
      fRotate.run.id,
      "call1",
      { name: "rotated-repo", visibility: "private" },
      1,
      signal(),
      guard,
    );
    await approve(fRotate.w.id, fRotate.actor, rotateId);
    await pRotate.service.send(fRotate.w.id, rotateId);
    expect(
      (await savedApproval(fRotate.w.id, rotateId))?.repository?.state,
    ).toBe("created");
    expect(
      (pRotate.creates()[0]?.init.headers as Record<string, string>)
        ?.authorization,
    ).toBe("Bearer ghu_rotated_secret");

    // 4. 422 already exists -> github_repo_already_exists; 500 -> unknown (no retry)
    const fExists = await fixture();
    const pExists = provider({
      onCreate: () =>
        Response.json(
          {
            message: "Repository creation failed.",
            errors: [{ message: "name already exists on this account" }],
          },
          { status: 422 },
        ),
    });
    const existsId = await pExists.service.propose(
      fExists.w.id,
      fExists.run.id,
      "call1",
      { name: "duplicate", visibility: "private" },
      1,
      signal(),
      guard,
    );
    await approve(fExists.w.id, fExists.actor, existsId);
    await pExists.service.send(fExists.w.id, existsId);
    expect(
      (await savedApproval(fExists.w.id, existsId))?.repository,
    ).toMatchObject({
      state: "failed",
      error: "github_repo_already_exists",
    });

    const fUnknown = await fixture();
    const pUnknown = provider({
      onCreate: () => Response.json({ message: "boom" }, { status: 500 }),
    });
    const unknownId = await pUnknown.service.propose(
      fUnknown.w.id,
      fUnknown.run.id,
      "call1",
      { name: "uncertain", visibility: "private" },
      1,
      signal(),
      guard,
    );
    await approve(fUnknown.w.id, fUnknown.actor, unknownId);
    await pUnknown.service.send(fUnknown.w.id, unknownId);
    await pUnknown.service.send(fUnknown.w.id, unknownId);
    expect(pUnknown.creates()).toHaveLength(1);
    expect(
      (await savedApproval(fUnknown.w.id, unknownId))?.repository,
    ).toMatchObject({
      state: "unknown",
      error: "github_repo_outcome_unknown",
    });
  });

  test("extension exposes propose_github_repository even with 0 connected repositories and returns structured guidance on policy denial", async () => {
    const f = await fixture({
      account: "alice",
      repositories: [],
      githubUser: null,
    });
    const p = provider({
      accountType: "User",
      accountId: 42,
      accountLogin: "alice",
    });
    requireThat(f.w.github, "missing github");
    const input: AgentInput = {
      workspaceId: f.w.id,
      actor: f.actor,
      runId: f.run.id,
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fake",
      system: "",
      prompt: "",
      transcript: [],
      tools: [],
      maxTurns: 1,
      maxTools: 2,
      signal: signal(),
      guard,
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    const catalog = ExtensionCatalog.fromSnapshot(
      [],
      [
        githubExtension(
          store,
          f.w.id,
          f.w.github,
          undefined,
          undefined,
          p.service,
        ),
      ],
    );
    const host = await catalog.open(input);
    try {
      expect(host?.tools.map((t) => t.name)).toEqual([
        "propose_github_repository",
      ]);
      const tool = host?.tools[0];
      requireThat(tool, "missing tool");
      const result = await tool.execute(
        "call1",
        { name: "first-repo", visibility: "private" },
        input.signal,
      );
      const parsed = JSON.parse(
        (result.content[0] as { text: string }).text,
      ) as { status: string; reason: string; guidance: string };
      expect(parsed.status).toBe("not_proposed");
      expect(parsed.reason).toBe("github_user_connection_required");
      expect(parsed.guidance).toContain("/github");
    } finally {
      await host?.close();
    }

    // PluginService also wires propose_github_repository with 0 repos and zero startup network calls.
    const plugins = new PluginService({
      store,
      githubApp: p.app,
      encryptionKey: key,
    });
    const runner = await plugins.runner(await store.deployment(), f.w.id);
    expect(runner).toBeDefined();
    expect(p.requests).toHaveLength(0);
  });

  test("disconnect/invalidation, group private boundary and scheduled run boundary block repository creation", async () => {
    // Private repo in group chat is denied; public repo in group chat is allowed.
    const fGroup = await fixture({
      chatId: "-100999",
      account: "alice",
      githubUser: { id: 42, login: "alice", token: "ghu_alice_secret" },
    });
    const pPersonal = provider({
      accountType: "User",
      accountId: 42,
      accountLogin: "alice",
    });
    await expect(
      pPersonal.service.propose(
        fGroup.w.id,
        fGroup.run.id,
        "call-priv",
        { name: "secret-in-group", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "github_repo_private_chat_required" });

    const pubId = await pPersonal.service.propose(
      fGroup.w.id,
      fGroup.run.id,
      "call-pub",
      { name: "public-in-group", visibility: "public" },
      1,
      signal(),
      guard,
    );
    // invalidateGitHubWork revokes pending github_repository approval.
    await store.change(fGroup.w.id, (w: Workspace) => {
      invalidateGitHubWork(w, fGroup.actor);
    });
    expect((await savedApproval(fGroup.w.id, pubId))?.decision).toBe("revoked");

    // Scheduled runs cannot propose repository creation.
    const fWorkflow = await fixture({
      account: "alice",
      githubUser: { id: 42, login: "alice", token: "ghu_alice_secret" },
    });
    await store.change(fWorkflow.w.id, (w) => {
      requireThat(w.runs[0], "missing run");
      w.runs[0].workflowId = "wf-1";
    });
    await expect(
      pPersonal.service.propose(
        fWorkflow.w.id,
        fWorkflow.run.id,
        "call1",
        { name: "scheduled-nope", visibility: "private" },
        1,
        signal(),
        guard,
      ),
    ).rejects.toMatchObject({ code: "tool_policy_denied" });
  });
});
