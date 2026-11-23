import { describe, expect, test } from "bun:test";
import type { OverviewMetrics } from "../../src/admin/overview.ts";
import { formatOverviewStatSub } from "../../web/overview-dashboard.tsx";

describe("Overview stat sub-metric formatting", () => {
  const baseMetrics: OverviewMetrics = {
    activeGroups: 2,
    inactiveGroups: 1,
    pendingAccessRequests: 3,
    threads7d: 14,
    activeWorkflows: 2,
    enabledSkills: 6,
    autoSkills: 2,
    activeMissions: 1,
    totalMissions: 4,
    coding: {
      active: 2,
      review: 3,
      failed24h: 1,
      codexCount: 4,
      antigravityCount: 1,
    },
  };

  test("formats member, thread, workflow, and coding sub-metrics", () => {
    expect(formatOverviewStatSub("members", baseMetrics)).toBe(
      "2 active groups · 3 pending",
    );
    expect(formatOverviewStatSub("threads", baseMetrics, 48)).toBe(
      "14 active in 7d · 48 runs",
    );
    expect(formatOverviewStatSub("workflows", baseMetrics)).toBe(
      "2 active · 6 skills (2 auto)",
    );
    expect(formatOverviewStatSub("codingTasks", baseMetrics)).toBe(
      "2 active · 3 in review · Codex + Agy",
    );
  });

  test("handles singular nouns and single-engine coding counts", () => {
    const singleMetrics: OverviewMetrics = {
      ...baseMetrics,
      activeGroups: 1,
      pendingAccessRequests: 0,
      enabledSkills: 1,
      autoSkills: 0,
      coding: {
        active: 0,
        review: 1,
        failed24h: 0,
        codexCount: 1,
        antigravityCount: 0,
      },
    };
    expect(formatOverviewStatSub("members", singleMetrics)).toBe(
      "1 active group",
    );
    expect(formatOverviewStatSub("threads", singleMetrics, 1)).toBe(
      "14 active in 7d · 1 run",
    );
    expect(formatOverviewStatSub("workflows", singleMetrics)).toBe(
      "2 active · 1 skill",
    );
    expect(formatOverviewStatSub("codingTasks", singleMetrics)).toBe(
      "0 active · 1 in review",
    );
    expect(formatOverviewStatSub("members", undefined)).toBeNull();
  });
});
