import { describe, it, expect } from "vitest";
import {
  calculatePRSize,
  getSizeColor,
  summarizeReviews,
  getReviewBadgeInfo,
  summarizeCI,
  getCIBadgeInfo,
  getMergeabilityInfo,
  getStalenessInfo,
  formatRelativeTime,
  getAgeColor,
  type ReviewInfo,
  type CombinedStatus,
  type CheckRunInfo,
  type BranchComparison,
} from "./pr-helpers";

// ── calculatePRSize ──

describe("calculatePRSize", () => {
  it.each([
    [0, 0, "XS"],
    [5, 3, "XS"],
    [9, 0, "XS"],
    [10, 0, "S"],
    [50, 30, "S"],
    [99, 0, "S"],
    [100, 0, "M"],
    [300, 100, "M"],
    [499, 0, "M"],
    [500, 0, "L"],
    [600, 300, "L"],
    [999, 0, "L"],
    [1000, 0, "XL"],
    [5000, 2000, "XL"],
  ])("(%d + %d) → %s", (add, del, expected) => {
    expect(calculatePRSize(add, del)).toBe(expected);
  });
});

// ── getSizeColor ──

describe("getSizeColor", () => {
  it.each(["XS", "S", "M", "L", "XL"] as const)("returns a hex color for %s", (size) => {
    const color = getSizeColor(size);
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("returns different colors for different sizes", () => {
    const colors = new Set(["XS", "S", "M", "L", "XL"].map((s) => getSizeColor(s as any)));
    expect(colors.size).toBe(5);
  });
});

// ── summarizeReviews ──

describe("summarizeReviews", () => {
  it("returns 'none' for empty reviews", () => {
    const result = summarizeReviews([]);
    expect(result.overall).toBe("none");
    expect(result.approved).toEqual([]);
    expect(result.changesRequested).toEqual([]);
    expect(result.commented).toEqual([]);
  });

  it("detects approved", () => {
    const reviews: ReviewInfo[] = [
      { user: "alice", state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.overall).toBe("approved");
    expect(result.approved).toEqual(["alice"]);
  });

  it("detects changes_requested", () => {
    const reviews: ReviewInfo[] = [
      { user: "bob", state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.overall).toBe("changes_requested");
    expect(result.changesRequested).toEqual(["bob"]);
  });

  it("changes_requested takes priority over approved", () => {
    const reviews: ReviewInfo[] = [
      { user: "alice", state: "APPROVED", submitted_at: "2024-01-01T00:00:00Z" },
      { user: "bob", state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.overall).toBe("changes_requested");
  });

  it("keeps only latest review per user (ignoring COMMENTED)", () => {
    const reviews: ReviewInfo[] = [
      { user: "alice", state: "CHANGES_REQUESTED", submitted_at: "2024-01-01T00:00:00Z" },
      { user: "alice", state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.overall).toBe("approved");
    expect(result.approved).toEqual(["alice"]);
    expect(result.changesRequested).toEqual([]);
  });

  it("COMMENTED-only users go to commented list", () => {
    const reviews: ReviewInfo[] = [
      { user: "charlie", state: "COMMENTED", submitted_at: "2024-01-01T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.overall).toBe("pending");
    expect(result.commented).toEqual(["charlie"]);
  });

  it("COMMENTED users with a later decision are not in commented", () => {
    const reviews: ReviewInfo[] = [
      { user: "alice", state: "COMMENTED", submitted_at: "2024-01-01T00:00:00Z" },
      { user: "alice", state: "APPROVED", submitted_at: "2024-01-02T00:00:00Z" },
    ];
    const result = summarizeReviews(reviews);
    expect(result.commented).toEqual([]);
    expect(result.approved).toEqual(["alice"]);
  });
});

// ── getReviewBadgeInfo ──

describe("getReviewBadgeInfo", () => {
  it.each([
    ["approved", "✓"],
    ["changes_requested", "✕"],
    ["pending", "●"],
    ["none", "○"],
  ] as const)("returns correct icon for %s", (overall, expectedIcon) => {
    const info = getReviewBadgeInfo(overall);
    expect(info.icon).toBe(expectedIcon);
    expect(info.text).toBeTruthy();
    expect(info.color).toMatch(/^#/);
  });
});

// ── summarizeCI ──

describe("summarizeCI", () => {
  it("returns 'none' with no data", () => {
    const result = summarizeCI(null, []);
    expect(result.overall).toBe("none");
    expect(result.total).toBe(0);
  });

  it("counts passed check runs", () => {
    const checkRuns: CheckRunInfo[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ];
    const result = summarizeCI(null, checkRuns);
    expect(result.overall).toBe("success");
    expect(result.passed).toBe(2);
    expect(result.total).toBe(2);
  });

  it("detects failure", () => {
    const checkRuns: CheckRunInfo[] = [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ];
    const result = summarizeCI(null, checkRuns);
    expect(result.overall).toBe("failure");
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("detects pending", () => {
    const checkRuns: CheckRunInfo[] = [
      { name: "build", status: "in_progress", conclusion: null },
    ];
    const result = summarizeCI(null, checkRuns);
    expect(result.overall).toBe("pending");
    expect(result.pending).toBe(1);
  });

  it("failure takes priority over pending", () => {
    const checkRuns: CheckRunInfo[] = [
      { name: "build", status: "completed", conclusion: "failure" },
      { name: "deploy", status: "in_progress", conclusion: null },
    ];
    const result = summarizeCI(null, checkRuns);
    expect(result.overall).toBe("failure");
  });

  it("counts skipped/neutral as passed", () => {
    const checkRuns: CheckRunInfo[] = [
      { name: "optional", status: "completed", conclusion: "skipped" },
      { name: "info", status: "completed", conclusion: "neutral" },
    ];
    const result = summarizeCI(null, checkRuns);
    expect(result.overall).toBe("success");
    expect(result.passed).toBe(2);
  });

  it("combines legacy statuses and check runs", () => {
    const combined: CombinedStatus = {
      state: "success",
      total_count: 1,
      statuses: [{ state: "success", context: "ci/legacy", description: "ok" }],
    };
    const checkRuns: CheckRunInfo[] = [
      { name: "build", status: "completed", conclusion: "success" },
    ];
    const result = summarizeCI(combined, checkRuns);
    expect(result.passed).toBe(2);
    expect(result.total).toBe(2);
  });

  it("legacy failure counted", () => {
    const combined: CombinedStatus = {
      state: "failure",
      total_count: 1,
      statuses: [{ state: "failure", context: "ci/legacy", description: "fail" }],
    };
    const result = summarizeCI(combined, []);
    expect(result.overall).toBe("failure");
    expect(result.failed).toBe(1);
  });
});

// ── getCIBadgeInfo ──

describe("getCIBadgeInfo", () => {
  it.each([
    ["success", "✓"],
    ["failure", "✕"],
    ["pending", "◔"],
    ["none", "—"],
  ] as const)("returns correct icon for %s", (overall, expectedIcon) => {
    const ci = { overall, passed: 1, failed: 0, pending: 0, total: 1 };
    const info = getCIBadgeInfo(ci as any);
    expect(info.icon).toBe(expectedIcon);
    expect(info.color).toMatch(/^#/);
  });
});

// ── getMergeabilityInfo ──

describe("getMergeabilityInfo", () => {
  it("returns conflict info for 'dirty'", () => {
    const info = getMergeabilityInfo("dirty");
    expect(info).not.toBeNull();
    expect(info!.text).toBe("Conflicts");
    expect(info!.icon).toBe("⚠");
  });

  it("returns blocked info", () => {
    const info = getMergeabilityInfo("blocked");
    expect(info).not.toBeNull();
    expect(info!.text).toBe("Blocked");
  });

  it("returns unstable info", () => {
    const info = getMergeabilityInfo("unstable");
    expect(info).not.toBeNull();
    expect(info!.text).toBe("Unstable");
  });

  it("returns null for 'clean'", () => {
    expect(getMergeabilityInfo("clean")).toBeNull();
  });

  it("returns null for 'has_hooks'", () => {
    expect(getMergeabilityInfo("has_hooks")).toBeNull();
  });

  it("returns null for unknown states", () => {
    expect(getMergeabilityInfo("unknown")).toBeNull();
    expect(getMergeabilityInfo("behind")).toBeNull();
  });
});

// ── getStalenessInfo ──

describe("getStalenessInfo", () => {
  it("returns null when comparison is null", () => {
    expect(getStalenessInfo(null)).toBeNull();
  });

  it("returns null when behind_by is 0", () => {
    expect(getStalenessInfo({ behind_by: 0, ahead_by: 5 })).toBeNull();
  });

  it("returns gray for ≤5 behind", () => {
    const info = getStalenessInfo({ behind_by: 3, ahead_by: 0 });
    expect(info).not.toBeNull();
    expect(info!.text).toBe("3 behind");
    expect(info!.color).toBe("#6e7781");
  });

  it("returns yellow for 6-20 behind", () => {
    const info = getStalenessInfo({ behind_by: 15, ahead_by: 0 });
    expect(info!.color).toBe("#dbab09");
  });

  it("returns orange for >20 behind", () => {
    const info = getStalenessInfo({ behind_by: 25, ahead_by: 0 });
    expect(info!.color).toBe("#e36209");
  });
});

// ── formatRelativeTime ──

describe("formatRelativeTime", () => {
  it("returns 'just now' for recent times", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns minutes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe("5m ago");
  });

  it("returns hours", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe("3h ago");
  });

  it("returns days", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe("2d ago");
  });

  it("returns weeks", () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoWeeksAgo)).toBe("2w ago");
  });

  it("returns months", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoMonthsAgo)).toBe("2mo ago");
  });
});

// ── getAgeColor ──

describe("getAgeColor", () => {
  it("returns green for <3 days", () => {
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgeColor(recent)).toBe("#28a745");
  });

  it("returns light green for 3-6 days", () => {
    const fourDays = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgeColor(fourDays)).toBe("#2cbe4e");
  });

  it("returns yellow for 7-13 days", () => {
    const tenDays = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgeColor(tenDays)).toBe("#dbab09");
  });

  it("returns orange for 14-29 days", () => {
    const twentyDays = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgeColor(twentyDays)).toBe("#e36209");
  });

  it("returns red for ≥30 days", () => {
    const sixtyDays = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(getAgeColor(sixtyDays)).toBe("#cb2431");
  });
});
