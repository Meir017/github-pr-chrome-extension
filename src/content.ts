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
  summarizeCI,
  type EnhancedPRData,
  type PullRequestDetails,
  type ReviewInfo,
  type CheckRunInfo,
  type CIStatus,
  type ReviewSummary,
  type BranchComparison,
} from "./utils/pr-helpers";

// ── Current user ──
let currentUserLogin: string | null = null;

function detectCurrentUser(): void {
  // GitHub embeds the logged-in user's login in the page's meta tags
  const meta = document.querySelector('meta[name="user-login"]');
  if (meta) {
    currentUserLogin = meta.getAttribute("content");
  }
}

// ── Same-origin fetch (uses session cookies — no PAT needed) ──

async function ghFetch(path: string): Promise<Response> {
  return fetch(`https://github.com${path}`, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    credentials: "same-origin",
  });
}

// ── Data fetching via same-origin page requests ──

async function fetchPRFromPage(owner: string, repo: string, prNumber: number): Promise<EnhancedPRData | null> {
  try {
    // Fetch the PR page HTML — same origin, session cookies included
    const response = await fetch(`/${owner}/${repo}/pull/${prNumber}`, {
      credentials: "same-origin",
    });
    if (!response.ok) {
      console.debug(`[GHPR] PR page fetch failed: ${response.status}`);
      return null;
    }
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return parsePRPage(doc, owner, repo, prNumber);
  } catch (err) {
    console.debug("[GHPR] fetchPRFromPage error:", err);
    return null;
  }
}

function parsePRPage(doc: Document, owner: string, repo: string, prNumber: number): EnhancedPRData {
  // ── Parse diff stats by counting actual diff lines ──
  let additions = doc.querySelectorAll('.blob-num-addition:not(.empty-cell)').length;
  let deletions = doc.querySelectorAll('.blob-num-deletion:not(.empty-cell)').length;
  let changedFiles = doc.querySelectorAll('.diff-table').length;

  // Fallback: look for summary text like "3 files changed, 45 insertions(+), 12 deletions(-)"
  const bodyText = doc.body?.textContent || "";
  if (additions === 0 && deletions === 0) {
    const addMatch = bodyText.match(/([\d,]+)\s+insertion/);
    const delMatch = bodyText.match(/([\d,]+)\s+deletion/);
    if (addMatch) additions = parseInt(addMatch[1].replace(/,/g, ""), 10);
    if (delMatch) deletions = parseInt(delMatch[1].replace(/,/g, ""), 10);
  }
  if (changedFiles === 0) {
    const filesMatch = bodyText.match(/([\d,]+)\s+files?\s+changed/);
    if (filesMatch) changedFiles = parseInt(filesMatch[1].replace(/,/g, ""), 10);
  }

  // ── Parse timestamps ──
  const timeEl = doc.querySelector("relative-time");
  const createdAt = timeEl?.getAttribute("datetime") || new Date().toISOString();

  // ── Parse draft status ──
  const isDraft = !!doc.querySelector('[title="Status: Draft"]')
    || bodyText.includes("Draft pull request")
    || !!doc.querySelector(".gh-header-meta .State--draft");

  // ── Parse merge state from the merge box ──
  let mergeableState = "unknown";
  const mergeArea = doc.querySelector('.merge-message, .merging-body, [data-merge-box]');
  if (mergeArea) {
    const text = mergeArea.textContent?.toLowerCase() || "";
    if (text.includes("conflict")) mergeableState = "dirty";
    else if (text.includes("blocked")) mergeableState = "blocked";
    else if (text.includes("can be merged") || text.includes("squash and merge") || text.includes("able to merge")) mergeableState = "clean";
  }

  // ── Parse reviews from the sidebar ──
  const reviews: ReviewInfo[] = [];
  doc.querySelectorAll('.sidebar-assignee .reviewers-status-icon, .review-status-item, [data-hovercard-type="user"]').forEach((el) => {
    const svgClasses = el.querySelector("svg")?.classList?.toString() || el.className?.toString?.() || "";
    const parentEl = el.closest("li, .review-status-item, .sidebar-assignee");
    const user = parentEl?.querySelector("a.assignee, a[data-hovercard-type='user']")?.textContent?.trim() || "reviewer";
    let state: ReviewInfo["state"] = "COMMENTED";
    if (svgClasses.includes("color-fg-done") || svgClasses.includes("color-fg-success")) state = "APPROVED";
    else if (svgClasses.includes("color-fg-attention") || svgClasses.includes("color-fg-danger")) state = "CHANGES_REQUESTED";
    if (user !== "reviewer") {
      reviews.push({ user, state, submitted_at: createdAt });
    }
  });

  // ── Parse requested reviewers ──
  const requestedReviewers: string[] = [];

  // ── Parse CI status from merge box ──
  const checkRuns: CheckRunInfo[] = [];
  doc.querySelectorAll('.merge-status-item, .branch-action-item').forEach((el) => {
    const text = el.textContent?.trim() || "";
    const name = text.substring(0, 60);
    const svgClasses = el.querySelector("svg")?.classList?.toString() || "";
    let status: CheckRunInfo["status"] = "completed";
    let conclusion: CheckRunInfo["conclusion"] = null;
    if (svgClasses.includes("color-fg-success") || svgClasses.includes("octicon-check")) conclusion = "success";
    else if (svgClasses.includes("color-fg-danger") || svgClasses.includes("octicon-x")) conclusion = "failure";
    else if (svgClasses.includes("color-fg-attention") || svgClasses.includes("octicon-dot-fill")) { status = "in_progress"; }
    checkRuns.push({ name, status, conclusion });
  });

  // ── Parse labels ──
  const labels: Array<{ name: string; color: string }> = [];
  doc.querySelectorAll('.IssueLabel, .js-issue-labels .label').forEach((el) => {
    labels.push({
      name: el.textContent?.trim() || "",
      color: (el as HTMLElement).style.backgroundColor || "#ededed",
    });
  });

  // ── Parse review comment count from the tab ──
  let reviewComments = 0;
  const tabCounter = doc.querySelector('#conversation_tab_counter');
  if (tabCounter) {
    const n = parseInt(tabCounter.textContent?.trim() || "0", 10);
    if (!isNaN(n)) reviewComments = n;
  }

  const pr: PullRequestDetails = {
    number: prNumber,
    title: doc.querySelector(".gh-header-title .js-issue-title")?.textContent?.trim() || `PR #${prNumber}`,
    additions,
    deletions,
    changed_files: changedFiles,
    created_at: createdAt,
    updated_at: createdAt,
    merged_at: null,
    draft: isDraft,
    mergeable_state: mergeableState,
    labels,
    head_sha: "",
    head_ref: doc.querySelector(".head-ref")?.textContent?.trim() || "",
    base_ref: doc.querySelector(".base-ref")?.textContent?.trim() || "",
    user_login: doc.querySelector(".gh-header-meta .author")?.textContent?.trim() || "",
    requested_reviewers: requestedReviewers,
    review_comments: reviewComments,
  };

  const ci = summarizeCI(null, checkRuns);

  return { pr, reviews, ci, comparison: null };
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

  const rows = document.querySelectorAll(
    '.js-issue-row:not(.ghpr-processed)'
  );
  if (rows.length === 0) return;

  const { owner, repo } = repoInfo;
  const BATCH_SIZE = 3; // smaller batches — each fetches a full page
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
        const data = await fetchPRFromPage(owner, repo, prNumber);
        if (data) {
          injectPRInfo(row, data);
        } else {
          console.debug("[GHPR] No data for PR #" + prNumber);
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
  detectCurrentUser();
  console.log("[GHPR] Current user:", currentUserLogin ?? "(not detected)");
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
