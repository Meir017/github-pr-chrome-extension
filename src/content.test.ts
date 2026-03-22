import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseRepoFromURL,
  getPRNumberFromRow,
  buildReviewTitle,
  readReviewsFromRow,
  readCIFromRow,
  isDraftFromRow,
} from "./content";

// ── buildReviewTitle (pure function) ──

describe("buildReviewTitle", () => {
  it("returns 'No reviews yet' for empty summary", () => {
    const result = buildReviewTitle({
      approved: [],
      changesRequested: [],
      commented: [],
      overall: "none",
    });
    expect(result).toBe("No reviews yet");
  });

  it("lists approved reviewers", () => {
    const result = buildReviewTitle({
      approved: ["alice", "bob"],
      changesRequested: [],
      commented: [],
      overall: "approved",
    });
    expect(result).toBe("Approved by: alice, bob");
  });

  it("lists changes requested reviewers", () => {
    const result = buildReviewTitle({
      approved: [],
      changesRequested: ["charlie"],
      commented: [],
      overall: "changes_requested",
    });
    expect(result).toBe("Changes requested by: charlie");
  });

  it("lists commenters", () => {
    const result = buildReviewTitle({
      approved: [],
      changesRequested: [],
      commented: ["dave"],
      overall: "pending",
    });
    expect(result).toBe("Comments from: dave");
  });

  it("combines all sections", () => {
    const result = buildReviewTitle({
      approved: ["alice"],
      changesRequested: ["bob"],
      commented: ["charlie"],
      overall: "changes_requested",
    });
    expect(result).toContain("Approved by: alice");
    expect(result).toContain("Changes requested by: bob");
    expect(result).toContain("Comments from: charlie");
  });
});

// ── parseRepoFromURL ──

describe("parseRepoFromURL", () => {
  it("parses owner and repo from pulls URL", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/acme-corp/web-platform/pulls" },
      writable: true,
    });
    const result = parseRepoFromURL();
    expect(result).toEqual({ owner: "acme-corp", repo: "web-platform" });
  });

  it("parses URL with query string", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/owner/repo/pulls" },
      writable: true,
    });
    expect(parseRepoFromURL()).toEqual({ owner: "owner", repo: "repo" });
  });

  it("returns null for non-pulls pages", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/owner/repo/issues" },
      writable: true,
    });
    expect(parseRepoFromURL()).toBeNull();
  });

  it("returns null for root page", () => {
    Object.defineProperty(window, "location", {
      value: { pathname: "/" },
      writable: true,
    });
    expect(parseRepoFromURL()).toBeNull();
  });
});

// ── getPRNumberFromRow ──

describe("getPRNumberFromRow", () => {
  it("extracts PR number from issue link id", () => {
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.id = "issue_42_link";
    row.appendChild(link);
    expect(getPRNumberFromRow(row)).toBe(42);
  });

  it("falls back to href-based extraction", () => {
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.href = "https://github.com/owner/repo/pull/99";
    row.appendChild(link);
    expect(getPRNumberFromRow(row)).toBe(99);
  });

  it("returns null when no PR link found", () => {
    const row = document.createElement("div");
    expect(getPRNumberFromRow(row)).toBeNull();
  });
});

// ── readReviewsFromRow ──

describe("readReviewsFromRow", () => {
  function makeRow(linkText: string, ariaLabel?: string): Element {
    const row = document.createElement("div");
    const link = document.createElement("a");
    link.href = "/owner/repo/pull/1#partial-pull-merging";
    link.textContent = linkText;
    if (ariaLabel) link.setAttribute("aria-label", ariaLabel);
    row.appendChild(link);
    return row;
  }

  it("returns 'none' when no review link exists", () => {
    const row = document.createElement("div");
    const result = readReviewsFromRow(row);
    expect(result.overall).toBe("none");
  });

  it("detects 'approved'", () => {
    const row = makeRow("Approved", "2 approving reviews");
    const result = readReviewsFromRow(row);
    expect(result.overall).toBe("approved");
    expect(result.approved).toEqual(["2 approving reviews"]);
  });

  it("detects 'changes requested'", () => {
    const row = makeRow("Changes requested", "1 review requesting changes");
    const result = readReviewsFromRow(row);
    expect(result.overall).toBe("changes_requested");
    expect(result.changesRequested).toEqual(["1 review requesting changes"]);
  });

  it("detects 'review required' as pending", () => {
    const row = makeRow("Review required");
    const result = readReviewsFromRow(row);
    expect(result.overall).toBe("pending");
  });

  it("falls back to 'none' for unknown text", () => {
    const row = makeRow("Draft");
    const result = readReviewsFromRow(row);
    expect(result.overall).toBe("none");
  });
});

// ── readCIFromRow ──

describe("readCIFromRow", () => {
  function makeRow(ariaLabel: string): Element {
    const row = document.createElement("div");
    const el = document.createElement("span");
    el.setAttribute("aria-label", ariaLabel);
    row.appendChild(el);
    return row;
  }

  it("returns 'none' when no CI element exists", () => {
    const row = document.createElement("div");
    const result = readCIFromRow(row);
    expect(result.overall).toBe("none");
    expect(result.total).toBe(0);
  });

  it("parses '3 / 3 checks OK'", () => {
    const row = makeRow("3 / 3 checks OK");
    const result = readCIFromRow(row);
    expect(result.overall).toBe("success");
    expect(result.passed).toBe(3);
    expect(result.total).toBe(3);
    expect(result.failed).toBe(0);
  });

  it("parses '2 / 3 checks OK' as failure", () => {
    const row = makeRow("2 / 3 checks OK");
    // 2 passed, 1 failed → failure? Actually the regex: allOk = match[3] ("OK") is defined,
    // but failed = 3 - 2 = 1, so failed > 0 → "failure"
    const result = readCIFromRow(row);
    expect(result.overall).toBe("failure");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
  });

  it("parses '0 / 1 checks' (no OK) as failure", () => {
    const row = makeRow("0 / 1 checks");
    const result = readCIFromRow(row);
    // 0 passed, 1 total, no "OK" → failed = 1 → failure
    expect(result.overall).toBe("failure");
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(1);
  });

  it("fallback: detects 'ok' keyword as success", () => {
    const row = makeRow("all checks passed ok");
    const result = readCIFromRow(row);
    expect(result.overall).toBe("success");
  });

  it("fallback: detects 'fail' keyword as failure", () => {
    const row = makeRow("1 check failed");
    const result = readCIFromRow(row);
    expect(result.overall).toBe("failure");
  });

  it("fallback: unknown label treated as pending", () => {
    const row = makeRow("checking...");
    const result = readCIFromRow(row);
    expect(result.overall).toBe("pending");
  });
});

// ── isDraftFromRow ──

describe("isDraftFromRow", () => {
  it("returns false when no draft indicators", () => {
    const row = document.createElement("div");
    expect(isDraftFromRow(row)).toBe(false);
  });

  it("detects draft SVG icon", () => {
    const row = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("octicon-git-pull-request-draft");
    row.appendChild(svg);
    expect(isDraftFromRow(row)).toBe(true);
  });

  it("detects Draft aria-label", () => {
    const row = document.createElement("div");
    const el = document.createElement("span");
    el.setAttribute("aria-label", "Draft Pull Request");
    row.appendChild(el);
    expect(isDraftFromRow(row)).toBe(true);
  });
});
