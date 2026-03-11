import {
  calculatePRSize,
  getSizeColor,
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
    const data = parsePRPage(doc, owner, repo, prNumber);

    // If diff stats are 0, fetch the /files tab and parse the React JSON payload
    if (data.pr.additions === 0 && data.pr.deletions === 0 && data.pr.changed_files === 0) {
      try {
        const filesResp = await fetch(`/${owner}/${repo}/pull/${prNumber}/files`, {
          credentials: "same-origin",
        });
        if (filesResp.ok) {
          const filesHtml = await filesResp.text();
          const filesDoc = new DOMParser().parseFromString(filesHtml, "text/html");

          // GitHub embeds diff data in a React JSON payload
          const reactEl = filesDoc.querySelector('[data-target="react-app.embeddedData"]');
          if (reactEl?.textContent) {
            const reactData = JSON.parse(reactEl.textContent);
            const diffSummaries = reactData?.payload?.pullRequestsChangesRoute?.diffSummaries;
            if (Array.isArray(diffSummaries) && diffSummaries.length > 0) {
              let additions = 0, deletions = 0;
              for (const file of diffSummaries) {
                additions += file.linesAdded || 0;
                deletions += file.linesDeleted || 0;
              }
              data.pr.additions = additions;
              data.pr.deletions = deletions;
              data.pr.changed_files = diffSummaries.length;
            }
          }
        }
      } catch {
        // silently ignore — we still have data from the main page
      }
    }

    return data;
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

// ── Enhance GitHub's existing CI status icon with extended text ──

function enhanceExistingCIIcon(row: Element, ci: CIStatus): void {
  const summary = row.querySelector('.commit-build-statuses > summary');
  if (!summary || summary.querySelector('.ghpr-ci-text')) return;

  if (ci.overall === "none") return;

  const label = document.createElement("span");
  label.className = "ghpr-ci-text";
  label.style.cssText = "font-size: 12px; font-weight: 500; margin-left: 4px; vertical-align: middle;";

  if (ci.overall === "success") {
    label.style.color = "#1a7f37";
    label.textContent = `${ci.passed}/${ci.total} ✓`;
  } else if (ci.overall === "failure") {
    // e.g. "2/3 · 1 failed"
    const passedSpan = document.createElement("span");
    passedSpan.style.color = "#1a7f37";
    passedSpan.textContent = `${ci.passed}`;
    const sep = document.createTextNode(`/${ci.total} · `);
    const failedSpan = document.createElement("span");
    failedSpan.style.color = "#cf222e";
    failedSpan.textContent = `${ci.failed} ✕`;
    label.appendChild(passedSpan);
    label.appendChild(sep);
    label.appendChild(failedSpan);
  } else {
    label.style.color = "#9a6700";
    label.textContent = `${ci.pending} pending`;
  }

  summary.appendChild(label);
}

// ── Color the existing GitHub timestamp based on PR age ──

function colorExistingTimestamp(row: Element, createdAt: string): void {
  const timeEl = row.querySelector("relative-time");
  if (!timeEl) return;
  const color = getAgeColor(createdAt);
  const el = timeEl as HTMLElement;
  el.style.cssText = `color: ${color} !important; font-weight: 600 !important;`;
}

// ── Injection ──

function injectPRInfo(row: Element, data: EnhancedPRData): void {
  if (row.querySelector(".ghpr-enhancements")) return;

  const { pr, reviews, ci, comparison } = data;
  const reviewSummary = summarizeReviews(reviews);

  // ── Single row of badges ──
  const badgeRow = document.createElement("div");
  badgeRow.className = "ghpr-enhancements";

  const size = calculatePRSize(pr.additions, pr.deletions);
  badgeRow.appendChild(createBadge(size, getSizeColor(size), `PR Size: ${size} (${pr.additions + pr.deletions} lines)`));
  badgeRow.appendChild(createDiffStats(pr.additions, pr.deletions));
  badgeRow.appendChild(createBadge(`${pr.changed_files} file${pr.changed_files !== 1 ? "s" : ""}`, "#6f42c1", `${pr.changed_files} files changed`));

  // Review status
  const reviewInfo = getReviewBadgeInfo(reviewSummary.overall);
  const reviewTitle = buildReviewTitle(reviewSummary);
  badgeRow.appendChild(createIconBadge(reviewInfo.icon, reviewInfo.text, reviewInfo.color, reviewTitle));

  // Enhance GitHub's existing CI icon with extended text (instead of our own badge)
  enhanceExistingCIIcon(row, ci);

  // Merge conflict
  const mergeInfo = getMergeabilityInfo(pr.mergeable_state);
  if (mergeInfo) {
    badgeRow.appendChild(createIconBadge(mergeInfo.icon, mergeInfo.text, mergeInfo.color, `Merge status: ${mergeInfo.text}`));
  }

  // Branch staleness
  const stalenessInfo = getStalenessInfo(comparison);
  if (stalenessInfo) {
    badgeRow.appendChild(createIconBadge("↓", stalenessInfo.text, stalenessInfo.color, `Branch is ${stalenessInfo.text} ${pr.base_ref}`));
  }

  // Requested reviewer highlight (you)
  if (currentUserLogin && pr.requested_reviewers.includes(currentUserLogin)) {
    badgeRow.appendChild(createIconBadge("👁", "Review requested", "#0969da", "You have been requested to review this PR"));
    row.classList.add("ghpr-review-requested");
  }

  // Review comments count
  if (pr.review_comments > 0) {
    badgeRow.appendChild(createIconBadge("💬", `${pr.review_comments}`, "#6e7781", `${pr.review_comments} review comment${pr.review_comments !== 1 ? "s" : ""}`));
  }

  // ── Color the existing "opened X ago" timestamp based on age ──
  colorExistingTimestamp(row, pr.created_at);

  // ── Inject into DOM ──
  const titleLink = row.querySelector('a[id^="issue_"]') || row.querySelector('a[href*="/pull/"]');
  if (titleLink) {
    const parentEl = titleLink.closest("div") || titleLink.parentElement;
    if (parentEl) {
      parentEl.appendChild(badgeRow);
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

// ── Read CI status from the list page row (already rendered by GitHub) ──

function readCIFromRow(row: Element): CIStatus {
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

function isDraftFromRow(row: Element): boolean {
  // GitHub renders "Draft" as a tooltip or label on the PR icon
  const prIcon = row.querySelector('svg.octicon-git-pull-request-draft');
  if (prIcon) return true;
  const titleEl = row.querySelector('[aria-label*="Draft"]');
  if (titleEl) return true;
  return false;
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
          // Override CI with info from the list page (already rendered, more reliable)
          data.ci = readCIFromRow(row);
          // Supplement draft status from list page
          if (!data.pr.draft && isDraftFromRow(row)) {
            data.pr.draft = true;
          }
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
