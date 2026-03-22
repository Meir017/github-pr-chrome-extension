import type { CIStatus, ReviewSummary } from "./utils/pr-helpers";

// ── URL parsing ──

export function parseRepoFromURL(): { owner: string; repo: string } | null {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export function getPRNumberFromRow(row: Element): number | null {
  const link = row.querySelector<HTMLAnchorElement>('a[id^="issue_"]');
  if (link) {
    const match = link.id.match(/issue_(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  const prLink = row.querySelector<HTMLAnchorElement>('a[href*="/pull/"]');
  if (prLink) {
    const match = prLink.href.match(/\/pull\/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

// ── Review title formatting ──

export function buildReviewTitle(summary: ReviewSummary): string {
  const parts: string[] = [];
  if (summary.approved.length > 0) parts.push(`Approved by: ${summary.approved.join(", ")}`);
  if (summary.changesRequested.length > 0) parts.push(`Changes requested by: ${summary.changesRequested.join(", ")}`);
  if (summary.commented.length > 0) parts.push(`Comments from: ${summary.commented.join(", ")}`);
  return parts.length > 0 ? parts.join("\n") : "No reviews yet";
}

// ── Read review status from the list page row ──

export function readReviewsFromRow(row: Element): ReviewSummary {
  const reviewLink = row.querySelector('a[href*="#partial-pull-merging"]');
  if (!reviewLink) return { approved: [], changesRequested: [], commented: [], overall: "none" };

  const text = reviewLink.textContent?.trim()?.toLowerCase() || "";
  const ariaLabel = reviewLink.getAttribute("aria-label") || "";

  if (text.includes("approved")) {
    return { approved: [ariaLabel || "reviewer"], changesRequested: [], commented: [], overall: "approved" };
  }
  if (text.includes("changes requested")) {
    return { approved: [], changesRequested: [ariaLabel || "reviewer"], commented: [], overall: "changes_requested" };
  }
  if (text.includes("review required")) {
    return { approved: [], changesRequested: [], commented: [], overall: "pending" };
  }

  return { approved: [], changesRequested: [], commented: [], overall: "none" };
}

// ── Read CI status from the list page row ──

export function readCIFromRow(row: Element): CIStatus {
  const ciEl = row.querySelector('[aria-label*="check"]');
  if (!ciEl) return { total: 0, passed: 0, failed: 0, pending: 0, overall: "none" };

  const label = ciEl.getAttribute("aria-label") || "";
  // e.g. "1 / 1 checks OK", "2 / 3 checks OK"
  const match = label.match(/(\d+)\s*\/\s*(\d+)\s*checks?\s*(OK)?/i);
  if (match) {
    const passed = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    const allOk = match[3] !== undefined;
    const failed = total - passed;
    return {
      total,
      passed,
      failed,
      pending: 0,
      overall: allOk && failed === 0 ? "success" : failed > 0 ? "failure" : "pending",
    };
  }

  // fallback: just detect presence
  if (label.toLowerCase().includes("ok") || label.toLowerCase().includes("success")) {
    return { total: 1, passed: 1, failed: 0, pending: 0, overall: "success" };
  }
  if (label.toLowerCase().includes("fail")) {
    return { total: 1, passed: 0, failed: 1, pending: 0, overall: "failure" };
  }
  return { total: 1, passed: 0, failed: 0, pending: 1, overall: "pending" };
}

// ── Read draft status from the list page row ──

export function isDraftFromRow(row: Element): boolean {
  const prIcon = row.querySelector('svg.octicon-git-pull-request-draft');
  if (prIcon) return true;
  const titleEl = row.querySelector('[aria-label*="Draft"]');
  if (titleEl) return true;
  return false;
}
