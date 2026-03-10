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
