import type {
  PullRequestDetails,
  CombinedStatus,
  ReviewInfo,
  CheckRunInfo,
  BranchComparison,
  EnhancedPRData,
} from "./utils/pr-helpers";
import { summarizeCI } from "./utils/pr-helpers";

// ── Message types ──

export interface FetchPREnhancedMessage {
  type: "FETCH_PR_ENHANCED";
  owner: string;
  repo: string;
  prNumber: number;
}

export interface FetchCurrentUserMessage {
  type: "FETCH_CURRENT_USER";
}

export type ExtensionMessage = FetchPREnhancedMessage | FetchCurrentUserMessage;

export interface EnhancedPRResponse {
  success: true;
  data: EnhancedPRData;
}

export interface CurrentUserResponse {
  success: true;
  login: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

export type MessageResponse = EnhancedPRResponse | CurrentUserResponse | ErrorResponse;

// ── GitHub API helper ──

async function getToken(): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["github_token"], (result) => {
      resolve(result.github_token || null);
    });
  });
}

async function githubFetch(url: string): Promise<Response> {
  const token = await getToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return fetch(url, { headers });
}

// ── Individual fetchers ──

async function fetchPR(owner: string, repo: string, prNumber: number): Promise<PullRequestDetails> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  if (!response.ok) throw new Error(`PR API ${response.status}`);
  const data = await response.json();
  return {
    number: data.number,
    title: data.title,
    additions: data.additions,
    deletions: data.deletions,
    changed_files: data.changed_files,
    created_at: data.created_at,
    updated_at: data.updated_at,
    merged_at: data.merged_at,
    draft: data.draft,
    mergeable_state: data.mergeable_state || "unknown",
    labels: data.labels.map((l: any) => ({ name: l.name, color: l.color })),
    head_sha: data.head?.sha || "",
    head_ref: data.head?.ref || "",
    base_ref: data.base?.ref || "",
    user_login: data.user?.login || "",
    requested_reviewers: (data.requested_reviewers || []).map((r: any) => r.login),
    review_comments: data.review_comments || 0,
  };
}

async function fetchReviews(owner: string, repo: string, prNumber: number): Promise<ReviewInfo[]> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`
  );
  if (!response.ok) return [];
  const data = await response.json();
  return data.map((r: any) => ({
    user: r.user?.login || "unknown",
    state: r.state,
    submitted_at: r.submitted_at,
  }));
}

async function fetchCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedStatus | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`
  );
  if (!response.ok) return null;
  const data = await response.json();
  return {
    state: data.state,
    total_count: data.total_count,
    statuses: (data.statuses || []).map((s: any) => ({
      state: s.state,
      context: s.context,
      description: s.description,
    })),
  };
}

async function fetchCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRunInfo[]> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`
  );
  if (!response.ok) return [];
  const data = await response.json();
  return (data.check_runs || []).map((cr: any) => ({
    name: cr.name,
    status: cr.status,
    conclusion: cr.conclusion,
  }));
}

async function fetchComparison(owner: string, repo: string, base: string, head: string): Promise<BranchComparison | null> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`
  );
  if (!response.ok) return null;
  const data = await response.json();
  return {
    behind_by: data.behind_by ?? 0,
    ahead_by: data.ahead_by ?? 0,
  };
}

async function fetchCurrentUser(): Promise<string | null> {
  const response = await githubFetch("https://api.github.com/user");
  if (!response.ok) return null;
  const data = await response.json();
  return data.login || null;
}

// ── Orchestrator: single message fetches everything ──

async function fetchEnhancedPR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<EnhancedPRResponse | ErrorResponse> {
  try {
    // Step 1: fetch PR details (needed for head_sha, refs)
    const pr = await fetchPR(owner, repo, prNumber);

    // Step 2: fetch reviews, CI, and comparison in parallel
    const [reviews, combinedStatus, checkRuns, comparison] = await Promise.all([
      fetchReviews(owner, repo, prNumber),
      pr.head_sha ? fetchCombinedStatus(owner, repo, pr.head_sha) : Promise.resolve(null),
      pr.head_sha ? fetchCheckRuns(owner, repo, pr.head_sha) : Promise.resolve([]),
      pr.head_ref && pr.base_ref
        ? fetchComparison(owner, repo, pr.base_ref, pr.head_ref)
        : Promise.resolve(null),
    ]);

    const ci = summarizeCI(combinedStatus, checkRuns);

    return {
      success: true,
      data: { pr, reviews, ci, comparison },
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ── Message listener ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === "FETCH_PR_ENHANCED") {
      fetchEnhancedPR(message.owner, message.repo, message.prNumber).then(sendResponse);
      return true;
    }
    if (message.type === "FETCH_CURRENT_USER") {
      fetchCurrentUser().then((login) => {
        if (login) {
          sendResponse({ success: true, login } as CurrentUserResponse);
        } else {
          sendResponse({ success: false, error: "Not authenticated" } as ErrorResponse);
        }
      });
      return true;
    }
  }
);
