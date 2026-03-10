export interface PullRequestDetails {
  number: number;
  title: string;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  mergeable_state: string;
  labels: Array<{ name: string; color: string }>;
  head_sha: string;
  head_ref: string;
  base_ref: string;
  user_login: string;
  requested_reviewers: string[];
  review_comments: number;
}

export interface CombinedStatus {
  state: "success" | "failure" | "pending";
  total_count: number;
  statuses: Array<{
    state: string;
    context: string;
    description: string;
  }>;
}

// ── Review types ──

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export interface ReviewInfo {
  user: string;
  state: ReviewState;
  submitted_at: string;
}

export interface ReviewSummary {
  approved: string[];
  changesRequested: string[];
  commented: string[];
  overall: "approved" | "changes_requested" | "pending" | "none";
}

export function summarizeReviews(reviews: ReviewInfo[]): ReviewSummary {
  // only keep the latest review per user (excluding COMMENTED-only)
  const latestByUser = new Map<string, ReviewInfo>();
  for (const r of reviews) {
    if (r.state === "COMMENTED") continue; // comments alone don't count as a decision
    latestByUser.set(r.user, r);
  }

  const approved: string[] = [];
  const changesRequested: string[] = [];
  const commented: string[] = [];

  for (const [user, review] of latestByUser) {
    if (review.state === "APPROVED") approved.push(user);
    else if (review.state === "CHANGES_REQUESTED") changesRequested.push(user);
  }

  // also gather unique commenters
  const commenters = new Set<string>();
  for (const r of reviews) {
    if (r.state === "COMMENTED" && !latestByUser.has(r.user)) commenters.add(r.user);
  }
  commented.push(...commenters);

  let overall: ReviewSummary["overall"] = "none";
  if (changesRequested.length > 0) overall = "changes_requested";
  else if (approved.length > 0) overall = "approved";
  else if (commented.length > 0 || reviews.length > 0) overall = "pending";

  return { approved, changesRequested, commented, overall };
}

export function getReviewBadgeInfo(overall: ReviewSummary["overall"]): { text: string; color: string; icon: string } {
  switch (overall) {
    case "approved":
      return { text: "Approved", color: "#28a745", icon: "✓" };
    case "changes_requested":
      return { text: "Changes requested", color: "#cb2431", icon: "✕" };
    case "pending":
      return { text: "Review pending", color: "#dbab09", icon: "●" };
    case "none":
      return { text: "No reviews", color: "#6e7781", icon: "○" };
  }
}

// ── CI / Check runs ──

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | "stale" | null;

export interface CheckRunInfo {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: CheckConclusion;
}

export interface CIStatus {
  overall: "success" | "failure" | "pending" | "none";
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export function summarizeCI(
  combinedStatus: CombinedStatus | null,
  checkRuns: CheckRunInfo[]
): CIStatus {
  let passed = 0, failed = 0, pending = 0;

  // from legacy statuses API
  if (combinedStatus) {
    for (const s of combinedStatus.statuses) {
      if (s.state === "success") passed++;
      else if (s.state === "failure" || s.state === "error") failed++;
      else pending++;
    }
  }

  // from check runs API
  for (const cr of checkRuns) {
    if (cr.status !== "completed") {
      pending++;
    } else if (cr.conclusion === "success" || cr.conclusion === "skipped" || cr.conclusion === "neutral") {
      passed++;
    } else {
      failed++;
    }
  }

  const total = passed + failed + pending;
  let overall: CIStatus["overall"] = "none";
  if (total === 0) overall = "none";
  else if (failed > 0) overall = "failure";
  else if (pending > 0) overall = "pending";
  else overall = "success";

  return { overall, passed, failed, pending, total };
}

export function getCIBadgeInfo(ci: CIStatus): { text: string; color: string; icon: string } {
  switch (ci.overall) {
    case "success":
      return { text: `${ci.passed}/${ci.total} passed`, color: "#28a745", icon: "✓" };
    case "failure":
      return { text: `${ci.failed} failed`, color: "#cb2431", icon: "✕" };
    case "pending":
      return { text: `${ci.pending} pending`, color: "#dbab09", icon: "◔" };
    case "none":
      return { text: "No checks", color: "#6e7781", icon: "—" };
  }
}

// ── Merge conflict ──

export function getMergeabilityInfo(state: string): { text: string; color: string; icon: string } | null {
  switch (state) {
    case "dirty":
      return { text: "Conflicts", color: "#cb2431", icon: "⚠" };
    case "blocked":
      return { text: "Blocked", color: "#e36209", icon: "🚫" };
    case "unstable":
      return { text: "Unstable", color: "#dbab09", icon: "⚡" };
    case "clean":
    case "has_hooks":
      return null; // no badge needed — all good
    default:
      return null; // unknown / behind / draft
  }
}

// ── Branch staleness ──

export interface BranchComparison {
  behind_by: number;
  ahead_by: number;
}

export function getStalenessInfo(comparison: BranchComparison | null): { text: string; color: string } | null {
  if (!comparison || comparison.behind_by === 0) return null;
  const behind = comparison.behind_by;
  let color: string;
  if (behind <= 5) color = "#6e7781";
  else if (behind <= 20) color = "#dbab09";
  else color = "#e36209";
  return { text: `${behind} behind`, color };
}

// ── Enhanced PR data (all-in-one) ──

export interface EnhancedPRData {
  pr: PullRequestDetails;
  reviews: ReviewInfo[];
  ci: CIStatus;
  comparison: BranchComparison | null;
}

export type PRSize = "XS" | "S" | "M" | "L" | "XL";

export function calculatePRSize(additions: number, deletions: number): PRSize {
  const total = additions + deletions;
  if (total < 10) return "XS";
  if (total < 100) return "S";
  if (total < 500) return "M";
  if (total < 1000) return "L";
  return "XL";
}

export function getSizeColor(size: PRSize): string {
  const colors: Record<PRSize, string> = {
    XS: "#28a745",
    S: "#2cbe4e",
    M: "#dbab09",
    L: "#e36209",
    XL: "#cb2431",
  };
  return colors[size];
}

export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);

  if (diffSecs < 60) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  return `${diffMonths}mo ago`;
}

export function getAgeColor(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 3) return "#28a745";   // green — fresh
  if (diffDays < 7) return "#2cbe4e";   // light green
  if (diffDays < 14) return "#dbab09";  // yellow — getting stale
  if (diffDays < 30) return "#e36209";  // orange — stale
  return "#cb2431";                      // red — very stale
}
