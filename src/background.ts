import type { PullRequestDetails, CombinedStatus } from "./utils/pr-helpers";

export interface FetchPRMessage {
  type: "FETCH_PR";
  owner: string;
  repo: string;
  prNumber: number;
}

export interface FetchStatusMessage {
  type: "FETCH_STATUS";
  owner: string;
  repo: string;
  ref: string;
}

export type ExtensionMessage = FetchPRMessage | FetchStatusMessage;

export interface PRResponse {
  success: true;
  data: PullRequestDetails;
}

export interface StatusResponse {
  success: true;
  data: CombinedStatus;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

export type MessageResponse = PRResponse | StatusResponse | ErrorResponse;

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

async function fetchPR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRResponse | ErrorResponse> {
  try {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`
    );
    if (!response.ok) {
      return { success: false, error: `API error: ${response.status} ${response.statusText}` };
    }
    const data = await response.json();
    return {
      success: true,
      data: {
        number: data.number,
        title: data.title,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        created_at: data.created_at,
        updated_at: data.updated_at,
        merged_at: data.merged_at,
        draft: data.draft,
        mergeable_state: data.mergeable_state,
        labels: data.labels.map((l: any) => ({ name: l.name, color: l.color })),
      },
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function fetchStatus(
  owner: string,
  repo: string,
  ref: string
): Promise<StatusResponse | ErrorResponse> {
  try {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`
    );
    if (!response.ok) {
      return { success: false, error: `API error: ${response.status}` };
    }
    const data = await response.json();
    return {
      success: true,
      data: {
        state: data.state,
        total_count: data.total_count,
        statuses: data.statuses.map((s: any) => ({
          state: s.state,
          context: s.context,
          description: s.description,
        })),
      },
    };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === "FETCH_PR") {
      fetchPR(message.owner, message.repo, message.prNumber).then(sendResponse);
      return true; // async response
    }
    if (message.type === "FETCH_STATUS") {
      fetchStatus(message.owner, message.repo, message.ref).then(sendResponse);
      return true;
    }
  }
);
