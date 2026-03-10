import {
  calculatePRSize,
  getSizeColor,
  formatRelativeTime,
  getAgeColor,
  summarizeReviews,
  getReviewBadgeInfo,
  getCIBadgeInfo,
  getMergeabilityInfo,
  getStalenessInfo,
  type EnhancedPRData,
  type PullRequestDetails,
  type CIStatus,
  type ReviewSummary,
  type BranchComparison,
} from "./utils/pr-helpers";
import type { EnhancedPRResponse, ErrorResponse } from "./background";

// ── Current user cache ──
let currentUserLogin: string | null = null;

function fetchCurrentUser(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_CURRENT_USER" },
      (response: any) => {
        if (chrome.runtime.lastError) {
          console.debug("[GHPR] fetchCurrentUser error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (response?.success) {
          currentUserLogin = response.login;
          resolve(response.login);
        } else {
          resolve(null);
        }
      }
    );
  });
}

// ── URL parsing ──

function parseRepoFromURL(): { owner: string; repo: string } | null {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function getPRNumberFromRow(row: Element): number | null {
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

// ── API call ──

function fetchEnhancedPR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<EnhancedPRResponse | ErrorResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_PR_ENHANCED", owner, repo, prNumber },
      (response: EnhancedPRResponse | ErrorResponse) => {
        if (chrome.runtime.lastError) {
          console.debug("[GHPR] sendMessage error:", chrome.runtime.lastError.message);
          resolve({ success: false, error: chrome.runtime.lastError.message ?? "Unknown error" });
          return;
        }
        if (!response) {
          resolve({ success: false, error: "No response from background worker" });
          return;
        }
        resolve(response);
      }
    );
  });
}

// ── DOM helpers ──

function createBadge(text: string, bgColor: string, title: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "ghpr-badge";
  badge.textContent = text;
  badge.title = title;
  badge.style.backgroundColor = bgColor;
  return badge;
}

function createIconBadge(icon: string, text: string, bgColor: string, title: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "ghpr-badge ghpr-icon-badge";
  badge.title = title;
  badge.style.backgroundColor = bgColor;

  const iconSpan = document.createElement("span");
  iconSpan.className = "ghpr-badge-icon";
  iconSpan.textContent = icon;

  const textSpan = document.createElement("span");
  textSpan.textContent = text;

  badge.appendChild(iconSpan);
  badge.appendChild(textSpan);
  return badge;
}

function createDiffStats(additions: number, deletions: number): HTMLSpanElement {
  const container = document.createElement("span");
  container.className = "ghpr-diff-stats";
  container.title = `${additions + deletions} lines changed`;

  const addSpan = document.createElement("span");
  addSpan.className = "ghpr-additions";
  addSpan.textContent = `+${additions}`;

  const delSpan = document.createElement("span");
  delSpan.className = "ghpr-deletions";
  delSpan.textContent = `-${deletions}`;

  container.appendChild(addSpan);
  container.appendChild(document.createTextNode(" / "));
  container.appendChild(delSpan);
  return container;
}

// ── Injection ──

function injectPRInfo(row: Element, data: EnhancedPRData): void {
  if (row.querySelector(".ghpr-enhancements")) return;

  const { pr, reviews, ci, comparison } = data;
  const reviewSummary = summarizeReviews(reviews);

  // ── Row 1: size, diff stats, files, age, draft ──
  const row1 = document.createElement("div");
  row1.className = "ghpr-enhancements";

  const size = calculatePRSize(pr.additions, pr.deletions);
  row1.appendChild(createBadge(size, getSizeColor(size), `PR Size: ${size} (${pr.additions + pr.deletions} lines)`));
  row1.appendChild(createDiffStats(pr.additions, pr.deletions));
  row1.appendChild(createBadge(`${pr.changed_files} file${pr.changed_files !== 1 ? "s" : ""}`, "#6f42c1", `${pr.changed_files} files changed`));

  const ageColor = getAgeColor(pr.created_at);
  const ageBadge = createBadge(formatRelativeTime(pr.created_at), ageColor, `Created: ${new Date(pr.created_at).toLocaleDateString()}`);
  ageBadge.classList.add("ghpr-age-badge");
  row1.appendChild(ageBadge);

  if (pr.draft) {
    row1.appendChild(createBadge("Draft", "#6a737d", "This is a draft PR"));
  }

  // ── Row 2: review status, CI, merge conflicts, staleness, reviewer highlight, comments ──
  const row2 = document.createElement("div");
  row2.className = "ghpr-enhancements ghpr-status-row";

  // Review status
  const reviewInfo = getReviewBadgeInfo(reviewSummary.overall);
  const reviewTitle = buildReviewTitle(reviewSummary);
  row2.appendChild(createIconBadge(reviewInfo.icon, reviewInfo.text, reviewInfo.color, reviewTitle));

  // CI status
  const ciInfo = getCIBadgeInfo(ci);
  row2.appendChild(createIconBadge(ciInfo.icon, ciInfo.text, ciInfo.color, `CI: ${ciInfo.text}`));

  // Merge conflict
  const mergeInfo = getMergeabilityInfo(pr.mergeable_state);
  if (mergeInfo) {
    row2.appendChild(createIconBadge(mergeInfo.icon, mergeInfo.text, mergeInfo.color, `Merge status: ${mergeInfo.text}`));
  }

  // Branch staleness
  const stalenessInfo = getStalenessInfo(comparison);
  if (stalenessInfo) {
    row2.appendChild(createIconBadge("↓", stalenessInfo.text, stalenessInfo.color, `Branch is ${stalenessInfo.text} ${pr.base_ref}`));
  }

  // Requested reviewer highlight (you)
  if (currentUserLogin && pr.requested_reviewers.includes(currentUserLogin)) {
    row2.appendChild(createIconBadge("👁", "Review requested", "#0969da", "You have been requested to review this PR"));
    row.classList.add("ghpr-review-requested");
  }

  // Review comments count
  if (pr.review_comments > 0) {
    row2.appendChild(createIconBadge("💬", `${pr.review_comments}`, "#6e7781", `${pr.review_comments} review comment${pr.review_comments !== 1 ? "s" : ""}`));
  }

  // ── Inject into DOM ──
  const titleLink = row.querySelector('a[id^="issue_"]') || row.querySelector('a[href*="/pull/"]');
  if (titleLink) {
    const parentEl = titleLink.closest("div") || titleLink.parentElement;
    if (parentEl) {
      parentEl.appendChild(row1);
      parentEl.appendChild(row2);
    }
  }
}

function buildReviewTitle(summary: ReviewSummary): string {
  const parts: string[] = [];
  if (summary.approved.length > 0) parts.push(`Approved by: ${summary.approved.join(", ")}`);
  if (summary.changesRequested.length > 0) parts.push(`Changes requested by: ${summary.changesRequested.join(", ")}`);
  if (summary.commented.length > 0) parts.push(`Comments from: ${summary.commented.join(", ")}`);
  return parts.length > 0 ? parts.join("\n") : "No reviews yet";
}

// ── Main loop ──

async function enhancePRList(): Promise<void> {
  const repoInfo = parseRepoFromURL();
  if (!repoInfo) return;

  // Only target the row-level divs, not the inner link elements
  const rows = document.querySelectorAll(
    '.js-issue-row:not(.ghpr-processed)'
  );
  if (rows.length === 0) return;

  const { owner, repo } = repoInfo;
  const BATCH_SIZE = 5;
  const rowArray = Array.from(rows);

  for (let i = 0; i < rowArray.length; i += BATCH_SIZE) {
    const batch = rowArray.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (row) => {
      row.classList.add("ghpr-processed");
      const prNumber = getPRNumberFromRow(row);
      if (!prNumber) {
        console.debug("[GHPR] Could not extract PR number from row", row.id);
        return;
      }

      try {
        const response = await fetchEnhancedPR(owner, repo, prNumber);
        if (response && response.success) {
          injectPRInfo(row, response.data);
        } else {
          console.debug("[GHPR] API error for PR #" + prNumber, response?.error);
        }
      } catch (err) {
        console.debug("[GHPR] Failed to fetch PR #" + prNumber, err);
      }
    });
    await Promise.all(promises);
  }
}

// ── Bootstrap ──

async function init() {
  console.log("[GHPR] GitHub PR Enhancer loaded on", window.location.pathname);
  await fetchCurrentUser();
  console.log("[GHPR] Current user:", currentUserLogin ?? "(unauthenticated)");
  await enhancePRList();
}

init();

// observe dynamic changes
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length > 0) {
      setTimeout(() => enhancePRList(), 300);
      break;
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });

document.addEventListener("turbo:load", () => {
  setTimeout(() => enhancePRList(), 500);
});
