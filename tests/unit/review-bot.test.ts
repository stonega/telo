import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  developmentOutputSchema,
  developmentPrompt,
  developmentRun,
  developmentSchema,
} from "../../src/coding/development.ts";
import { manageRepositoryRules } from "../../src/github/notifications.ts";
import { effectiveRepositoryAutomationRule } from "../../src/review-bot/config.ts";
import {
  diffLines,
  reviewFindings,
  reviewOutputFindings,
} from "../../src/review-bot/github.ts";
import { reviewMention } from "../../src/review-bot/mentions.ts";
import {
  updateRepositoryAutomationRule,
  verifyReviewSignature,
} from "../../src/review-bot/service.ts";
import { grantGitHubAccess, workspace } from "../fixtures.ts";

const handle = "telo[bot]";
test("only directly addressed human instructions can request fixes", () => {
  expect(
    reviewMention(`@${handle} fix this\nKeep the API compatible.`, handle),
  ).toEqual({ mode: "fix", text: "fix this\nKeep the API compatible." });
  expect(
    reviewMention(`@${handle} please fix the regression`, handle)?.mode,
  ).toBe("fix");
  expect(reviewMention(`@${handle} explain this`, handle)?.mode).toBe("answer");
  expect(reviewMention(`@${handle} status`, handle)?.mode).toBe("status");
  expect(reviewMention(`@${handle} stop`, handle)?.mode).toBe("cancel");
  for (const body of [
    `> @${handle} fix this`,
    `    @${handle} fix this`,
    `\`@${handle} fix this\``,
    `Someone said @${handle} fix this`,
    `@${handle}-fake fix this`,
    `\`\`\`\n~~~\n@${handle} fix this\n\`\`\``,
    `~~~\n\`\`\`\n@${handle} fix this\n~~~`,
  ])
    expect(reviewMention(body, handle)).toBeUndefined();
});
test("GitHub App short mentions are accepted without accepting lookalikes", () => {
  expect(reviewMention("@telo fix this", handle)?.mode).toBe("fix");
  expect(reviewMention("@telo-fake fix this", handle)).toBeUndefined();
});
test("webhook HMAC covers the original bytes and rejects malformed or changed signatures", () => {
  const body = Buffer.from('{"message":"你好"}');
  const secret = "fixture-only-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect(() => verifyReviewSignature(secret, body, signature)).not.toThrow();
  for (const candidate of ["", "sha256=invalid", `sha256=${"0".repeat(64)}`])
    expect(() => verifyReviewSignature(secret, body, candidate)).toThrow(
      "unauthorized_webhook",
    );
  expect(() =>
    verifyReviewSignature(
      secret,
      Buffer.from('{ "message":"你好"}'),
      signature,
    ),
  ).toThrow("unauthorized_webhook");
});
test("inline findings use actual diff lines on the correct side", () => {
  const lines = diffLines(
    "@@ -10,3 +20,4 @@ function\n-old\n+new\n context\n+added\n last\n\\ No newline at end of file",
  );
  expect([...lines]).toEqual([
    "LEFT:10",
    "RIGHT:20",
    "LEFT:11",
    "RIGHT:21",
    "RIGHT:22",
    "LEFT:12",
    "RIGHT:23",
  ]);
  expect(lines.has("RIGHT:10")).toBe(false);
  expect(diffLines("binary patch omitted").size).toBe(0);
});
test("review turns are read-only, pinned to exact commits, with strict structured findings", () => {
  const run = developmentRun.parse({
    taskId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    mode: "analysis",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "fixture",
        text: "review",
        kind: "request",
      },
    ],
    review: {
      number: 23,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      action: "review",
    },
  });
  const prompt = developmentPrompt(run);
  expect(prompt).toContain("telo_review_source with action plan");
  expect(prompt).toContain(
    "diff action compares preview.merge_base against preview.to",
  );
  expect(prompt).toContain("Open Code Review (OCR) delegation");
  expect(prompt).toContain("/task/open-code-review.json");
  expect(prompt).toContain("do not substitute an ad-hoc review");
  expect(prompt).toContain(
    "each file is reviewed or skipped with a concrete reason",
  );
  expect(prompt).toContain("coverage rate");
  expect(prompt).toContain("Do not run repository scripts");
  expect(prompt).toContain("Never claim tests ran");
  const schema = developmentSchema(run);
  expect(schema.required).toContain("reviewFindings");
  expect(schema.properties.reviewFindings).toMatchObject({
    items: {
      required: expect.arrayContaining(["axis"]),
      properties: { axis: { enum: ["standards", "spec"] } },
    },
  });
  expect(Object.keys(schema.properties).sort()).toEqual(
    [...schema.required].sort(),
  );
  expect(Object.keys(developmentOutputSchema.properties).sort()).toEqual(
    [...developmentOutputSchema.required].sort(),
  );
  expect(developmentOutputSchema.properties).not.toHaveProperty(
    "reviewFindings",
  );
  if (!run.review) throw new Error("Review fixture missing");
  for (const action of ["answer", "fix"] as const) {
    const followup = developmentPrompt({
      ...run,
      review: { ...run.review, action },
    });
    expect(followup).not.toContain("/task/open-code-review.json");
  }
});

test("new findings require an assessment axis while historical findings remain readable", () => {
  const historical = {
    path: "src/api.ts",
    line: 1,
    side: "RIGHT",
    severity: "high",
    body: "An unauthenticated caller can update the record.",
  } as const;
  expect(reviewFindings.parse([historical])).toEqual([historical]);
  expect(reviewOutputFindings.safeParse([historical]).success).toBe(false);
  for (const axis of ["standards", "spec"] as const)
    expect(reviewOutputFindings.parse([{ ...historical, axis }])).toEqual([
      { ...historical, axis },
    ]);
  expect(
    reviewFindings.safeParse([{ ...historical, axis: "other" }]).success,
  ).toBe(false);
});

test("issue and PR mentions support close, fix, and target-aware defaults", () => {
  expect(reviewMention(`@${handle}`, handle, "pull_request")).toEqual({
    mode: "review",
    text: "Review this pull request.",
  });
  expect(reviewMention(`@${handle}`, handle, "issue")).toEqual({
    mode: "answer",
    text: "Analyze and reply to this issue.",
  });
  expect(
    reviewMention(`@${handle} close duplicate of #10`, handle, "pull_request"),
  ).toEqual({
    mode: "close",
    text: "close duplicate of #10",
  });
  expect(
    reviewMention(`@${handle} please close this issue`, handle, "issue"),
  ).toEqual({
    mode: "close",
    text: "please close this issue",
  });
  expect(
    reviewMention(
      `@${handle} resolve this crash and open a PR`,
      handle,
      "issue",
    )?.mode,
  ).toBe("fix");
});

test("per-repository rules combine natural-language instructions, PR/issue capabilities, and notifications", () => {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      { id: 7001, full_name: "example/workspace", default_branch: "main" },
      { id: 7002, full_name: "example/other", default_branch: "main" },
    ],
  };
  w.coding = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
      development: { publishByDefault: true },
    },
  };
  grantGitHubAccess(w, ["101"]);

  const rows = manageRepositoryRules(w, "101", "900", {
    action: "configure",
    repository: "example/workspace",
    autoReview: true,
    allowAutoClose: true,
    prInstructions: "Close PRs that modify config/prod without a linked issue.",
    issueAutoReply: true,
    issueAutoFix: true,
    issueAllowAutoClose: true,
    issueTriggerLabels: ["bug", "auto-fix"],
    issueInstructions:
      "Reply in Chinese with root cause; auto-fix reproducible bugs.",
    instructions: "Always cite affected file paths.",
    notificationAction: "subscribe",
    notificationEvents: ["pull_request", "issues"],
  });

  expect(w.reviewBot?.settings.enabled).toBe(true);
  const configured = rows.find((r) => r.repositoryId === 7001);
  expect(configured?.rule).toMatchObject({
    enabled: true,
    hasOverride: true,
    autoReview: true,
    allowAutoClose: true,
    issueAutoReply: true,
    issueAutoFix: true,
    issueAllowAutoClose: true,
    issueTriggerLabels: ["bug", "auto-fix"],
  });
  expect(configured?.rule.prInstructions).toContain(
    "Close PRs that modify config/prod",
  );
  expect(configured?.rule.prInstructions).toContain(
    "Always cite affected file paths.",
  );
  expect(configured?.rule.issueInstructions).toContain("Reply in Chinese");
  expect(configured?.subscription?.enabled).toBe(true);
  expect(configured?.subscription?.events).toEqual(["pull_request", "issues"]);

  // Unconfigured sibling repository does not inherit the repo-specific override
  const otherRule = effectiveRepositoryAutomationRule(w, 7002);
  expect(otherRule.hasOverride).toBe(false);
  expect(otherRule.issueAutoFix).toBe(false);

  // Disabling and resetting per-repository rule
  updateRepositoryAutomationRule(w, "101", 7001, { mode: "disabled" });
  expect(effectiveRepositoryAutomationRule(w, 7001).enabled).toBe(false);

  updateRepositoryAutomationRule(w, "101", 7001, { mode: "inherit" });
  expect(effectiveRepositoryAutomationRule(w, 7001).hasOverride).toBe(false);
});
