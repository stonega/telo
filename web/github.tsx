import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { GitHubRepository } from "../src/github/app.ts";
import type { GitHubPage } from "../src/github/config.ts";
import type { NotificationEvent } from "../src/github/notifications.ts";
import type { RepositorySyncSummary } from "../src/github/repository-sync.ts";
import type {
  EffectiveRepositoryRule,
  TriggerAuthors,
} from "../src/review-bot/config.ts";
import {
  GitHubRegistration,
  submitGitHubManifest,
} from "./github-registration.tsx";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { RepositoryCard } from "./repository-card.tsx";
import { Select } from "./select.tsx";
import { Skeleton, SkeletonRows } from "./skeleton.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
function explain(error: unknown) {
  const message = (error as Error).message;
  if (message.includes("version_conflict"))
    return "This workspace’s connection changed. Reload before trying again.";
  return (
    (
      {
        github_access_denied:
          "GitHub denied access. Check the App installation, organization approval and selected repositories.",
        github_authorization_expired:
          "GitHub authorization expired. Connect again to continue.",
        github_authorization_failed:
          "GitHub authorization failed. Please try again.",
        github_app_not_configured:
          "The GitHub App must be configured by your deployment operator.",
        github_unavailable: "GitHub is unavailable. Try again shortly.",
        github_selection_too_large:
          "Too many GitHub results. Limit the App installation to the repositories you need.",
        github_app_already_configured:
          "A GitHub App is already configured. Reload the connection to continue.",
      } as Record<string, string>
    )[message] ?? message
  );
}
export function GitHubSetup({
  request,
  workspaceId,
  onConnected,
}: {
  request: Request;
  workspaceId: string;
  onConnected: () => void;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github`;
  const [data, setData] = useState<GitHubPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [needsRepositoryChoice, setNeedsRepositoryChoice] = useState(false);
  const completed = useRef(false);
  const completing = useRef(false);
  const autoConnecting = useRef(false);
  const callback = new URLSearchParams(window.location.search).get("github");
  const requestedInstallation = Number(
    new URLSearchParams(window.location.search).get("installation_id"),
  );
  const selectedInstallation = data?.installations.find(
    (item) => item.id === requestedInstallation,
  );
  const needsInstallationSelection =
    !!data?.pending && data.installations.length > 1 && !selectedInstallation;
  const refresh = useCallback(async () => {
    try {
      setData(await request<GitHubPage>(endpoint));
    } catch (error) {
      setError(explain(error));
    }
  }, [request, endpoint]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (data?.connection?.installationId && !completed.current) {
      completed.current = true;
      onConnected();
    }
  }, [data, onConnected]);
  useEffect(() => {
    if (!data?.pending) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4000);
    const onFocus = () => {
      if (installing) completing.current = false;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [data?.pending, installing, refresh]);
  useEffect(() => {
    if (!data?.pending || completing.current) return;
    const installation =
      selectedInstallation ??
      (data.installations.length === 1 ? data.installations[0] : undefined);
    if (!installation) return;
    completing.current = true;
    setBusy(true);
    void (async () => {
      try {
        await request(endpoint, "PUT", {
          revision: data.revision,
          installationId: installation.id,
          allRepositories: true,
        });
        completed.current = true;
        onConnected();
      } catch (error) {
        if ((error as Error).message === "github_repository_not_connected") {
          setNeedsRepositoryChoice(true);
          setError(
            "Choose at least one repository for the App in GitHub, then return here.",
          );
        } else setError(explain(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [data, endpoint, onConnected, request, selectedInstallation]);
  const connect = useCallback(async () => {
    if (!data || busy) return;
    if (data.pending) {
      if (data.installations.length && error && !needsRepositoryChoice) {
        completing.current = false;
        void refresh();
        return;
      }
      if (data.installUrl) {
        window.open(data.installUrl, "_blank", "noopener,noreferrer");
        setInstalling(true);
      }
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (data.configured) {
        const result = await request<{ url: string }>(
          `${endpoint}/connect`,
          "POST",
          { source: "setup" },
        );
        window.location.assign(result.url);
      } else if (data.canRegister) {
        const result = await request<{ url: string; manifest: object }>(
          `${endpoint}/register`,
          "POST",
          {
            owner: "personal",
            name: "telo",
            public: false,
            source: "setup",
          },
        );
        submitGitHubManifest(result);
      } else {
        setError("A GitHub App is not available for this deployment.");
      }
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [busy, data, endpoint, error, needsRepositoryChoice, refresh, request]);
  useEffect(() => {
    if (
      callback !== "app-created" ||
      !data?.configured ||
      data.pending ||
      data.connection?.installationId ||
      autoConnecting.current
    )
      return;
    autoConnecting.current = true;
    void connect();
  }, [callback, connect, data]);
  return (
    <>
      {callback === "failed" && (
        <p className="notice" role="alert">
          GitHub authorization did not complete. Try connecting again.
        </p>
      )}
      {callback === "registration-failed" && (
        <p className="notice" role="alert">
          GitHub App creation did not complete. Try connecting again.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <SkeletonRows label="GitHub connection" rows={1} />}
      {data?.pending && !completed.current && (
        <p className="muted" role="status">
          {needsInstallationSelection
            ? "Several App installations are available. Choose the right account in Plugins."
            : data.installations.length
              ? "Connecting the repositories approved in GitHub…"
              : installing
                ? "Complete the installation in GitHub. This page will continue when the App has repository access."
                : "GitHub account authorized. Install the App to grant repository access."}
        </p>
      )}
      {needsInstallationSelection && (
        <a href={`/admin/plugins?workspace=${workspaceId}`}>
          Choose an account in Plugins
        </a>
      )}
      {data && !data.connection?.installationId && (
        <button
          type="button"
          disabled={
            busy ||
            (!data.configured && !data.canRegister) ||
            needsInstallationSelection
          }
          onClick={() => void connect()}
        >
          {busy ? "Connecting GitHub…" : "Connect GitHub"}
        </button>
      )}
    </>
  );
}
export function GitHubConnection({
  request,
  workspaceId,
  source,
  open,
  onClose,
  onUpdated,
}: {
  request: Request;
  workspaceId: string;
  source?: "setup";
  open?: boolean;
  onClose?: () => void;
  onUpdated?: () => void;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/github`;
  const [data, setData] = useState<GitHubPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncNotice, setSyncNotice] = useState("");
  const [installation, setInstallation] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [selectAllMode, setSelectAllMode] = useState(false);
  const [showAllRepositories, setShowAllRepositories] = useState(false);
  const [editingRule, setEditingRule] = useState<{
    repositoryId: number;
    fullName: string;
    mode: "inherit" | "custom" | "disabled";
    autoReview: boolean;
    allowAutoClose: boolean;
    acceptRequests: boolean;
    allowFixes: boolean;
    prTriggerAuthors: TriggerAuthors;
    prInstructions: string;
    issueAutoReply: boolean;
    issueAutoFix: boolean;
    issueAllowAutoClose: boolean;
    issueAcceptRequests: boolean;
    issueTriggerAuthors: TriggerAuthors;
    issueTriggerLabels: string;
    issueInstructions: string;
    instructions: string;
    notificationAction: "" | "subscribe" | "pause" | "resume" | "delete";
    notificationEvents: NotificationEvent[];
  }>();
  const [ruleError, setRuleError] = useState("");
  const [params, setParams] = useSearchParams();
  const [internalOpen, setInternalOpen] = useState(() => params.has("github"));
  useEffect(() => {
    if (open === undefined && params.has("github")) setInternalOpen(true);
  }, [open, params]);
  const close = () => {
    setInternalOpen(false);
    onClose?.();
    setShowAllRepositories(false);
    setSyncNotice("");
    if (params.has("github")) {
      const next = new URLSearchParams(params);
      next.delete("github");
      setParams(next, { replace: true });
    }
  };
  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    setRefreshError("");
    setSyncNotice("");
    try {
      setData(await request<GitHubPage>(endpoint));
      setInstallation("");
      setRepositories([]);
      setSelected([]);
      setSelectAllMode(false);
      setShowAllRepositories(false);
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  }, [request, endpoint]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Discard data and drafts when the workspace endpoint changes.
  useEffect(() => {
    setData(undefined);
    setError("");
    setRefreshError("");
    setSyncNotice("");
    setInstallation("");
    setRepositories([]);
    setSelected([]);
    setSelectAllMode(false);
    setShowAllRepositories(false);
  }, [endpoint]);
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const page = await request<GitHubPage>(
          endpoint,
          "GET",
          undefined,
          signal,
        );
        const choices =
          installation && page.pending
            ? await request<GitHubRepository[]>(
                `${endpoint}/installations/${installation}/repositories`,
                "GET",
                undefined,
                signal,
              )
            : undefined;
        if (signal.aborted) return;
        setData(page);
        setRefreshError("");
        if (choices) {
          setRepositories(choices);
          setSelected((ids) =>
            ids.filter((id) => choices.some((r) => r.id === id)),
          );
        }
      } catch (error) {
        if (!signal.aborted) setRefreshError(explain(error));
      }
    },
    [endpoint, installation, request],
  );
  useRepositoryRefresh(
    refresh,
    (open ?? internalOpen) && !busy && !editingRule,
  );
  const openRuleEditor = (repo: GitHubRepository) => {
    const rule: EffectiveRepositoryRule = data?.repositoryRules?.[
      String(repo.id)
    ] ?? {
      enabled: data?.reviewSettings?.enabled ?? false,
      hasOverride: false,
      autoReview: data?.reviewSettings?.autoReview ?? true,
      allowAutoClose: data?.reviewSettings?.allowAutoClose ?? false,
      acceptRequests: data?.reviewSettings?.acceptRequests ?? true,
      allowFixes: data?.reviewSettings?.allowFixes ?? false,
      prTriggerAuthors: data?.reviewSettings?.prTriggerAuthors ?? "all",
      prInstructions: data?.reviewSettings?.prInstructions,
      issueAutoReply: data?.reviewSettings?.issueAutoReply ?? false,
      issueAutoFix: data?.reviewSettings?.issueAutoFix ?? false,
      issueAllowAutoClose: data?.reviewSettings?.issueAllowAutoClose ?? false,
      issueAcceptRequests: data?.reviewSettings?.issueAcceptRequests ?? false,
      issueTriggerAuthors: data?.reviewSettings?.issueTriggerAuthors ?? "all",
      issueTriggerLabels: data?.reviewSettings?.issueTriggerLabels ?? [],
      issueInstructions: data?.reviewSettings?.issueInstructions,
      instructions: data?.reviewSettings?.instructions,
    };
    const sub = data?.subscriptions?.find((s) => s.repositoryId === repo.id);
    setRuleError("");
    setEditingRule({
      repositoryId: repo.id,
      fullName: repo.full_name,
      mode: !rule.hasOverride
        ? "inherit"
        : rule.enabled
          ? "custom"
          : "disabled",
      autoReview: rule.autoReview,
      allowAutoClose: rule.allowAutoClose,
      acceptRequests: rule.acceptRequests,
      allowFixes: rule.allowFixes,
      prTriggerAuthors: rule.prTriggerAuthors,
      prInstructions: rule.prInstructions ?? "",
      issueAutoReply: rule.issueAutoReply,
      issueAutoFix: rule.issueAutoFix,
      issueAllowAutoClose: rule.issueAllowAutoClose,
      issueAcceptRequests: rule.issueAcceptRequests,
      issueTriggerAuthors: rule.issueTriggerAuthors,
      issueTriggerLabels: rule.issueTriggerLabels.join(", "),
      issueInstructions: rule.issueInstructions ?? "",
      instructions: rule.instructions ?? "",
      notificationAction: "",
      notificationEvents: sub?.events ?? ["pull_request", "issues"],
    });
  };
  const summarizeRule = (repoId: number) => {
    const rule = data?.repositoryRules?.[String(repoId)];
    const sub = data?.subscriptions?.find((s) => s.repositoryId === repoId);
    const items: string[] = [];
    if (rule?.hasOverride) {
      if (!rule.enabled) {
        items.push("Automation disabled");
      } else {
        const prParts: string[] = [];
        if (rule.autoReview) prParts.push("auto-review");
        if (rule.allowAutoClose) prParts.push("auto-close");
        if (rule.allowFixes) prParts.push("fixes");
        if (prParts.length) items.push(`PR: ${prParts.join(", ")}`);
        const issueParts: string[] = [];
        if (rule.issueAutoReply) issueParts.push("auto-reply");
        if (rule.issueAutoFix) issueParts.push("auto-fix");
        if (rule.issueAllowAutoClose) issueParts.push("auto-close");
        if (issueParts.length) items.push(`Issue: ${issueParts.join(", ")}`);
        if (
          rule.prInstructions ||
          rule.issueInstructions ||
          rule.instructions
        ) {
          items.push("Natural-language rules");
        }
      }
    }
    if (sub) {
      items.push(
        sub.enabled
          ? `Notifications: ${sub.events.map((e) => (e === "issues" ? "issues" : "PRs")).join(" & ")}`
          : "Notifications paused",
      );
    }
    return items.join(" · ");
  };
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setSyncNotice("");
    try {
      await action();
    } catch (error) {
      setError(explain(error));
    } finally {
      setBusy(false);
    }
  };
  const syncRepositories = async (allRepositories?: boolean) => {
    if (!data?.connection?.installationId) return;
    await act(async () => {
      const result = await request<
        GitHubPage & { syncResult?: RepositorySyncSummary }
      >(`${endpoint}/sync`, "POST", {
        revision: data.revision,
        ...(allRepositories !== undefined ? { allRepositories } : {}),
      });
      const { syncResult, ...page } = result;
      setData(page);
      setRefreshError("");
      onUpdated?.();
      if (syncResult) {
        const delta: string[] = [];
        if (syncResult.added > 0) delta.push(`${syncResult.added} added`);
        if (syncResult.removed > 0) delta.push(`${syncResult.removed} removed`);
        const suffix = delta.length ? ` (${delta.join(", ")})` : "";
        if (allRepositories === true) {
          setSyncNotice(
            `All-repository auto-sync enabled. ${syncResult.total} ${syncResult.total === 1 ? "repository" : "repositories"} connected${suffix}.`,
          );
        } else if (allRepositories === false) {
          setSyncNotice(
            `Switched to selected repositories only. ${syncResult.total} ${syncResult.total === 1 ? "repository" : "repositories"} remain connected.`,
          );
        } else if (syncResult.changed) {
          setSyncNotice(
            `Repositories synced: ${syncResult.total} connected${suffix}.`,
          );
        } else {
          setSyncNotice(
            `Repositories are up to date (${syncResult.total} connected).`,
          );
        }
      }
    });
  };
  return (
    <>
      {(open ?? internalOpen) && (
        <Modal title="Manage GitHub" onClose={close} busy={busy}>
          <div className="github-details">
            {data ? (
              <span className="pill">
                {data.connection?.installationId
                  ? "Connected"
                  : "Not connected"}
              </span>
            ) : (
              !error && !refreshError && <Skeleton width="7rem" />
            )}
            <p>
              Connect a GitHub App to give this workspace source access to
              selected repositories and submit issues after approval in
              Telegram.
            </p>
            {params.get("github") === "failed" && (
              <p className="notice" role="alert">
                GitHub authorization did not complete. Connect again to retry.
              </p>
            )}
            {(error || refreshError) && (
              <p className="notice" role="alert">
                {error || refreshError}
              </p>
            )}
            {data?.refreshError && (
              <p className="notice" role="status">
                Repository updates are temporarily unavailable. Showing the last
                saved list. {explain(new Error(data.refreshError))}
              </p>
            )}
            {syncNotice && !data?.refreshError && !error && !refreshError && (
              <p className="notice" role="status">
                {syncNotice}
              </p>
            )}
            {params.get("github") === "registration-failed" && (
              <p className="notice" role="alert">
                GitHub App setup did not complete. Reload the page to check
                whether an App is already configured. If GitHub created an App
                but setup failed here, remove that unused App in GitHub before
                retrying, or configure it manually.
              </p>
            )}
            {params.get("github") === "app-created" && data?.configured && (
              <p role="status">
                GitHub App created. Install it on the repositories you need,
                then connect this workspace.
              </p>
            )}
            {!data && !error && !refreshError && (
              <SkeletonRows label="GitHub connection" rows={2} />
            )}
            {data?.canRegister && (
              <GitHubRegistration
                request={request}
                endpoint={endpoint}
                onError={(error) => setError(explain(error))}
                source={source}
              />
            )}
            {data && !data.configured && !data.canRegister && (
              <p className="notice">
                A deployment operator must register and configure the GitHub App
                before connecting.
              </p>
            )}
            {data?.configured && (
              <p>
                {data.appSlug && (
                  <>
                    App: <strong>{data.appSlug}</strong>.{" "}
                  </>
                )}
                <a href={data.installUrl} target="_blank" rel="noreferrer">
                  Install or update the GitHub App
                </a>
              </p>
            )}
            {data?.connection?.installationId && (
              <>
                <p>
                  Connected to <strong>{data.connection.account}</strong> by{" "}
                  {data.connection.connectedBy}.{" "}
                  <span className="muted">
                    {data.connection.allRepositories
                      ? "All repositories (auto-sync)"
                      : "Selected repositories"}
                  </span>
                </p>
                <p className="muted">
                  To submit issues, grant the App Issues: read and write in
                  GitHub and approve the updated installation permissions. Then
                  ask the Telegram assistant to draft an issue and review its
                  Approve/Reject buttons.
                </p>
                <div className="row github-repository-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void syncRepositories()}
                  >
                    Sync repositories
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void syncRepositories(!data.connection?.allRepositories)
                    }
                  >
                    {data.connection.allRepositories
                      ? "Use selected only"
                      : "Auto-sync all repositories"}
                  </button>
                  {data.configured && !data.pending && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await request<{ url: string }>(
                            `${endpoint}/connect`,
                            "POST",
                            source ? { source } : {},
                          );
                          window.location.assign(result.url);
                        })
                      }
                    >
                      Change repositories
                    </button>
                  )}
                </div>
                <div className="github-repositories">
                  <div className="github-repositories-header">
                    <span className="github-repositories-title">
                      Connected repositories
                    </span>
                    <span className="muted github-repositories-count">
                      {data.connection.repositories.length}{" "}
                      {data.connection.repositories.length === 1
                        ? "repository"
                        : "repositories"}
                    </span>
                  </div>
                  {data.connection.repositories.length === 0 ? (
                    <p className="muted">No repositories connected.</p>
                  ) : (
                    <ul
                      className="repository-list"
                      aria-label="Connected repositories"
                    >
                      {(showAllRepositories
                        ? data.connection.repositories
                        : data.connection.repositories.slice(0, 5)
                      ).map((repo) => {
                        const summary = summarizeRule(repo.id);
                        return (
                          <li className="repository-list-item" key={repo.id}>
                            <RepositoryCard
                              compact
                              name={repo.full_name}
                              url={`https://github.com/${repo.full_name}`}
                              actions={
                                <IconButton
                                  icon="edit"
                                  label={`Configure ${repo.full_name}`}
                                  disabled={busy}
                                  onClick={() => openRuleEditor(repo)}
                                />
                              }
                            >
                              {summary ? (
                                <p className="muted">{summary}</p>
                              ) : undefined}
                            </RepositoryCard>
                          </li>
                        );
                      })}
                      {data.connection.repositories.length > 5 && (
                        <li className="repository-list-item">
                          <button
                            type="button"
                            className="github-repository-more"
                            aria-expanded={showAllRepositories}
                            onClick={() =>
                              setShowAllRepositories(!showAllRepositories)
                            }
                          >
                            {showAllRepositories
                              ? "Show less"
                              : `${data.connection.repositories.length - 5} more`}
                          </button>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              </>
            )}
            {data?.configured && !data.connection && (
              <p className="muted">
                Existing deployment credentials may apply until you connect or
                disconnect this workspace.
              </p>
            )}
            {data?.connection && !data.connection.installationId && (
              <p className="muted">
                Private repository access is disconnected. Public repositories
                can still be queried.
              </p>
            )}
            {((data?.configured && !data.connection?.installationId) ||
              error ||
              refreshError) && (
              <div className="row">
                {data?.configured && !data.connection?.installationId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await request<{ url: string }>(
                          `${endpoint}/connect`,
                          "POST",
                          source ? { source } : {},
                        );
                        window.location.assign(result.url);
                      })
                    }
                  >
                    Connect GitHub
                  </button>
                )}
                {(error || refreshError) && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void load()}
                  >
                    Reload GitHub connection
                  </button>
                )}
              </div>
            )}
            {data?.pending && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await request(
                      endpoint,
                      "PUT",
                      selectAllMode
                        ? {
                            revision: data.revision,
                            installationId: Number(installation),
                            allRepositories: true,
                          }
                        : {
                            revision: data.revision,
                            installationId: Number(installation),
                            repositoryIds: selected,
                          },
                    );
                    window.location.reload();
                  });
                }}
              >
                <h3>Choose repositories for this workspace</h3>
                <p>
                  Authorized as {data.login}. Select an installation, then the
                  repositories this workspace may query and submit issues to.
                </p>
                <p>
                  After GitHub approves the installation, reopen this page to
                  see it.
                </p>
                <fieldset disabled={busy} className="plugin-fields">
                  <label className="field" htmlFor="github-installation">
                    <span>GitHub installation</span>
                    <Select
                      id="github-installation"
                      required
                      value={installation}
                      onChange={(event) => {
                        const id = event.target.value;
                        setInstallation(id);
                        setRepositories([]);
                        setSelected([]);
                        setSelectAllMode(false);
                        if (id)
                          void act(async () =>
                            setRepositories(
                              await request<GitHubRepository[]>(
                                `${endpoint}/installations/${id}/repositories`,
                              ),
                            ),
                          );
                      }}
                    >
                      <option value="">Choose an account</option>
                      {data.installations.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.account}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {!data.installations.length && (
                    <p>
                      No accessible installations yet. Install the App or ask
                      your organization owner to approve it, then reopen this
                      page.
                    </p>
                  )}
                  {!!installation && !repositories.length && (
                    <p>No accessible repositories in this installation.</p>
                  )}
                  {!!installation && repositories.length > 0 && (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={selectAllMode}
                        onChange={(e) => setSelectAllMode(e.target.checked)}
                      />
                      All repositories (sync new repositories automatically)
                    </label>
                  )}
                  {!selectAllMode &&
                    repositories.map((repo) => (
                      <label className="checkbox" key={repo.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(repo.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, repo.id]
                                : selected.filter((id) => id !== repo.id),
                            )
                          }
                        />
                        {repo.full_name}
                      </label>
                    ))}
                  <button
                    type="submit"
                    disabled={
                      !installation ||
                      (selectAllMode ? !repositories.length : !selected.length)
                    }
                  >
                    {selectAllMode
                      ? "Connect all repositories"
                      : "Connect selected repositories"}
                  </button>
                </fieldset>
              </form>
            )}
          </div>
        </Modal>
      )}
      {editingRule && (
        <Modal
          title={`Configure ${editingRule.fullName}`}
          busy={busy}
          onClose={() => {
            setEditingRule(undefined);
            setRuleError("");
          }}
        >
          <form
            className="record-form"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setRuleError("");
              const labels = editingRule.issueTriggerLabels
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              void request<GitHubPage>(
                `${endpoint}/repositories/${editingRule.repositoryId}/rules`,
                "PUT",
                {
                  revision: data?.reviewRevision,
                  mode: editingRule.mode,
                  ...(editingRule.mode === "custom"
                    ? {
                        rule: {
                          enabled: true,
                          autoReview: editingRule.autoReview,
                          allowAutoClose: editingRule.allowAutoClose,
                          acceptRequests: editingRule.acceptRequests,
                          allowFixes: editingRule.allowFixes,
                          prTriggerAuthors: editingRule.prTriggerAuthors,
                          ...(editingRule.prInstructions.trim()
                            ? {
                                prInstructions:
                                  editingRule.prInstructions.trim(),
                              }
                            : {}),
                          issueAutoReply: editingRule.issueAutoReply,
                          issueAutoFix: editingRule.issueAutoFix,
                          issueAllowAutoClose: editingRule.issueAllowAutoClose,
                          issueAcceptRequests: editingRule.issueAcceptRequests,
                          issueTriggerAuthors: editingRule.issueTriggerAuthors,
                          ...(labels.length
                            ? { issueTriggerLabels: labels }
                            : {}),
                          ...(editingRule.issueInstructions.trim()
                            ? {
                                issueInstructions:
                                  editingRule.issueInstructions.trim(),
                              }
                            : {}),
                          ...(editingRule.instructions.trim()
                            ? {
                                instructions: editingRule.instructions.trim(),
                              }
                            : {}),
                        },
                      }
                    : {}),
                  ...(editingRule.notificationAction
                    ? {
                        notificationAction: editingRule.notificationAction,
                        ...(editingRule.notificationAction === "subscribe"
                          ? {
                              notificationEvents:
                                editingRule.notificationEvents,
                            }
                          : {}),
                      }
                    : {}),
                },
              )
                .then((updated) => {
                  setData(updated);
                  setEditingRule(undefined);
                  onUpdated?.();
                })
                .catch((err) => {
                  setRuleError(explain(err));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <div className="field">
              <label htmlFor="repo-rule-mode">Automation mode</label>
              <Select
                id="repo-rule-mode"
                value={editingRule.mode}
                disabled={busy}
                onChange={(e) =>
                  setEditingRule({
                    ...editingRule,
                    mode: e.target.value as "inherit" | "custom" | "disabled",
                  })
                }
              >
                <option value="inherit">Inherit workspace default</option>
                <option value="custom">Custom repository rules</option>
                <option value="disabled">
                  Disable automation for this repository
                </option>
              </Select>
            </div>
            {editingRule.mode === "custom" && (
              <>
                <fieldset className="plugin-fields" disabled={busy}>
                  <legend>Pull requests</legend>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.autoReview}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          autoReview: e.target.checked,
                        })
                      }
                    />
                    Automatically review open PRs and new commits
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.allowAutoClose}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          allowAutoClose: e.target.checked,
                        })
                      }
                    />
                    Allow automatic PR closing when rules match
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.acceptRequests}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          acceptRequests: e.target.checked,
                        })
                      }
                    />
                    Accept @bot comments on PRs
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.allowFixes}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          allowFixes: e.target.checked,
                        })
                      }
                    />
                    Allow @bot fix requests on PRs
                  </label>
                  <div className="field">
                    <label htmlFor="repo-pr-trigger-authors">
                      Automatic PR trigger authors
                    </label>
                    <Select
                      id="repo-pr-trigger-authors"
                      value={editingRule.prTriggerAuthors}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          prTriggerAuthors: e.target.value as TriggerAuthors,
                        })
                      }
                    >
                      <option value="all">All authors</option>
                      <option value="collaborators">
                        Verified collaborators
                      </option>
                      <option value="maintainers">Maintainers only</option>
                    </Select>
                  </div>
                  <div className="field">
                    <label htmlFor="repo-pr-instructions">
                      PR natural-language rules (optional)
                    </label>
                    <textarea
                      id="repo-pr-instructions"
                      rows={2}
                      maxLength={4000}
                      placeholder="e.g. Focus on security boundaries; automatically close PRs that modify production config or lack a linked issue."
                      value={editingRule.prInstructions}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          prInstructions: e.target.value,
                        })
                      }
                    />
                  </div>
                </fieldset>
                <fieldset className="plugin-fields" disabled={busy}>
                  <legend>Issues</legend>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.issueAutoReply}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueAutoReply: e.target.checked,
                        })
                      }
                    />
                    Automatically analyze and reply to new issues
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.issueAutoFix}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueAutoFix: e.target.checked,
                        })
                      }
                    />
                    Automatically fix issues and open a pull request
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.issueAllowAutoClose}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueAllowAutoClose: e.target.checked,
                        })
                      }
                    />
                    Allow automatic issue closing when rules match
                  </label>
                  <label className="form-check">
                    <input
                      type="checkbox"
                      checked={editingRule.issueAcceptRequests}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueAcceptRequests: e.target.checked,
                        })
                      }
                    />
                    Accept @bot comments on issues (explain, fix, close)
                  </label>
                  <div className="field">
                    <label htmlFor="repo-issue-trigger-authors">
                      Automatic issue trigger authors
                    </label>
                    <Select
                      id="repo-issue-trigger-authors"
                      value={editingRule.issueTriggerAuthors}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueTriggerAuthors: e.target.value as TriggerAuthors,
                        })
                      }
                    >
                      <option value="all">All authors</option>
                      <option value="collaborators">
                        Verified collaborators
                      </option>
                      <option value="maintainers">Maintainers only</option>
                    </Select>
                  </div>
                  <div className="field">
                    <label htmlFor="repo-issue-labels">
                      Issue trigger labels (optional, comma-separated)
                    </label>
                    <input
                      id="repo-issue-labels"
                      type="text"
                      placeholder="e.g. bug, auto-fix"
                      value={editingRule.issueTriggerLabels}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueTriggerLabels: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="repo-issue-instructions">
                      Issue natural-language rules (optional)
                    </label>
                    <textarea
                      id="repo-issue-instructions"
                      rows={2}
                      maxLength={4000}
                      placeholder="e.g. Reply in Chinese with root-cause analysis. If it is a reproducible bug, fix it and open a PR; if it is a question, only reply."
                      value={editingRule.issueInstructions}
                      onChange={(e) =>
                        setEditingRule({
                          ...editingRule,
                          issueInstructions: e.target.value,
                        })
                      }
                    />
                  </div>
                </fieldset>
                <div className="field">
                  <label htmlFor="repo-shared-instructions">
                    Shared repository rule instructions (optional)
                  </label>
                  <textarea
                    id="repo-shared-instructions"
                    rows={2}
                    maxLength={4000}
                    placeholder="General instructions applied to both PRs and issues in this repository."
                    value={editingRule.instructions}
                    onChange={(e) =>
                      setEditingRule({
                        ...editingRule,
                        instructions: e.target.value,
                      })
                    }
                  />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="repo-notification-action">
                Personal Telegram notifications
              </label>
              <Select
                id="repo-notification-action"
                value={editingRule.notificationAction}
                disabled={busy}
                onChange={(e) =>
                  setEditingRule({
                    ...editingRule,
                    notificationAction: e.target.value as
                      | ""
                      | "subscribe"
                      | "pause"
                      | "resume"
                      | "delete",
                  })
                }
              >
                <option value="">Keep current notification setting</option>
                <option value="subscribe">Subscribe to notifications</option>
                <option value="pause">Pause notifications</option>
                <option value="resume">Resume notifications</option>
                <option value="delete">Remove personal override</option>
              </Select>
            </div>
            {editingRule.notificationAction === "subscribe" && (
              <fieldset className="plugin-fields" disabled={busy}>
                <legend>Notification events</legend>
                {(
                  [
                    ["pull_request", "New PRs"],
                    ["issues", "New issues"],
                  ] as const
                ).map(([ev, label]) => (
                  <label className="form-check" key={ev}>
                    <input
                      type="checkbox"
                      checked={editingRule.notificationEvents.includes(ev)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...editingRule.notificationEvents, ev]
                          : editingRule.notificationEvents.filter(
                              (x) => x !== ev,
                            );
                        if (next.length > 0) {
                          setEditingRule({
                            ...editingRule,
                            notificationEvents: next,
                          });
                        }
                      }}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
            {ruleError && (
              <p className="notice" role="alert">
                {ruleError}
              </p>
            )}
            <ModalActions>
              <button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save rules"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
    </>
  );
}
