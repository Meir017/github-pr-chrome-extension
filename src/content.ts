import {
  calculatePRSize,
  getSizeColor,
  getAgeColor,
  getReviewBadgeInfo,
  getMergeabilityInfo,
  getStalenessInfo,
  type EnhancedPRData,
  type PullRequestDetails,
  type CIStatus,
  type ReviewSummary,
} from "./utils/pr-helpers";
import {
  parseRepoFromURL,
  getPRNumberFromRow,
  buildReviewTitle,
  readReviewsFromRow,
  readCIFromRow,
  isDraftFromRow,
} from "./content-helpers";

// ── Current user ──
let currentUserLogin: string | null = null;

function detectCurrentUser(): void {
  // GitHub embeds the logged-in user's login in the page's meta tags
  const meta = document.querySelector('meta[name="user-login"]');
  if (meta) {
    currentUserLogin = meta.getAttribute("content");
  }
}

// ── Same-origin JSON fetch (uses session cookies — no PAT needed) ──

async function ghFetchJSON(path: string): Promise<any> {
  const resp = await fetch(`https://github.com${path}`, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    credentials: "same-origin",
  });
  if (!resp.ok) throw new Error(`GitHub JSON fetch failed: ${resp.status}`);
  return resp.json();
}

// ── Data fetching via same-origin JSON endpoint ──

async function fetchPRData(owner: string, repo: string, prNumber: number, row: Element): Promise<EnhancedPRData | null> {
  try {
    const json = await ghFetchJSON(`/${owner}/${repo}/pull/${prNumber}/files`);
    const route = json?.payload?.pullRequestsChangesRoute;
    if (!route) {
      console.debug("[GHPR] No pullRequestsChangesRoute in JSON for PR #" + prNumber);
      return null;
    }

    // ── Diff stats from diffSummaries (accurate, never truncated) ──
    const summaries: any[] = route.diffSummaries || [];
    let additions = 0, deletions = 0;
    for (const file of summaries) {
      additions += file.linesAdded || 0;
      deletions += file.linesDeleted || 0;
    }

    // ── PR metadata from JSON ──
    const prData = route.pullRequest || {};

    // ── Timestamp from the list-page row ──
    const timeEl = row.querySelector("relative-time");
    const createdAt = timeEl?.getAttribute("datetime") || new Date().toISOString();

    const pr: PullRequestDetails = {
      number: prData.number || prNumber,
      title: prData.title || `PR #${prNumber}`,
      additions,
      deletions,
      changed_files: summaries.length,
      created_at: createdAt,
      updated_at: createdAt,
      merged_at: prData.mergedTime || null,
      draft: isDraftFromRow(row),
      mergeable_state: "unknown",
      labels: [],
      head_sha: prData.comparison?.headOid || "",
      head_ref: prData.headBranch || "",
      base_ref: prData.baseBranch || "",
      user_login: prData.author?.login || "",
      requested_reviewers: [],
      review_comments: prData.issueCommentsCount || 0,
    };

    const ci = readCIFromRow(row);

    return { pr, reviews: [], ci, comparison: null };
  } catch (err) {
    console.debug("[GHPR] fetchPRData error:", err);
    return null;
  }
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

  const { pr, ci, comparison } = data;
  const reviewSummary = readReviewsFromRow(row);

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
        const data = await fetchPRData(owner, repo, prNumber, row);
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
