import {
  calculatePRSize,
  getSizeColor,
  formatRelativeTime,
  getAgeColor,
  type PullRequestDetails,
} from "./utils/pr-helpers";
import type { PRResponse, ErrorResponse } from "./background";

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
  // fallback: parse from href
  const prLink = row.querySelector<HTMLAnchorElement>('a[href*="/pull/"]');
  if (prLink) {
    const match = prLink.href.match(/\/pull\/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

function fetchPRDetails(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRResponse | ErrorResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FETCH_PR", owner, repo, prNumber },
      (response: PRResponse | ErrorResponse) => {
        resolve(response);
      }
    );
  });
}

function createBadge(text: string, bgColor: string, title: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "ghpr-badge";
  badge.textContent = text;
  badge.title = title;
  badge.style.backgroundColor = bgColor;
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

function createInfoContainer(): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "ghpr-enhancements";
  return container;
}

function injectPRInfo(row: Element, pr: PullRequestDetails): void {
  // avoid double-injection
  if (row.querySelector(".ghpr-enhancements")) return;

  const size = calculatePRSize(pr.additions, pr.deletions);
  const sizeColor = getSizeColor(size);
  const ageColor = getAgeColor(pr.created_at);
  const relativeTime = formatRelativeTime(pr.created_at);

  const container = createInfoContainer();

  // size badge
  const sizeBadge = createBadge(
    size,
    sizeColor,
    `PR Size: ${size} (${pr.additions + pr.deletions} lines changed)`
  );
  container.appendChild(sizeBadge);

  // diff stats
  const diffStats = createDiffStats(pr.additions, pr.deletions);
  container.appendChild(diffStats);

  // files changed
  const filesBadge = createBadge(
    `${pr.changed_files} file${pr.changed_files !== 1 ? "s" : ""}`,
    "#6f42c1",
    `${pr.changed_files} files changed`
  );
  container.appendChild(filesBadge);

  // age indicator
  const ageBadge = createBadge(relativeTime, ageColor, `Created: ${new Date(pr.created_at).toLocaleDateString()}`);
  ageBadge.classList.add("ghpr-age-badge");
  container.appendChild(ageBadge);

  // draft indicator
  if (pr.draft) {
    const draftBadge = createBadge("Draft", "#6a737d", "This is a draft PR");
    container.appendChild(draftBadge);
  }

  // find the right place to inject — after the PR title/meta row
  const titleLink = row.querySelector('a[id^="issue_"]') || row.querySelector('a[href*="/pull/"]');
  if (titleLink) {
    const parentEl = titleLink.closest("div") || titleLink.parentElement;
    if (parentEl) {
      parentEl.appendChild(container);
    }
  }
}

async function enhancePRList(): Promise<void> {
  const repoInfo = parseRepoFromURL();
  if (!repoInfo) return;

  // GitHub's PR list uses different selectors depending on the UI version
  const rows = document.querySelectorAll(
    '[id^="issue_"]:not(.ghpr-processed), .js-issue-row:not(.ghpr-processed)'
  );

  if (rows.length === 0) return;

  const { owner, repo } = repoInfo;

  // process PRs in batches to avoid rate limiting
  const BATCH_SIZE = 5;
  const rowArray = Array.from(rows);

  for (let i = 0; i < rowArray.length; i += BATCH_SIZE) {
    const batch = rowArray.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (row) => {
      row.classList.add("ghpr-processed");

      // try getting PR number from the row itself or a parent
      const prRow = row.closest("[id^='issue_']") || row;
      const prNumber = getPRNumberFromRow(prRow);
      if (!prNumber) return;

      const response = await fetchPRDetails(owner, repo, prNumber);
      if (response.success) {
        injectPRInfo(prRow, response.data);
      }
    });
    await Promise.all(promises);
  }
}

// initial run
enhancePRList();

// observe for dynamic page changes (GitHub uses Turbo/pjax)
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length > 0) {
      // debounce: wait a tick for the DOM to settle
      setTimeout(() => enhancePRList(), 300);
      break;
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// also re-run on turbo navigation
document.addEventListener("turbo:load", () => {
  setTimeout(() => enhancePRList(), 500);
});
