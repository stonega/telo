import { NavLink } from "react-router";
import type {
  OverviewAttentionItem,
  OverviewCodingTaskItem,
  OverviewMetrics,
  OverviewMissionItem,
  OverviewResponse,
  OverviewSetup,
  OverviewThreadItem,
  OverviewUsage7d,
  OverviewWorkflowItem,
} from "../src/admin/overview.ts";
import { Skeleton } from "./skeleton.tsx";
import {
  formatCompactTokens,
  formatPercent,
  formatUsd,
  sourceColor,
} from "./usage-charts.tsx";

export function formatOverviewStatSub(
  key: string,
  metrics?: OverviewMetrics,
  runsCount?: number,
): string | null {
  if (!metrics) return null;
  if (key === "members") {
    const groups = `${metrics.activeGroups} active ${metrics.activeGroups === 1 ? "group" : "groups"}`;
    return metrics.pendingAccessRequests > 0
      ? `${groups} · ${metrics.pendingAccessRequests} pending`
      : groups;
  }
  if (key === "threads") {
    const active7d = `${metrics.threads7d} active in 7d`;
    return runsCount !== undefined
      ? `${active7d} · ${runsCount} ${runsCount === 1 ? "run" : "runs"}`
      : active7d;
  }
  if (key === "workflows") {
    const active = `${metrics.activeWorkflows} active`;
    const skills = `${metrics.enabledSkills} ${metrics.enabledSkills === 1 ? "skill" : "skills"}`;
    return metrics.autoSkills > 0
      ? `${active} · ${skills} (${metrics.autoSkills} auto)`
      : `${active} · ${skills}`;
  }
  if (key === "codingTasks" && metrics.coding) {
    const { active, review, codexCount, antigravityCount } = metrics.coding;
    const statusPart = `${active} active · ${review} in review`;
    if (codexCount > 0 && antigravityCount > 0) {
      return `${statusPart} · Codex + Agy`;
    }
    return statusPart;
  }
  return null;
}

function formatShortTime(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function codingStatePill(state: OverviewCodingTaskItem["state"]): {
  label: string;
  tone: string;
} {
  switch (state) {
    case "working":
    case "publishing":
      return {
        label: state === "publishing" ? "Publishing" : "Working",
        tone: "good",
      };
    case "queued":
      return { label: "Queued", tone: "" };
    case "waiting":
    case "auth_required":
      return {
        label: state === "auth_required" ? "Auth required" : "Waiting",
        tone: "warn",
      };
    case "review":
      return { label: "Ready for review", tone: "good" };
    case "failed":
    case "unknown":
      return {
        label: state === "unknown" ? "Unknown" : "Failed",
        tone: "danger",
      };
    case "cancelled":
      return { label: "Cancelled", tone: "" };
    default:
      return { label: state, tone: "" };
  }
}

function runStatusPill(status: OverviewThreadItem["status"]): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "succeeded":
      return { label: "Succeeded", tone: "good" };
    case "running":
      return { label: "Running", tone: "good" };
    case "awaiting_approval":
      return { label: "Awaiting approval", tone: "warn" };
    case "queued":
      return { label: "Queued", tone: "" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "cancelled":
      return { label: "Cancelled", tone: "" };
    default:
      return { label: status, tone: "" };
  }
}

function missionStatusPill(status: OverviewMissionItem["status"]): {
  label: string;
  tone: string;
} {
  switch (status) {
    case "active":
      return { label: "Active", tone: "good" };
    case "waiting":
    case "awaiting_approval":
      return {
        label: status === "awaiting_approval" ? "Awaiting approval" : "Waiting",
        tone: "warn",
      };
    case "completed":
      return { label: "Completed", tone: "good" };
    case "failed":
    case "halted":
      return {
        label: status === "halted" ? "Halted" : "Failed",
        tone: "danger",
      };
    case "cancelled":
      return { label: "Cancelled", tone: "" };
    default:
      return { label: status, tone: "" };
  }
}

function autonomyModeLabel(mode: OverviewSetup["autonomyMode"]): {
  label: string;
  tone: string;
} {
  if (mode === "full_auto") return { label: "Full Auto", tone: "danger" };
  if (mode === "check_in") return { label: "Check-in", tone: "good" };
  return { label: "Supervised", tone: "" };
}

export function OverviewAttentionSection({
  items,
}: {
  items: OverviewAttentionItem[];
}) {
  if (!items.length) return null;
  return (
    <section
      className="card overview-attention-card"
      aria-label="Needs attention"
    >
      <div className="row overview-section-head">
        <h2>Needs attention</h2>
        <span className="pill warn">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>
      <ul className="overview-attention-list">
        {items.map((item) => (
          <li key={item.kind} className="overview-attention-item">
            <div className="overview-attention-copy">
              <div className="overview-attention-title">
                <span
                  className={`pill ${item.severity === "warn" ? "danger" : "warn"}`}
                >
                  {item.severity === "warn" ? "Alert" : "Pending"}
                </span>
                <strong>{item.label}</strong>
              </div>
              <span className="muted">{item.detail}</span>
            </div>
            <NavLink to={item.to} className="overview-inline-link">
              Review
            </NavLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UsageSparkline({ daily }: { daily: OverviewUsage7d["daily"] }) {
  const maxTokens = Math.max(...daily.map((d) => d.totalTokens), 1);
  return (
    <div
      className="overview-sparkline"
      role="img"
      aria-label="7-day token activity"
    >
      <div className="overview-sparkline-bars">
        {daily.map((point) => {
          const ratio =
            point.totalTokens > 0 ? point.totalTokens / maxTokens : 0;
          const heightPct =
            point.totalTokens > 0 ? Math.max(10, Math.round(ratio * 100)) : 4;
          return (
            <div
              key={point.bucket}
              className="overview-sparkline-col"
              title={`${point.label}: ${formatCompactTokens(point.totalTokens)} tokens · ${formatUsd(point.accountedUsd)} (${point.calls} ${point.calls === 1 ? "call" : "calls"})`}
            >
              <div className="overview-sparkline-track">
                <div
                  className={`overview-sparkline-fill${point.totalTokens === 0 ? " empty" : ""}`}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
              <span className="overview-sparkline-label">{point.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function OverviewUsageCard({
  workspaceId,
  usage,
  loading,
}: {
  workspaceId: string;
  usage?: OverviewUsage7d;
  loading: boolean;
}) {
  const budgetPct =
    usage?.monthBudgetUsd && usage.monthBudgetUsd > 0
      ? Math.min(
          100,
          Math.round((usage.monthSpentUsd / usage.monthBudgetUsd) * 100),
        )
      : null;

  return (
    <section
      className="card overview-panel-card"
      aria-label="7-day model usage"
      aria-busy={loading}
    >
      <div className="row overview-section-head">
        <div>
          <h2>Model usage (7d)</h2>
          <p className="muted overview-section-sub">
            Tokens, prompt-cache efficiency, and source attribution.
          </p>
        </div>
        <NavLink
          to={`/admin/model-usage?workspace=${workspaceId}&range=7d`}
          className="overview-inline-link"
        >
          View analytics
        </NavLink>
      </div>

      {!usage ? (
        loading ? (
          <div className="overview-skeleton-stack">
            <Skeleton width="100%" height="58px" />
            <Skeleton width="100%" height="84px" />
          </div>
        ) : (
          <p className="muted">Usage analytics unavailable.</p>
        )
      ) : (
        <>
          <div className="overview-usage-kpis">
            <div className="overview-usage-kpi">
              <span className="overview-usage-kpi-label">7d Spend</span>
              <strong className="overview-usage-kpi-value">
                {formatUsd(usage.accountedUsd)}
              </strong>
              <small className="muted">
                {usage.calls.toLocaleString()}{" "}
                {usage.calls === 1 ? "call" : "calls"}
              </small>
            </div>
            <div className="overview-usage-kpi">
              <span className="overview-usage-kpi-label">7d Tokens</span>
              <strong className="overview-usage-kpi-value">
                {formatCompactTokens(usage.totalTokens)}
              </strong>
              <small className="muted">
                {usage.unpricedCalls > 0
                  ? `${usage.unpricedCalls} unpriced`
                  : "All calls metered"}
              </small>
            </div>
            <div className="overview-usage-kpi">
              <span className="overview-usage-kpi-label">Cache hit rate</span>
              <strong className="overview-usage-kpi-value">
                {formatPercent(usage.cacheHitRate)}
              </strong>
              <small className="muted">
                {usage.estimatedCacheSavingsUsd > 0
                  ? `Saved ${formatUsd(usage.estimatedCacheSavingsUsd)}`
                  : "Prompt cache"}
              </small>
            </div>
          </div>

          {usage.monthBudgetUsd !== null && usage.monthBudgetUsd > 0 && (
            <div className="overview-budget-box">
              <div className="row overview-budget-head">
                <span>Monthly budget</span>
                <strong>
                  {formatUsd(usage.monthSpentUsd)} /{" "}
                  {formatUsd(usage.monthBudgetUsd)} ({budgetPct}%)
                </strong>
              </div>
              <div className="overview-progress-track">
                <div
                  className={`overview-progress-fill${(budgetPct ?? 0) >= 90 ? " danger" : (budgetPct ?? 0) >= 75 ? " warn" : ""}`}
                  style={{ width: `${budgetPct ?? 0}%` }}
                />
              </div>
            </div>
          )}

          {usage.daily.length > 0 && <UsageSparkline daily={usage.daily} />}

          {usage.bySource.length > 0 ? (
            <div className="overview-sources">
              <div
                className="overview-source-bar"
                role="img"
                aria-label="Token share by source"
              >
                {usage.bySource.map((src) => (
                  <div
                    key={src.key}
                    className="overview-source-segment"
                    style={{
                      width: `${Math.max(4, Math.round(src.shareOfTokens * 100))}%`,
                      background: sourceColor(src.key),
                    }}
                    title={`${src.label}: ${formatCompactTokens(src.totalTokens)} (${formatPercent(src.shareOfTokens)})`}
                  />
                ))}
              </div>
              <ul className="overview-source-legend">
                {usage.bySource.map((src) => (
                  <li key={src.key} className="overview-source-item">
                    <span className="overview-source-name">
                      <i
                        className="mu-dot"
                        style={{ background: sourceColor(src.key) }}
                      />
                      <span>{src.label}</span>
                    </span>
                    <span className="overview-source-meta">
                      {formatCompactTokens(src.totalTokens)} ·{" "}
                      {formatUsd(src.accountedUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted overview-empty-note">
              No model calls recorded in the last 7 days.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function OverviewCodingTasksCard({
  workspaceId,
  tasks,
  metrics,
  loading,
}: {
  workspaceId: string;
  tasks?: OverviewCodingTaskItem[];
  metrics?: OverviewMetrics["coding"];
  loading: boolean;
}) {
  const preferAntigravity =
    metrics && metrics.antigravityCount > 0 && metrics.codexCount === 0;
  const targetPlugin = preferAntigravity ? "antigravity" : "codex";

  return (
    <section
      className="card overview-panel-card"
      aria-label="Recent coding tasks"
      aria-busy={loading}
    >
      <div className="row overview-section-head">
        <div>
          <h2>Recent coding tasks</h2>
          <p className="muted overview-section-sub">
            {metrics
              ? `${metrics.active} active · ${metrics.review} ready for review · ${metrics.codexCount} Codex · ${metrics.antigravityCount} Antigravity`
              : "Latest repository tasks across Codex and Antigravity CLI."}
          </p>
        </div>
        <NavLink
          to={`/admin/plugins/${targetPlugin}?workspace=${workspaceId}#coding-tasks`}
          className="overview-inline-link"
        >
          View tasks
        </NavLink>
      </div>

      {!tasks ? (
        loading ? (
          <div className="overview-skeleton-stack">
            <Skeleton width="100%" height="48px" />
            <Skeleton width="100%" height="48px" />
          </div>
        ) : (
          <p className="muted">Coding tasks unavailable.</p>
        )
      ) : tasks.length === 0 ? (
        <p className="muted overview-empty-note">
          No coding tasks yet. Start a task in Telegram or enable Codex or
          Antigravity CLI in Plugins.
        </p>
      ) : (
        <ul className="overview-item-list">
          {tasks.map((task) => {
            const pill = codingStatePill(task.state);
            const pluginSlug =
              task.engine === "antigravity" ? "antigravity" : "codex";
            const engineLabel =
              task.engine === "antigravity" ? "Antigravity CLI" : "Codex";
            return (
              <li key={task.id} className="overview-item-row">
                <div className="overview-item-main">
                  <NavLink
                    to={`/admin/plugins/${pluginSlug}?workspace=${workspaceId}#coding-tasks`}
                    className="overview-item-title"
                  >
                    {task.title}
                  </NavLink>
                  <div className="overview-item-meta">
                    <span className="mono">{task.repository}</span>
                    <span>·</span>
                    <span>{engineLabel}</span>
                    <span>·</span>
                    <span>{formatShortTime(task.updatedAt)}</span>
                  </div>
                </div>
                <div className="overview-item-badges">
                  {task.prUrl && task.prNumber && (
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="pill"
                    >
                      PR #{task.prNumber}
                    </a>
                  )}
                  <span className={`pill${pill.tone ? ` ${pill.tone}` : ""}`}>
                    {pill.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function OverviewThreadsCard({
  workspaceId,
  threads,
  metrics,
  loading,
}: {
  workspaceId: string;
  threads?: OverviewThreadItem[];
  metrics?: OverviewMetrics;
  loading: boolean;
}) {
  return (
    <section
      className="card overview-panel-card"
      aria-label="Recent threads"
      aria-busy={loading}
    >
      <div className="row overview-section-head">
        <div>
          <h2>Recent threads</h2>
          <p className="muted overview-section-sub">
            {metrics
              ? `${metrics.threads7d} active in the last 7 days.`
              : "Latest Telegram conversations and workflow runs."}
          </p>
        </div>
        <NavLink
          to={`/admin/threads?workspace=${workspaceId}`}
          className="overview-inline-link"
        >
          View all
        </NavLink>
      </div>

      {!threads ? (
        loading ? (
          <div className="overview-skeleton-stack">
            <Skeleton width="100%" height="48px" />
            <Skeleton width="100%" height="48px" />
          </div>
        ) : (
          <p className="muted">Threads unavailable.</p>
        )
      ) : threads.length === 0 ? (
        <p className="muted overview-empty-note">
          No conversation threads recorded yet.
        </p>
      ) : (
        <ul className="overview-item-list">
          {threads.map((thread) => {
            const pill = runStatusPill(thread.status);
            const scopeLabel =
              thread.kind === "group"
                ? `Group · ${thread.groupTitle || "Linked group"}`
                : thread.kind === "workflow"
                  ? "Workflow"
                  : "Private";
            return (
              <li key={thread.id} className="overview-item-row">
                <div className="overview-item-main">
                  <NavLink
                    to={`/admin/threads/${thread.id}?workspace=${workspaceId}`}
                    className="overview-item-title"
                  >
                    {thread.title}
                  </NavLink>
                  <div className="overview-item-meta">
                    <span>{scopeLabel}</span>
                    {thread.userName && (
                      <>
                        <span>·</span>
                        <span>{thread.userName}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>
                      {thread.requestCount}{" "}
                      {thread.requestCount === 1 ? "turn" : "turns"}
                    </span>
                    <span>·</span>
                    <span>{formatShortTime(thread.updatedAt)}</span>
                  </div>
                </div>
                <div className="overview-item-badges">
                  <span className={`pill${pill.tone ? ` ${pill.tone}` : ""}`}>
                    {pill.label}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function OverviewMissionsAndAutomationsCard({
  workspaceId,
  missions,
  workflows,
  metrics,
  loading,
}: {
  workspaceId: string;
  missions?: OverviewMissionItem[];
  workflows?: OverviewWorkflowItem[];
  metrics?: OverviewMetrics;
  loading: boolean;
}) {
  return (
    <section
      className="card overview-panel-card"
      aria-label="Missions and automations"
      aria-busy={loading}
    >
      <div className="row overview-section-head">
        <div>
          <h2>Missions & automations</h2>
          <p className="muted overview-section-sub">
            {metrics
              ? `${metrics.activeMissions} active ${metrics.activeMissions === 1 ? "mission" : "missions"} · ${metrics.activeWorkflows} active ${metrics.activeWorkflows === 1 ? "workflow" : "workflows"}`
              : "Multi-step orchestration and scheduled workflows."}
          </p>
        </div>
        <div className="overview-head-links">
          <NavLink
            to={`/admin/missions?workspace=${workspaceId}`}
            className="overview-inline-link"
          >
            Missions
          </NavLink>
          <NavLink
            to={`/admin/workflows?workspace=${workspaceId}`}
            className="overview-inline-link"
          >
            Workflows
          </NavLink>
        </div>
      </div>

      {!missions || !workflows ? (
        loading ? (
          <div className="overview-skeleton-stack">
            <Skeleton width="100%" height="48px" />
            <Skeleton width="100%" height="48px" />
          </div>
        ) : (
          <p className="muted">Orchestration data unavailable.</p>
        )
      ) : (
        <div className="overview-subcards">
          <div className="overview-subsection">
            <div className="row overview-subsection-head">
              <h3>Recent missions</h3>
              {metrics && metrics.activeMissions > 0 && (
                <span className="pill good">
                  {metrics.activeMissions} active
                </span>
              )}
            </div>
            {missions.length === 0 ? (
              <p className="muted overview-empty-note">
                No background missions yet.
              </p>
            ) : (
              <ul className="overview-item-list compact">
                {missions.map((mission) => {
                  const pill = missionStatusPill(mission.status);
                  return (
                    <li key={mission.id} className="overview-item-row">
                      <div className="overview-item-main">
                        <NavLink
                          to={`/admin/missions?workspace=${workspaceId}`}
                          className="overview-item-title"
                        >
                          {mission.goal}
                        </NavLink>
                        <div className="overview-item-meta">
                          <span>
                            {mission.wakeupCount}/{mission.maxWakeups} wakeups
                          </span>
                          <span>·</span>
                          <span>{formatShortTime(mission.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="overview-item-badges">
                        <span
                          className={`pill${pill.tone ? ` ${pill.tone}` : ""}`}
                        >
                          {pill.label}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="overview-subsection">
            <div className="row overview-subsection-head">
              <h3>Active workflows</h3>
            </div>
            {workflows.length === 0 ? (
              <p className="muted overview-empty-note">
                No active workflows configured.
              </p>
            ) : (
              <ul className="overview-item-list compact">
                {workflows.map((wf) => {
                  const lastPill = wf.lastStatus
                    ? runStatusPill(wf.lastStatus)
                    : undefined;
                  return (
                    <li key={wf.id} className="overview-item-row">
                      <div className="overview-item-main">
                        <NavLink
                          to={`/admin/workflows/${wf.id}?workspace=${workspaceId}`}
                          className="overview-item-title"
                        >
                          {wf.name}
                        </NavLink>
                        <div className="overview-item-meta">
                          <span>
                            {wf.triggerKind === "github_event"
                              ? "GitHub event"
                              : wf.nextAt
                                ? `Next: ${formatShortTime(wf.nextAt)}`
                                : "Scheduled"}
                          </span>
                          {wf.deliveryMode === "on_condition" && (
                            <>
                              <span>·</span>
                              <span>Silent watcher</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="overview-item-badges">
                        {lastPill ? (
                          <span
                            className={`pill${lastPill.tone ? ` ${lastPill.tone}` : ""}`}
                          >
                            {lastPill.label}
                          </span>
                        ) : (
                          <span className="pill">Ready</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function OverviewCapabilitiesCard({
  workspaceId,
  setup,
  operator,
}: {
  workspaceId: string;
  setup: OverviewSetup;
  operator: boolean;
}) {
  const autonomy = autonomyModeLabel(setup.autonomyMode);
  return (
    <section
      className="card overview-connection-card overview-capabilities-card"
      aria-label="Model and capabilities"
    >
      <div className="row overview-connection-heading">
        <h2>Model & capabilities</h2>
        <span className={`pill${autonomy.tone ? ` ${autonomy.tone}` : ""}`}>
          {autonomy.label}
        </span>
      </div>
      <dl className="overview-kv-list">
        <div className="overview-kv-row">
          <dt>Chat model</dt>
          <dd className="mono">{setup.chatModel || "Not configured"}</dd>
        </div>
        <div className="overview-kv-row">
          <dt>Web search</dt>
          <dd>{setup.searchProvider || "Disabled"}</dd>
        </div>
        <div className="overview-kv-row">
          <dt>Active skills</dt>
          <dd>
            <NavLink to={`/admin/skills?workspace=${workspaceId}`}>
              {setup.enabledSkills}{" "}
              {setup.enabledSkills === 1 ? "skill" : "skills"}
            </NavLink>
          </dd>
        </div>
      </dl>
      {setup.enabledPlugins.length > 0 && (
        <div className="overview-plugin-pills">
          {setup.enabledPlugins.map((plugin) =>
            plugin.path && operator ? (
              <NavLink
                key={plugin.id}
                to={`${plugin.path}?workspace=${workspaceId}`}
                className="pill overview-plugin-pill"
              >
                {plugin.label}
              </NavLink>
            ) : (
              <span key={plugin.id} className="pill overview-plugin-pill">
                {plugin.label}
              </span>
            ),
          )}
        </div>
      )}
    </section>
  );
}

export function OverviewDashboard({
  workspaceId,
  data,
  loading,
  operatorView,
}: {
  workspaceId: string;
  data?: Partial<OverviewResponse>;
  loading: boolean;
  operatorView: boolean;
}) {
  const hasExtendedData = !!(
    data?.usage7d ||
    data?.activity ||
    data?.metrics ||
    data?.attention
  );
  if (!loading && !hasExtendedData) return null;

  return (
    <div className="overview-dashboard">
      {data?.attention && data.attention.length > 0 && (
        <OverviewAttentionSection items={data.attention} />
      )}
      <div className="overview-grid">
        <div className="overview-col-main">
          {operatorView && (
            <OverviewCodingTasksCard
              workspaceId={workspaceId}
              tasks={data?.activity?.codingTasks}
              metrics={data?.metrics?.coding}
              loading={loading}
            />
          )}
          <OverviewThreadsCard
            workspaceId={workspaceId}
            threads={data?.activity?.threads}
            metrics={data?.metrics}
            loading={loading}
          />
        </div>
        <div className="overview-col-side">
          <OverviewUsageCard
            workspaceId={workspaceId}
            usage={data?.usage7d}
            loading={loading}
          />
          <OverviewMissionsAndAutomationsCard
            workspaceId={workspaceId}
            missions={data?.activity?.missions}
            workflows={data?.activity?.upcomingWorkflows}
            metrics={data?.metrics}
            loading={loading}
          />
        </div>
      </div>
    </div>
  );
}
