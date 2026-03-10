const tokenInput = document.getElementById("token") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const statsDiv = document.getElementById("stats") as HTMLDivElement;

function showStatus(message: string, type: "success" | "error" | "info") {
  statusDiv.textContent = message;
  statusDiv.className = `status-${type}`;
  if (type === "success") {
    setTimeout(() => {
      statusDiv.textContent = "";
    }, 3000);
  }
}

// load existing token
chrome.storage.sync.get(["github_token"], (result) => {
  if (result.github_token) {
    tokenInput.value = result.github_token;
    showStatus("Token loaded", "info");
    checkRateLimit(result.github_token);
  }
});

saveButton.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  chrome.storage.sync.set({ github_token: token }, () => {
    if (chrome.runtime.lastError) {
      showStatus("Error saving token", "error");
    } else {
      showStatus(token ? "Token saved ✓" : "Token cleared ✓", "success");
      if (token) checkRateLimit(token);
    }
  });
});

async function checkRateLimit(token: string): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }
    const res = await fetch("https://api.github.com/rate_limit", { headers });
    if (res.ok) {
      const data = await res.json();
      const core = data.resources.core;
      statsDiv.innerHTML = `
        API Rate Limit: <strong>${core.remaining}</strong> / ${core.limit} remaining<br>
        Resets at: <strong>${new Date(core.reset * 1000).toLocaleTimeString()}</strong>
      `;
    }
  } catch {
    statsDiv.textContent = "Could not check rate limit";
  }
}
