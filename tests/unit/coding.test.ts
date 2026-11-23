import { expect, test } from "bun:test";
import { branchName, codingPayload } from "../../src/coding/config.ts";
import {
  type DevelopmentTask,
  developmentPullClosed,
  developmentTaskSettled,
} from "../../src/coding/development.ts";
import {
  codingStatusLabel,
  developmentStatus,
} from "../../src/coding/feedback.ts";
import {
  checkCodingPayload,
  codingDestination,
} from "../../src/coding/policy.ts";
import { codingView, saveCoding } from "../../src/coding/service.ts";
import { syncWorkspaceCodingPullStates } from "../../src/coding/task-store.ts";
import type { Sql } from "../../src/db/pool.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { decrypt } from "../../src/setup/credentials.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

export function codingFixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      { id: 7001, full_name: "example/workspace", default_branch: "develop" },
    ],
  };
  w.coding = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
    },
  };

  grantGitHubAccess(w, ["101"]);
  const run = createRun(
    w,
    "101",
    "Implement a bug fix",
    "101",
    0,
    "gpt-4.1-mini",
  );
  run.status = "running";
  return { w, run };
}
const input = {
  repositoryId: 7001,
  title: "Fix recap",
  body: "Include the last message. Add regression tests.",
};
test("coding scope survives unrelated metadata only after fresh verified access", () => {
  const { w } = codingFixture();
  const payload = codingDestination(w, "101", input);
  const connection = present(w.github);
  connection.connectionRevision = 1;
  connection.revision = 2;
  connection.repositoryRevisions = { "7002": 2 };
  expect(() => checkCodingPayload(w, "101", payload)).toThrow(
    "github_user_access_unavailable",
  );
  grantGitHubAccess(w, ["101"]);
  checkCodingPayload(w, "101", payload);
  expect(payload.githubRevision).toBe(1);
  expect(codingPayload.parse(payload)).toEqual(payload);
});
for (const change of [
  "visibility",
  "branch",
  "rename",
  "installation",
  "reconnect",
  "target-generation",
  "coding-settings",
] as const) {
  test(`coding scope rejects target ${change} changes`, () => {
    const { w } = codingFixture();
    const payload = codingDestination(w, "101", input);
    const connection = present(w.github);
    const repo = present(connection.repositories[0]);
    if (change === "visibility") repo.private = true;
    if (change === "branch") repo.default_branch = "main";
    if (change === "rename") repo.full_name = "example/renamed";
    if (change === "installation") connection.installationId = 502;
    if (change === "reconnect") connection.revision++;
    if (change === "target-generation") {
      connection.connectionRevision = 1;
      connection.revision++;
      connection.repositoryRevisions = { "7001": 2 };
    }
    if (change === "coding-settings") present(w.coding).revision++;
    grantGitHubAccess(w, ["101"]);
    expect(() => checkCodingPayload(w, "101", payload)).toThrow(
      "coding_configuration_changed",
    );
  });
}
for (const change of [
  "remove",
  "archive",
  "disable",
  "permission",
  "actor",
] as const) {
  test(`coding scope still denies ${change}`, () => {
    const { w } = codingFixture();
    const payload = codingDestination(w, "101", input);
    const connection = present(w.github);
    const repo = present(connection.repositories[0]);
    if (change === "remove") connection.repositories = [];
    if (change === "archive") repo.archived = true;
    if (change === "disable") repo.disabled = true;
    if (change === "permission")
      present(w.members.find((m) => m.id === "101")?.github).repositories = [];
    if (change === "actor")
      present(w.members.find((m) => m.id === "101")).active = false;
    expect(() => checkCodingPayload(w, "101", payload)).toThrow();
  });
}
test("historical coding grants retain their global revision boundary", () => {
  const { w } = codingFixture();
  const payload = codingDestination(w, "101", input);
  delete payload.githubScope;
  checkCodingPayload(w, "101", payload);
  const connection = present(w.github);
  connection.connectionRevision = 1;
  connection.revision++;
  connection.repositoryRevisions = { "7002": 2 };
  grantGitHubAccess(w, ["101"]);
  expect(() => checkCodingPayload(w, "101", payload)).toThrow(
    "coding_configuration_changed",
  );
});
test("a target refresh stops the grant before a pending permission sync", () => {
  const { w } = codingFixture();
  const payload = codingDestination(w, "101", input);
  const connection = present(w.github);
  connection.connectionRevision = 1;
  connection.revision++;
  connection.repositoryRevisions = { "7001": 2 };
  expect(() => checkCodingPayload(w, "101", payload)).toThrow(
    "coding_configuration_changed",
  );
});
test("reading and saving Codex settings cannot retain a publication opt-out", () => {
  const { w } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const settings = {
    ...present(w.coding).settings,
    development: { publishByDefault: false },
  };
  present(w.coding).settings = settings;
  expect(codingView(w, admin).settings.development?.publishByDefault).toBe(
    true,
  );
  const saved = saveCoding(w, admin, { revision: 1, settings });
  expect(saved.settings.development?.publishByDefault).toBe(true);
  expect(w.coding?.settings.development?.publishByDefault).toBe(true);
});
test("legacy Actions settings cannot authorize a new coding task", () => {
  const { w } = codingFixture();
  (present(w.coding).settings as { backend: string }).backend =
    "github-actions";
  expect(() => codingDestination(w, "101", input)).toThrow(
    "coding_local_configuration_required",
  );
});
test("legacy settings discard operator commands and allow autonomous execution", () => {
  const { w } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const legacy = present(w.coding).settings;
  (legacy as { backend: string }).backend = "github-actions";
  Object.assign(legacy, {
    repositories: [
      {
        repositoryId: 7001,
        baseBranch: "old",
        maintainers: ["999"],
        workflowFile: "telo-codex.yml",
        setupCommand: "exit 91",
        checkCommand: "exit 92",
      },
    ],
  });
  const page = codingView(w, admin);
  expect(page.legacyActionsConfiguration).toBe(true);
  expect(page.settings).not.toHaveProperty("repositories");
  expect(page.settings).not.toHaveProperty("setupCommand");
  expect(page.settings).not.toHaveProperty("checkCommand");
  const saved = saveCoding(w, admin, {
    revision: page.revision,
    settings: page.settings,
  });
  expect(saved.settings.enabled).toBe(true);
  expect(saved.legacyActionsConfiguration).toBe(false);
  expect(codingDestination(w, "101", input)).not.toHaveProperty("checkCommand");
});
test("repository saves discard obsolete command overrides from older clients", () => {
  const { w } = codingFixture();
  const settings = structuredClone(present(w.coding).settings);
  Object.assign(settings, {
    repositories: [
      {
        repositoryId: 7001,
        baseBranch: "old",
        maintainers: ["999"],
        setupCommand: "exit 91",
        checkCommand: "exit 92",
      },
    ],
  });
  const saved = saveCoding(
    w,
    { id: w.operatorId, operator: true, username: "operator" },
    { revision: 1, settings },
  );
  expect(saved.settings).not.toHaveProperty("repositories");
  expect(saved.settings).not.toHaveProperty("setupCommand");
  expect(saved.settings).not.toHaveProperty("checkCommand");
  expect(codingDestination(w, "101", input)).not.toHaveProperty("checkCommand");
});
test("coding requires verified GitHub access; workspace admin is not an implicit grant", () => {
  const { w } = codingFixture();
  for (const actor of ["202", "303"])
    expect(() => codingDestination(w, actor, input)).toThrow(
      "github_user_connection_required",
    );
  expect(() =>
    codingDestination(w, "101", { ...input, repositoryId: 7002 }),
  ).toThrow();
  w.members.forEach((member) => {
    member.active = false;
  });
  expect(() => codingDestination(w, "101", input)).toThrow("access_denied");
});
test("device auth uses connected repositories regardless of visibility", () => {
  const { w } = codingFixture();
  present(w.coding).settings.authMode = "device_code";
  for (const visibility of [true, false, undefined]) {
    present(present(w.github).repositories[0]).private = visibility;
    expect(codingDestination(w, "101", input).authMode).toBe("device_code");
  }
  expect(() => codingDestination(w, "202", input)).toThrow(
    "github_user_connection_required",
  );
  expect(() =>
    codingDestination(w, "101", { ...input, repositoryId: 7002 }),
  ).toThrow();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const page = saveCoding(w, admin, {
    revision: present(w.coding).revision,
    settings: present(w.coding).settings,
  });
  expect(page.settings.authMode).toBe("device_code");
});
test("configuration is operator and tenant scoped with optimistic revision", () => {
  const { w } = codingFixture();
  const owner = w.members.find((member) => member.id === "101");
  if (!owner) throw new Error("Missing owner fixture");
  owner.username = "maintainer";
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const settings = present(w.coding).settings;
  expect(codingView(w, admin)).not.toHaveProperty("members");
  expect(() => codingView(w, { ...admin, id: "other" })).toThrow(
    "access_denied",
  );
  expect(() =>
    saveCoding(w, { ...admin, operator: false }, { revision: 1, settings }),
  ).toThrow();
  expect(() => saveCoding(w, admin, { revision: 0, settings })).toThrow(
    "version_conflict",
  );
  expect(saveCoding(w, admin, { revision: 1, settings }).revision).toBe(2);
});
test("branch validation rejects ref tricks, options and path traversal", () => {
  for (const value of [
    "--help",
    "../main",
    "a..b",
    "foo.lock",
    "a/.hidden",
    "a//b",
    "a/",
    "main.",
    "a b",
    "refs/heads/x^{commit}",
  ])
    expect(branchName.safeParse(value).success).toBe(false);
  for (const value of [
    "develop",
    "release/next",
    "feature-x_2.0",
    "_default",
    "release+next",
    "修复/默认分支",
    "a".repeat(200),
  ])
    expect(branchName.safeParse(value).success).toBe(true);
});
test("disconnected repositories do not prevent disabling the extension", () => {
  const { w } = codingFixture();
  const settings = present(w.coding).settings;
  w.github = { revision: 2, repositories: [] };
  const result = saveCoding(
    w,
    { id: w.operatorId, operator: true, username: "operator" },
    { revision: 1, settings: { ...settings, enabled: false } },
  );
  expect(result.settings.enabled).toBe(false);
});

test("workspace provider credentials are encrypted, redacted, revisioned and explicitly removable", () => {
  const { w } = codingFixture();
  const admin = { id: w.operatorId, operator: true, username: "operator" };
  const key = "ab".repeat(32);
  const settings = present(w.coding).settings;
  const save = (revision: number, providerApiKey?: string | null) =>
    saveCoding(w, admin, { revision, settings, providerApiKey }, key);
  const page = save(1, "workspace-provider-secret");
  const ciphertext = present(w.coding?.providerApiKey);
  expect(ciphertext).not.toContain("workspace-provider-secret");
  expect(decrypt(key, `coding-provider:${w.id}`, ciphertext)).toBe(
    "workspace-provider-secret",
  );
  expect(() =>
    decrypt(key, "coding-provider:another-workspace", ciphertext),
  ).toThrow();
  expect(page.providerApiKeyConfigured).toBe(true);
  expect(JSON.stringify(page)).not.toContain(ciphertext);
  expect(JSON.stringify(w)).not.toContain("workspace-provider-secret");
  save(2);
  expect(w.coding?.providerApiKey).toBe(ciphertext);
  expect(() => save(2, "stale-secret")).toThrow("version_conflict");
  expect(() =>
    saveCoding(
      w,
      { ...admin, id: "other" },
      { revision: 3, settings, providerApiKey: "foreign-secret" },
      key,
    ),
  ).toThrow("access_denied");
  expect(w.coding?.providerApiKey).toBe(ciphertext);
  expect(() => save(3, " ")).toThrow();
  save(3, "replacement-secret");
  expect(
    decrypt(key, `coding-provider:${w.id}`, present(w.coding?.providerApiKey)),
  ).toBe("replacement-secret");
  expect(save(4, null).providerApiKeyConfigured).toBe(false);
  expect(w.coding?.providerApiKey).toBeUndefined();
});

test("new GitHub collaborators can code without a plugin repository or maintainer grant", () => {
  const { w } = codingFixture();
  grantGitHubAccess(w, ["202"]);
  expect(codingDestination(w, "202", input).baseBranch).toBe("develop");
  present(w.github).repositories.push({
    id: 7002,
    full_name: "example/new",
    default_branch: "release/next",
  });
  grantGitHubAccess(w, ["202"]);
  expect(
    codingDestination(w, "202", { ...input, repositoryId: 7002 }).baseBranch,
  ).toBe("release/next");
  expect(w.coding?.settings).not.toHaveProperty("repositories");
});

test("coding requires current GitHub write access and rejects unusable repositories", () => {
  for (const change of [
    "read",
    "stale",
    "disconnected",
    "archived",
    "disabled",
    "missing-branch",
  ] as const) {
    const { w } = codingFixture();
    const access = present(w.members.find((m) => m.id === "101")?.github);
    const repository = present(present(w.github).repositories[0]);
    if (change === "read")
      present(access.repositories[0]).permissions = {
        pull: true,
        push: false,
        admin: false,
      };
    if (change === "stale") access.syncedAt = new Date(0).toISOString();
    if (change === "disconnected") access.status = "disconnected";
    if (change === "archived") repository.archived = true;
    if (change === "disabled") repository.disabled = true;
    if (change === "missing-branch") delete repository.default_branch;
    expect(() => codingDestination(w, "101", input)).toThrow(
      change === "stale"
        ? "github_user_access_unavailable"
        : change === "missing-branch"
          ? "github_default_branch_unavailable"
          : "github_user_access_denied",
    );
  }
});

test("codingStatusLabel and developmentStatus distinguish open, merged, and closed PRs", () => {
  const { w } = codingFixture();
  const payload = codingDestination(w, "101", input);
  const now = new Date().toISOString();
  const baseTask: DevelopmentTask = {
    id: "1e8f2aab-3b09-4e8e-858e-75c20d832517",
    workspaceId: w.id,
    actor: "101",
    botId: "999",
    chatId: "101",
    topicId: 0,
    sourceId: "src-1",
    payload,
    policy: { publishByDefault: true },
    state: "review",
    phase: "intake",
    revision: 1,
    consumedRevision: 1,
    verifiedRevision: 1,
    fence: 1,
    attempts: 1,
    tokens: 10,
    activeMs: 1000,
    canImplement: true,
    canPublish: true,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    pr: {
      number: 42,
      url: "https://github.com/example/workspace/pull/42",
      branch: "codex/telo-1",
      headSha: "a".repeat(40),
    },
  };

  expect(codingStatusLabel(baseTask)).toBe("PR ready for review");
  expect(developmentStatus(baseTask)).toContain("Your PR is ready for review.");
  expect(developmentPullClosed(baseTask)).toBe(false);
  expect(developmentTaskSettled(baseTask)).toBe(false);

  const mergedTask: DevelopmentTask = {
    ...baseTask,
    pr: { ...present(baseTask.pr), state: "merged" },
  };
  expect(codingStatusLabel(mergedTask)).toBe("PR merged");
  expect(developmentStatus(mergedTask)).toContain("Your PR has been merged.");
  expect(developmentPullClosed(mergedTask)).toBe(true);
  expect(developmentTaskSettled(mergedTask)).toBe(true);

  const closedTask: DevelopmentTask = {
    ...baseTask,
    pr: { ...present(baseTask.pr), state: "closed" },
  };
  expect(codingStatusLabel(closedTask)).toBe("PR closed");
  expect(developmentStatus(closedTask)).toContain("Your PR has been closed.");
  expect(developmentPullClosed(closedTask)).toBe(true);
  expect(developmentTaskSettled(closedTask)).toBe(true);
});

test("syncWorkspaceCodingPullStates reconciles external PR merge/close states via GitHub API", async () => {
  const { w } = codingFixture();
  const payload = codingDestination(w, "101", input);
  const now = new Date().toISOString();
  const tasks = new Map<string, DevelopmentTask>();
  const makeTask = (
    id: string,
    prNumber: number,
    prState?: "open" | "merged" | "closed",
  ): DevelopmentTask => ({
    id,
    workspaceId: w.id,
    actor: "101",
    botId: "999",
    chatId: "101",
    topicId: 0,
    sourceId: `src-${prNumber}`,
    payload,
    policy: { publishByDefault: true },
    state: "review",
    phase: "intake",
    revision: 1,
    consumedRevision: 1,
    verifiedRevision: 1,
    fence: 1,
    attempts: 1,
    tokens: 10,
    activeMs: 1000,
    canImplement: true,
    canPublish: true,
    cancelRequested: false,
    createdAt: now,
    updatedAt: now,
    pr: {
      number: prNumber,
      url: `https://github.com/example/workspace/pull/${prNumber}`,
      branch: `codex/telo-${prNumber}`,
      headSha: "a".repeat(40),
      ...(prState ? { state: prState } : {}),
    },
  });
  const t1 = makeTask("1e8f2aab-3b09-4e8e-858e-75c20d832517", 11);
  const t2 = makeTask("2e8f2aab-3b09-4e8e-858e-75c20d832517", 12, "open");
  const t3 = makeTask("3e8f2aab-3b09-4e8e-858e-75c20d832517", 13, "merged");
  tasks.set(t1.id, t1);
  tasks.set(t2.id, t2);
  tasks.set(t3.id, t3);

  const sql = {
    query: async (text: string, params: unknown[] = []) => {
      if (
        text.startsWith(
          "SELECT data FROM coding_tasks WHERE workspace_id=$1 ORDER BY",
        )
      ) {
        return {
          rows: [...tasks.values()].map((data) => ({
            data: structuredClone(data),
          })),
          rowCount: tasks.size,
        };
      }
      if (
        text.startsWith(
          "SELECT data FROM coding_tasks WHERE workspace_id=$1 AND id=$2",
        )
      ) {
        const found = tasks.get(String(params[1]));
        return {
          rows: found ? [{ data: structuredClone(found) }] : [],
          rowCount: found ? 1 : 0,
        };
      }
      if (text.startsWith("UPDATE coding_tasks SET data=$3")) {
        const id = String(params[1]);
        const updated = JSON.parse(String(params[2])) as DevelopmentTask;
        tasks.set(id, updated);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  } as unknown as Sql;

  const queriedPulls: number[] = [];
  const app = new GitHubApp(githubFixtureConfig, (async (urlInput) => {
    const u = String(urlInput);
    if (u.endsWith("/access_tokens")) {
      return Response.json({
        token: "ghs_test_read",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    const match = u.match(/\/pulls\/(\d+)$/);
    if (match) {
      const num = Number(match[1]);
      queriedPulls.push(num);
      return Response.json({
        number: num,
        state: "closed",
        merged: num === 11,
        head: {
          ref: `codex/telo-${num}`,
          sha: "a".repeat(40),
          repo: { full_name: "example/workspace" },
        },
      });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch);

  const synced = await syncWorkspaceCodingPullStates(sql, w.id, app);
  expect(queriedPulls).toEqual([11, 12]);
  expect(synced.find((t) => t.id === t1.id)?.pr?.state).toBe("merged");
  expect(synced.find((t) => t.id === t2.id)?.pr?.state).toBe("closed");
  expect(synced.find((t) => t.id === t3.id)?.pr?.state).toBe("merged");
});
