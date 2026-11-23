import { type AutonomyMode, workspaceAutonomy } from "../autonomy/policy.ts";
import { browserEnabled } from "../browser/config.ts";
import { browserPanelTask, browserRunPrivate } from "../browser/privacy.ts";
import { type CodingEngine, codingEngineOf } from "../coding/config.ts";
import {
  type DevelopmentState,
  developmentPullClosed,
} from "../coding/development.ts";
import { listRepoQueues } from "../coding/queue.ts";
import { taskList } from "../coding/task-store.ts";
import type { Store } from "../db/repositories.ts";
import type { Admin, Run, Settings, Workspace } from "../domain.ts";
import { obsidianEnabled } from "../obsidian/vault.ts";
import { missionList } from "../orchestration/store.ts";
import { type MissionStatus, missionTerminal } from "../orchestration/types.ts";
import { DUCKDUCKGO_PRESET_ID, duckduckgoPreset } from "../search/config.ts";
import { queryModelUsageAnalytics } from "../usage/model-usage.ts";
import {
  type ThreadSummary,
  threadGroups,
  threadSummaries,
} from "./thread-history.ts";
import { workflowView } from "./workflow-view.ts";

export interface OverviewAttentionItem {
  kind:
    | "workspace_paused"
    | "access_requests"
    | "approvals"
    | "failed_coding_tasks"
    | "failed_runs"
    | "paused_queues"
    | "inactive_groups"
    | "unresolved_usage";
  severity: "warn" | "info";
  count: number;
  label: string;
  detail: string;
  to: string;
}

export interface OverviewMetrics {
  activeGroups: number;
  inactiveGroups: number;
  pendingAccessRequests: number;
  threads7d: number;
  activeWorkflows: number;
  enabledSkills: number;
  autoSkills: number;
  activeMissions: number;
  totalMissions: number;
  coding?: {
    active: number;
    review: number;
    failed24h: number;
    codexCount: number;
    antigravityCount: number;
  };
}

export interface OverviewUsageDay {
  bucket: string;
  label: string;
  calls: number;
  totalTokens: number;
  accountedUsd: number;
}

export interface OverviewUsageSource {
  key: string;
  label: string;
  calls: number;
  totalTokens: number;
  accountedUsd: number;
  shareOfTokens: number;
}

export interface OverviewUsage7d {
  calls: number;
  totalTokens: number;
  accountedUsd: number;
  cacheHitRate: number | null;
  estimatedCacheSavingsUsd: number;
  unpricedCalls: number;
  failedCalls: number;
  unknownCalls: number;
  monthSpentUsd: number;
  monthBudgetUsd: number | null;
  daily: OverviewUsageDay[];
  bySource: OverviewUsageSource[];
}

export interface OverviewCodingTaskItem {
  id: string;
  title: string;
  repository: string;
  engine: CodingEngine;
  state: DevelopmentState;
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  updatedAt: string;
}

export interface OverviewMissionItem {
  id: string;
  goal: string;
  status: MissionStatus;
  autonomyMode: AutonomyMode;
  wakeupCount: number;
  maxWakeups: number;
  updatedAt: string;
}

export interface OverviewThreadItem {
  id: string;
  kind: ThreadSummary["kind"];
  title: string;
  status: Run["status"];
  requestCount: number;
  updatedAt: string;
  groupTitle?: string;
  userName?: string;
}

export interface OverviewWorkflowItem {
  id: string;
  name: string;
  triggerKind: "schedule" | "github_event";
  deliveryMode: "always" | "on_condition";
  nextAt?: string;
  lastStatus?: Run["status"];
  lastAt?: string;
}

export interface OverviewPluginBadge {
  id: string;
  label: string;
  path?: string;
}

export interface OverviewSetup {
  chatModel: string | null;
  searchProvider: string | null;
  autonomyMode: AutonomyMode;
  enabledSkills: number;
  enabledPlugins: OverviewPluginBadge[];
}

export interface OverviewResponse {
  id: string;
  settings: Settings;
  version: number;
  counts: {
    members: number;
    runs: number;
    threads: number;
    workflows: number;
    codingTasks?: number;
  };
  connections?: {
    bot: { configured: boolean; username?: string };
    github: {
      connected: boolean;
      account?: string;
      repositories: number;
      allRepositories: boolean;
    };
  };
  metrics: OverviewMetrics;
  attention: OverviewAttentionItem[];
  usage7d: OverviewUsage7d;
  activity: {
    codingTasks?: OverviewCodingTaskItem[];
    missions: OverviewMissionItem[];
    threads: OverviewThreadItem[];
    upcomingWorkflows: OverviewWorkflowItem[];
  };
  setup: OverviewSetup;
}

const ACTIVE_CODING_STATES = new Set<DevelopmentState>([
  "auth_required",
  "queued",
  "working",
  "waiting",
  "publishing",
]);

function enabledPluginsList(
  w: Workspace,
  operatorView: boolean,
): OverviewPluginBadge[] {
  const plugins: OverviewPluginBadge[] = [];
  const add = (id: string, label: string, path: string) => {
    plugins.push(operatorView ? { id, label, path } : { id, label });
  };
  if (w.coding?.settings.enabled) add("codex", "Codex", "/admin/plugins/codex");
  if (w.antigravity?.settings.enabled)
    add("antigravity", "Antigravity CLI", "/admin/plugins/antigravity");
  if (browserEnabled(w)) add("browser", "Browser", "/admin/plugins/browser");
  if (w.reviewBot?.settings.enabled)
    add("review-bot", "Review Bot", "/admin/plugins/review-bot");
  if (w.plugins?.codeTruth?.enabled)
    add("code-truth", "Code Truth", "/admin/plugins/code-truth");
  if (
    Object.values(w.plugins?.google ?? {}).some((cfg) => cfg?.settings.enabled)
  )
    add("google", "Google", "/admin/plugins/google");
  if (w.plugins?.cloudflare?.settings.enabled)
    add("cloudflare", "Cloudflare", "/admin/plugins/cloudflare");
  if (obsidianEnabled(w))
    add("obsidian", "Obsidian", "/admin/plugins/obsidian");
  if (w.plugins?.nowledgeMem?.settings.enabled)
    add("nowledge-mem", "Nowledge Mem", "/admin/plugins/nowledge-mem");
  if (w.plugins?.transcription?.enabled)
    add("transcription", "Transcription", "/admin/plugins/transcription");
  if (
    (w.githubNotifications?.filter((s) => s.enabled && !s.revoked).length ??
      0) > 0
  )
    add(
      "github-notifications",
      "GitHub notifications",
      "/admin/plugins/github-notifications",
    );
  for (const pkg of w.plugins?.packages ?? []) {
    if (!pkg.enabled) continue;
    add(
      `pkg:${pkg.source.repositoryId}`,
      pkg.manifest.name,
      `/admin/plugins/packages/${pkg.source.repositoryId}`,
    );
  }
  return plugins;
}

function searchProviderLabel(
  w: Workspace,
  deployment: Awaited<ReturnType<Store["deployment"]>>,
): string | null {
  const id = w.chatModel?.searchProviderId;
  if (!id) return null;
  if (id === DUCKDUCKGO_PRESET_ID) return duckduckgoPreset.name;
  const found = deployment.searchProviders?.find((p) => p.id === id);
  return found?.name ?? "Configured";
}

export async function workspaceOverview(
  store: Store,
  w: Workspace,
  admin: Admin,
  actor: string,
  now = new Date(),
): Promise<OverviewResponse> {
  const operatorView = actor === w.operatorId;
  const operatorOnly = actor === admin.id;
  const showConnections = admin.operator && w.operatorId === admin.id;
  const oneDayAgoIso = new Date(
    now.getTime() - 24 * 60 * 60 * 1000,
  ).toISOString();
  const sevenDaysAgoIso = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [deployment, tasks, missionsPage, queues, usage7dRaw] =
    await Promise.all([
      store.deployment(),
      operatorView ? taskList(store.pool, w.id) : Promise.resolve([]),
      missionList(store.pool, w.id, { limit: 25, offset: 0 }),
      listRepoQueues(store.pool, w, operatorOnly),
      queryModelUsageAnalytics(
        store.pool,
        w,
        { range: "7d", offset: 0, limit: 1 },
        operatorOnly,
        now,
      ),
    ]);

  const threadTotal = threadGroups(w).size;
  const allThreadSummaries =
    threadTotal > 0 ? threadSummaries(w, 0, threadTotal).items : [];
  const threads7d = allThreadSummaries.filter(
    (t) => t.updatedAt >= sevenDaysAgoIso,
  ).length;

  const activeGroups = w.chats.filter((c) => c.active).length;
  const inactiveGroups = w.chats.filter((c) => !c.active).length;
  const pendingAccessRequests = (w.accessRequests ?? []).filter(
    (r) => r.status === "pending",
  ).length;
  const pendingApprovals = w.approvals.filter(
    (a) =>
      !a.browserRead &&
      !(
        a.runId &&
        w.runs.some((r) => r.id === a.runId && browserRunPrivate(w, r))
      ) &&
      a.kind !== "workflow" &&
      a.actor === actor &&
      !a.decision,
  ).length;

  const nonDeletedWorkflows = w.workflows.filter((f) => f.status !== "deleted");
  const activeWorkflows = nonDeletedWorkflows.filter(
    (f) => f.status === "active",
  );
  const enabledSkills = w.skills.filter((s) => !s.archived && s.enabled).length;
  const autoSkills = w.skills.filter((s) => !s.archived && !!s.auto).length;

  const activeMissions = missionsPage.items.filter(
    (m) => !missionTerminal(m.status),
  ).length;

  let codingMetrics: OverviewMetrics["coding"];
  let recentCodingTasks: OverviewCodingTaskItem[] | undefined;
  let failedCoding24h = 0;
  let failedCodingOnlyAntigravity = false;

  if (operatorView) {
    let active = 0;
    let review = 0;
    let codexCount = 0;
    let antigravityCount = 0;
    let failedCodex24h = 0;
    let failedAgy24h = 0;
    for (const task of tasks) {
      const engine = codingEngineOf(task.payload);
      if (engine === "antigravity") antigravityCount++;
      else codexCount++;
      if (ACTIVE_CODING_STATES.has(task.state)) active++;
      if (task.state === "review" && !developmentPullClosed(task)) review++;
      if (task.state === "failed" && task.updatedAt >= oneDayAgoIso) {
        failedCoding24h++;
        if (engine === "antigravity") failedAgy24h++;
        else failedCodex24h++;
      }
    }
    failedCodingOnlyAntigravity = failedAgy24h > 0 && failedCodex24h === 0;
    codingMetrics = {
      active,
      review,
      failed24h: failedCoding24h,
      codexCount,
      antigravityCount,
    };

    recentCodingTasks = [...tasks]
      .sort((a, b) => {
        const aActive = ACTIVE_CODING_STATES.has(a.state) ? 1 : 0;
        const bActive = ACTIVE_CODING_STATES.has(b.state) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, 5)
      .map((raw) => {
        const task = browserPanelTask(raw);
        return {
          id: task.id,
          title: task.payload.title,
          repository: task.payload.repository,
          engine: codingEngineOf(task.payload),
          state: task.state,
          ...(task.pr
            ? {
                prNumber: task.pr.number,
                prUrl: task.pr.url,
                ...(task.pr.state ? { prState: task.pr.state } : {}),
              }
            : {}),
          updatedAt: task.updatedAt,
        };
      });
  }

  const failedRuns24h = w.runs.filter(
    (r) => r.status === "failed" && (r.finishedAt ?? r.at) >= oneDayAgoIso,
  ).length;
  const pausedQueues = queues.filter((q) => q.queue.paused).length;

  const attention: OverviewAttentionItem[] = [];
  if (w.settings.paused) {
    attention.push({
      kind: "workspace_paused",
      severity: "warn",
      count: 1,
      label: "Workspace paused",
      detail: "Replies and scheduled runs are paused in Settings.",
      to: `/admin/settings?workspace=${w.id}`,
    });
  }
  if (pendingAccessRequests > 0) {
    attention.push({
      kind: "access_requests",
      severity: "info",
      count: pendingAccessRequests,
      label: `${pendingAccessRequests} pending access ${pendingAccessRequests === 1 ? "request" : "requests"}`,
      detail: "Review members waiting to join this workspace.",
      to: `/admin/members?workspace=${w.id}`,
    });
  }
  if (pendingApprovals > 0) {
    attention.push({
      kind: "approvals",
      severity: "info",
      count: pendingApprovals,
      label: `${pendingApprovals} pending ${pendingApprovals === 1 ? "approval" : "approvals"}`,
      detail: "Actions are awaiting your confirmation.",
      to: `/admin/members?workspace=${w.id}`,
    });
  }
  if (operatorView && failedCoding24h > 0) {
    attention.push({
      kind: "failed_coding_tasks",
      severity: "warn",
      count: failedCoding24h,
      label: `${failedCoding24h} failed coding ${failedCoding24h === 1 ? "task" : "tasks"} (24h)`,
      detail: "Inspect recent coding failures and retry or stop tasks.",
      to: `/admin/plugins/${failedCodingOnlyAntigravity ? "antigravity" : "codex"}?workspace=${w.id}#coding-tasks`,
    });
  }
  if (failedRuns24h > 0) {
    attention.push({
      kind: "failed_runs",
      severity: "warn",
      count: failedRuns24h,
      label: `${failedRuns24h} failed ${failedRuns24h === 1 ? "run" : "runs"} (24h)`,
      detail: "Review recent threads for run errors.",
      to: `/admin/threads?workspace=${w.id}`,
    });
  }
  if (pausedQueues > 0) {
    attention.push({
      kind: "paused_queues",
      severity: "warn",
      count: pausedQueues,
      label: `${pausedQueues} paused repository ${pausedQueues === 1 ? "queue" : "queues"}`,
      detail: "Resume queued tasks in Missions & Orchestration.",
      to: `/admin/missions?workspace=${w.id}`,
    });
  }
  if (inactiveGroups > 0) {
    attention.push({
      kind: "inactive_groups",
      severity: "warn",
      count: inactiveGroups,
      label: `${inactiveGroups} inactive Telegram ${inactiveGroups === 1 ? "group" : "groups"}`,
      detail: "Relink inactive groups in Groups & Members.",
      to: `/admin/members?workspace=${w.id}`,
    });
  }
  if (usage7dRaw.summary.unknownCalls > 0) {
    attention.push({
      kind: "unresolved_usage",
      severity: "warn",
      count: usage7dRaw.summary.unknownCalls,
      label: `${usage7dRaw.summary.unknownCalls} unresolved usage ${usage7dRaw.summary.unknownCalls === 1 ? "charge" : "charges"} (7d)`,
      detail: "Check unsettled model calls in Model usage.",
      to: `/admin/model-usage?workspace=${w.id}&status=unknown`,
    });
  }

  const sortedMissions = [...missionsPage.items]
    .sort((a, b) => {
      const aActive = missionTerminal(a.status) ? 0 : 1;
      const bActive = missionTerminal(b.status) ? 0 : 1;
      if (aActive !== bActive) return bActive - aActive;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 4)
    .map(
      (mission): OverviewMissionItem => ({
        id: mission.id,
        goal:
          operatorOnly && mission.chatId === mission.actor
            ? "Private mission"
            : mission.goal,
        status: mission.status,
        autonomyMode: mission.autonomyMode,
        wakeupCount: mission.wakeupCount,
        maxWakeups: mission.maxWakeups,
        updatedAt: mission.updatedAt,
      }),
    );

  const recentThreads: OverviewThreadItem[] = allThreadSummaries
    .slice(0, 5)
    .map((thread) => ({
      id: thread.id,
      kind: thread.kind,
      title: thread.title,
      status: thread.status,
      requestCount: thread.requestCount,
      updatedAt: thread.updatedAt,
      ...(thread.group?.title ? { groupTitle: thread.group.title } : {}),
      userName: thread.user.username
        ? `@${thread.user.username}`
        : thread.user.name || thread.user.id,
    }));

  const latestRunByWorkflow = new Map<string, Run>();
  for (const run of w.runs) {
    if (!run.workflowId) continue;
    const prev = latestRunByWorkflow.get(run.workflowId);
    const runAt = run.finishedAt ?? run.at;
    const prevAt = prev ? (prev.finishedAt ?? prev.at) : "";
    if (!prev || runAt >= prevAt) latestRunByWorkflow.set(run.workflowId, run);
  }

  const upcomingWorkflows: OverviewWorkflowItem[] = activeWorkflows
    .map((workflow) => {
      const view = workflowView(w, workflow, admin.telegramId);
      const lastRun = latestRunByWorkflow.get(workflow.id);
      return {
        id: workflow.id,
        name: workflow.spec.name,
        triggerKind: (workflow.spec.trigger?.kind === "github_event"
          ? "github_event"
          : "schedule") as "schedule" | "github_event",
        deliveryMode: (workflow.spec.deliveryMode === "on_condition"
          ? "on_condition"
          : "always") as "always" | "on_condition",
        ...(view.next[0] ? { nextAt: view.next[0] } : {}),
        ...(lastRun
          ? {
              lastStatus: lastRun.status,
              lastAt: lastRun.finishedAt ?? lastRun.at,
            }
          : {}),
      };
    })
    .sort((a, b) => {
      if (a.nextAt && b.nextAt) return a.nextAt.localeCompare(b.nextAt);
      if (a.nextAt) return -1;
      if (b.nextAt) return 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 4);

  return {
    id: w.id,
    settings: w.settings,
    version: w.version,
    counts: {
      members: w.members.filter((m) => m.active).length,
      runs: w.runs.length,
      threads: threadTotal,
      workflows: nonDeletedWorkflows.length,
      ...(operatorView ? { codingTasks: tasks.length } : {}),
    },
    ...(showConnections
      ? {
          connections: {
            bot: {
              configured: !!deployment.credentials.bot && !!deployment.bot,
              username: deployment.credentials.bot
                ? deployment.bot?.username
                : undefined,
            },
            github: {
              connected: !!w.github?.installationId,
              account: w.github?.account,
              repositories: w.github?.repositories.length ?? 0,
              allRepositories: !!w.github?.allRepositories,
            },
          },
        }
      : {}),
    metrics: {
      activeGroups,
      inactiveGroups,
      pendingAccessRequests,
      threads7d,
      activeWorkflows: activeWorkflows.length,
      enabledSkills,
      autoSkills,
      activeMissions,
      totalMissions: missionsPage.total,
      ...(codingMetrics ? { coding: codingMetrics } : {}),
    },
    attention,
    usage7d: {
      calls: usage7dRaw.summary.calls,
      totalTokens: usage7dRaw.summary.totalTokens,
      accountedUsd: usage7dRaw.summary.accountedUsd,
      cacheHitRate: usage7dRaw.summary.cacheHitRate,
      estimatedCacheSavingsUsd: usage7dRaw.summary.estimatedCacheSavingsUsd,
      unpricedCalls: usage7dRaw.summary.unpricedCalls,
      failedCalls: usage7dRaw.summary.failedCalls,
      unknownCalls: usage7dRaw.summary.unknownCalls,
      monthSpentUsd: usage7dRaw.budget.monthAccountedUsd,
      monthBudgetUsd: usage7dRaw.budget.monthlyLimitUsd,
      daily: usage7dRaw.timeseries.slice(-7).map((p) => ({
        bucket: p.bucket,
        label: p.label,
        calls: p.calls,
        totalTokens: p.totalTokens,
        accountedUsd: p.accountedUsd,
      })),
      bySource: usage7dRaw.bySource.slice(0, 5).map((s) => ({
        key: s.key,
        label: s.label,
        calls: s.calls,
        totalTokens: s.totalTokens,
        accountedUsd: s.accountedUsd,
        shareOfTokens: s.shareOfTokens,
      })),
    },
    activity: {
      ...(recentCodingTasks ? { codingTasks: recentCodingTasks } : {}),
      missions: sortedMissions,
      threads: recentThreads,
      upcomingWorkflows,
    },
    setup: {
      chatModel: w.chatModel?.selection.model || deployment.model || null,
      searchProvider: searchProviderLabel(w, deployment),
      autonomyMode: workspaceAutonomy(w).defaultMode,
      enabledSkills,
      enabledPlugins: enabledPluginsList(w, operatorView),
    },
  };
}
