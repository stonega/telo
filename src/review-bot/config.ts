import { z } from "zod";
import {
  type CodingPayload,
  withoutRepositoryGrants,
} from "../coding/config.ts";
import type {
  DevelopmentResult,
  DevelopmentRun,
} from "../coding/development.ts";
import type { Workspace } from "../domain.ts";
import type { RuntimeProvider } from "../models/config.ts";
import { modelSelectionSchema } from "../models/config.ts";

export const triggerAuthorsSchema = z.enum([
  "all",
  "collaborators",
  "maintainers",
]);
export type TriggerAuthors = z.infer<typeof triggerAuthorsSchema>;

export const repositoryAutomationRuleSchema = z
  .object({
    enabled: z.boolean().default(true),
    autoReview: z.boolean().optional(),
    allowAutoClose: z.boolean().optional(),
    acceptRequests: z.boolean().optional(),
    allowFixes: z.boolean().optional(),
    prTriggerAuthors: triggerAuthorsSchema.optional(),
    prInstructions: z.string().trim().max(4000).optional(),
    issueAutoReply: z.boolean().optional(),
    issueAutoFix: z.boolean().optional(),
    issueAllowAutoClose: z.boolean().optional(),
    issueAcceptRequests: z.boolean().optional(),
    issueTriggerAuthors: triggerAuthorsSchema.optional(),
    issueTriggerLabels: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .optional(),
    issueInstructions: z.string().trim().max(4000).optional(),
    instructions: z.string().trim().max(4000).optional(),
  })
  .strict();
export type RepositoryAutomationRule = z.infer<
  typeof repositoryAutomationRuleSchema
>;

export const reviewSettings = z.preprocess(
  withoutRepositoryGrants,
  z
    .object({
      enabled: z.boolean(),
      autoReview: z.boolean().default(true),
      acceptRequests: z.boolean().default(true),
      allowFixes: z.boolean().default(false),
      allowAutoClose: z.boolean().optional(),
      prTriggerAuthors: triggerAuthorsSchema.optional(),
      prInstructions: z.string().trim().max(4000).optional(),
      issueAutoReply: z.boolean().optional(),
      issueAutoFix: z.boolean().optional(),
      issueAllowAutoClose: z.boolean().optional(),
      issueAcceptRequests: z.boolean().optional(),
      issueTriggerAuthors: triggerAuthorsSchema.optional(),
      issueTriggerLabels: z
        .array(z.string().trim().min(1).max(100))
        .max(20)
        .optional(),
      issueInstructions: z.string().trim().max(4000).optional(),
      instructions: z.string().trim().max(4000).optional(),
      repositoryRules: z
        .record(z.string().regex(/^\d+$/), repositoryAutomationRuleSchema)
        .optional(),
      model: modelSelectionSchema.optional(),
    })
    .strict(),
);
export const reviewSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: reviewSettings,
  })
  .strict();
export type ReviewSettings = z.infer<typeof reviewSettings>;
export interface ReviewConfig {
  revision: number;
  settings: ReviewSettings;
}
export const emptyReview: ReviewSettings = {
  enabled: false,
  autoReview: true,
  acceptRequests: true,
  allowFixes: false,
};

export interface EffectiveRepositoryRule {
  enabled: boolean;
  hasOverride: boolean;
  autoReview: boolean;
  allowAutoClose: boolean;
  acceptRequests: boolean;
  allowFixes: boolean;
  prTriggerAuthors: TriggerAuthors;
  prInstructions?: string;
  issueAutoReply: boolean;
  issueAutoFix: boolean;
  issueAllowAutoClose: boolean;
  issueAcceptRequests: boolean;
  issueTriggerAuthors: TriggerAuthors;
  issueTriggerLabels: string[];
  issueInstructions?: string;
  instructions?: string;
}

export function effectiveRepositoryAutomationRule(
  w: Pick<Workspace, "reviewBot">,
  repositoryId: number,
): EffectiveRepositoryRule {
  const settings = w.reviewBot?.settings ?? emptyReview;
  const override = settings.repositoryRules?.[String(repositoryId)];
  const enabled = settings.enabled && (override ? override.enabled : true);
  const sharedInstructions =
    override?.instructions ?? settings.instructions ?? undefined;
  const prInstructions =
    [override?.prInstructions ?? settings.prInstructions, sharedInstructions]
      .filter((s): s is string => !!s?.trim())
      .join("\n\n") || undefined;
  const issueInstructions =
    [
      override?.issueInstructions ?? settings.issueInstructions,
      sharedInstructions,
    ]
      .filter((s): s is string => !!s?.trim())
      .join("\n\n") || undefined;
  const issueAutoReply =
    override?.issueAutoReply ?? settings.issueAutoReply ?? false;
  const issueAutoFix = override?.issueAutoFix ?? settings.issueAutoFix ?? false;
  const issueAllowAutoClose =
    override?.issueAllowAutoClose ?? settings.issueAllowAutoClose ?? false;
  return {
    enabled,
    hasOverride: !!override,
    autoReview: override?.autoReview ?? settings.autoReview ?? true,
    allowAutoClose:
      override?.allowAutoClose ?? settings.allowAutoClose ?? false,
    acceptRequests: override?.acceptRequests ?? settings.acceptRequests ?? true,
    allowFixes: override?.allowFixes ?? settings.allowFixes ?? false,
    prTriggerAuthors:
      override?.prTriggerAuthors ?? settings.prTriggerAuthors ?? "all",
    prInstructions,
    issueAutoReply,
    issueAutoFix,
    issueAllowAutoClose,
    issueAcceptRequests:
      override?.issueAcceptRequests ??
      settings.issueAcceptRequests ??
      (issueAutoReply || issueAutoFix || issueAllowAutoClose),
    issueTriggerAuthors:
      override?.issueTriggerAuthors ?? settings.issueTriggerAuthors ?? "all",
    issueTriggerLabels:
      override?.issueTriggerLabels ?? settings.issueTriggerLabels ?? [],
    issueInstructions,
    instructions: sharedInstructions,
  };
}

export type ReviewState =
  | "queued"
  | "starting"
  | "running"
  | "auth_required"
  | "waiting"
  | "ready"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";
export interface ReviewTask {
  runnerModel?: RuntimeProvider;
  id: string;
  key: string;
  actor: string;
  githubUserId?: number;
  payload: CodingPayload;
  reviewRevision: number;
  number: number;
  targetKind?: "pull_request" | "issue";
  mode: "review" | "answer" | "fix" | "close";
  autoFixFollowup?: boolean;
  closedItem?: boolean;
  commentId?: number;
  statusOnly?: boolean;
  automatic: boolean;
  inputs: DevelopmentRun["inputs"];
  sources: {
    id: number;
    kind: "issue" | "review";
    hash: string;
    githubId: number;
  }[];
  revision: number;
  consumedRevision: number;
  state: ReviewState;
  attemptId: string;
  attemptIds?: string[];
  previousAttemptId?: string;
  run?: DevelopmentRun;
  result?: DevelopmentResult;
  headSha?: string;
  baseSha?: string;
  publishedSha?: string;
  publicationReserved?: boolean;
  prUrl?: string;
  reviewId?: number;
  tokens?: number;
  tokenUsage?: import("../usage/model-usage.ts").TokenUsageBreakdown;
  usageUnknown?: boolean;
  error?: string;
  cancelRequested?: boolean;
  lease?: string;
  leaseUntil?: string;
  nextPollAt?: string;
  createdAt: string;
  updatedAt: string;
  progress?: {
    state: "pending" | "sending" | "sent" | "unknown";
    id?: number;
    body?: string;
  };
}
export const reviewTerminal = (state: ReviewState) =>
  ["completed", "failed", "cancelled", "unknown"].includes(state);
export interface ReviewPage {
  revision: number;
  settings: ReviewSettings;
  botHandle?: string;
  webhookUrl: string;
  webhookConfigured: boolean;
  tasks: ReviewTask[];
}
