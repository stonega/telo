import { z } from "zod";
import { Fault, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApp } from "../github/app.ts";
import { githubConnectionRevision } from "../github/config.ts";
import {
  authorizeVerifiedRepository,
  githubAccessPending,
} from "../github/user-access.ts";
import { branchName } from "./config.ts";
import type { DevelopmentInput, DevelopmentTask } from "./development.ts";

export const referenceSource = z.object({
  repositoryId: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  connectionRevision: z.number().int().nonnegative(),
  repositoryRevision: z.number().int().nonnegative(),
  ref: branchName,
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  revision: z.number().int().positive(),
});
export type ReferenceSource = z.infer<typeof referenceSource>;
export const referencePath = (
  source: Pick<ReferenceSource, "repositoryId">,
  root = "/task",
) => `${root}/references/${source.repositoryId}`;

export function checkReferenceSources(
  w: Workspace,
  task: DevelopmentTask,
  actors: string[],
) {
  for (const source of task.referenceSources ?? []) {
    const repository = w.github?.repositories.find(
      (r) => r.id === source.repositoryId,
    );
    requireThat(
      w.github?.installationId === source.installationId &&
        githubConnectionRevision(w.github) === source.connectionRevision &&
        (w.github.repositoryRevisions?.[source.repositoryId] ?? 0) ===
          source.repositoryRevision &&
        repository?.full_name === source.repository &&
        !repository.archived &&
        !repository.disabled,
      "coding_reference_source_changed",
      409,
    );
    for (const actor of actors)
      authorizeVerifiedRepository(w, actor, source.repositoryId);
  }
}

function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, "i").test(text);
}

function linksRepository(text: string, repository: string) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `https://github\\.com/${escaped}(?:\\.git)?(?=[/?#\\s)>]|$)`,
    "i",
  ).test(text);
}

export interface ReferenceContextSource {
  id: string;
  author: string;
  text: string;
}

export function normalizeReferenceRepositoryIds(
  w: Workspace,
  targetRepositoryId: number,
  actors: string[],
  ids: readonly number[] = [],
  groupBound = false,
) {
  const unique: number[] = [];
  for (const id of ids) {
    requireThat(
      Number.isInteger(id) && id > 0,
      "coding_reference_source_unavailable",
      409,
    );
    if (id === targetRepositoryId || unique.includes(id)) continue;
    unique.push(id);
  }
  requireThat(unique.length <= 4, "coding_reference_source_limit", 409);
  const repositories = w.github?.repositories ?? [];
  for (const id of unique) {
    const repository = repositories.find((r) => r.id === id);
    requireThat(
      repository &&
        !repository.archived &&
        !repository.disabled &&
        (!groupBound || repository.private === false),
      "coding_reference_source_unavailable",
      409,
    );
    for (const actor of new Set(actors))
      authorizeVerifiedRepository(w, actor, repository.id);
  }
  return unique;
}

/** Only authenticated task inputs, contributor context, or explicitly validated IDs can select an additional readable repository. */
export function requestedReferences(
  w: Workspace,
  task: DevelopmentTask,
  inputs: DevelopmentInput[],
  contextSources: readonly ReferenceContextSource[] = [],
) {
  const repositories = w.github?.repositories ?? [];
  const contributors = [
    ...new Set([task.actor, ...inputs.map((input) => input.actor)]),
  ];
  const contributorSet = new Set(contributors);
  const groupBound = !!task.groupRepository;
  const text = [
    ...inputs.map((input) => input.text),
    ...contextSources
      .filter(
        (source) =>
          source.author !== "assistant" &&
          /^[1-9]\d{0,15}$/.test(source.author) &&
          contributorSet.has(source.author),
      )
      .map((source) => source.text),
  ].join("\n");
  const explicitIds = normalizeReferenceRepositoryIds(
    w,
    task.payload.repositoryId,
    contributors,
    task.requestedReferenceRepositoryIds ?? [],
    groupBound,
  );
  const explicit = explicitIds.map((id) => {
    const repository = repositories.find((r) => r.id === id);
    requireThat(repository, "coding_reference_source_unavailable", 409);
    return repository;
  });
  const mentioned = repositories.filter((repository) => {
    if (repository.id === task.payload.repositoryId) return false;
    if (explicitIds.includes(repository.id)) return false;
    if (groupBound && repository.private !== false) return false;
    const name = repository.full_name.split("/")[1] ?? "";
    return (
      mentions(text, repository.full_name) ||
      linksRepository(text, repository.full_name) ||
      (repositories.filter(
        (r) => r.full_name.split("/")[1]?.toLowerCase() === name.toLowerCase(),
      ).length === 1 &&
        mentions(text, name))
    );
  });
  const requested = [...explicit, ...mentioned];
  requireThat(requested.length <= 4, "coding_reference_source_limit", 409);
  for (const repository of requested) {
    requireThat(
      !repository.archived &&
        !repository.disabled &&
        (!groupBound || repository.private === false),
      "coding_reference_source_unavailable",
      409,
    );
    for (const actor of contributors)
      authorizeVerifiedRepository(w, actor, repository.id);
  }
  return requested;
}

export async function pinReferenceSources(
  w: Workspace,
  task: DevelopmentTask,
  inputs: DevelopmentInput[],
  app: GitHubApp,
  contextSources: readonly ReferenceContextSource[] = [],
) {
  const requested = requestedReferences(w, task, inputs, contextSources);
  if (!requested.length) return [];
  requireThat(w.github?.installationId, "github_repository_not_connected", 409);
  const retained = new Map(
    (task.referenceSources ?? [])
      .filter(
        (source) =>
          task.phase !== "intake" || source.revision === task.revision,
      )
      .map((source) => [source.repositoryId, source]),
  );
  const missing = requested.filter(
    (repository) => !retained.has(repository.id),
  );
  if (!missing.length)
    return requested.map(
      (repository) => retained.get(repository.id) as ReferenceSource,
    );
  const { token } = await app.installationToken(
    w.github.installationId,
    missing.map((repository) => repository.id),
    "contents",
  );
  const sources: ReferenceSource[] = [];
  for (const repository of requested) {
    const prior = retained.get(repository.id);
    if (prior) {
      sources.push(prior);
      continue;
    }
    let ref: string;
    let commit: { sha: string };
    try {
      ref = branchName.parse(repository.default_branch);
      commit = z
        .object({ sha: referenceSource.shape.sha })
        .parse(
          await app.skillResource(
            token,
            repository.full_name,
            `commits/${encodeURIComponent(ref)}`,
          ),
        );
    } catch (error) {
      if (githubAccessPending(error)) throw error;
      throw new Fault("coding_reference_source_unavailable", 409);
    }
    sources.push({
      repositoryId: repository.id,
      repository: repository.full_name,
      installationId: w.github.installationId,
      connectionRevision: githubConnectionRevision(w.github),
      repositoryRevision: w.github.repositoryRevisions?.[repository.id] ?? 0,
      ref,
      sha: commit.sha,
      revision: task.revision,
    });
  }
  return sources;
}
