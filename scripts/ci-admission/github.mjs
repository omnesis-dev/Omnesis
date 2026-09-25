// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export class GitHubApiError extends Error {
  constructor(message, { status, retryable = false, retryAt = null } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAt = retryAt;
  }
}

function retryAt(response, now = Date.now()) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return new Date(now + seconds * 1_000).toISOString();
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1_000).toISOString();
  return null;
}

function nextLink(header) {
  for (const part of (header ?? "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export class GitHubClient {
  constructor({ repository, token, fetchImpl = fetch, apiUrl = "https://api.github.com" }) {
    if (!/^[^/]+\/[^/]+$/.test(repository ?? "")) throw new Error("repository must be owner/name");
    if (!token) throw new Error("GitHub token is required");
    this.base = `${apiUrl}/repos/${repository}`;
    this.apiUrl = apiUrl;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(pathOrUrl, options = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    const expectedOrigin = new URL(this.apiUrl).origin;
    if (new URL(url).origin !== expectedOrigin) {
      throw new GitHubApiError("refusing to send GitHub credentials to a different origin");
    }
    const response = await this.fetch(url, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2026-03-10",
        ...options.headers,
      },
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new GitHubApiError(`GitHub returned malformed JSON for ${url}`, {
          status: response.status,
          retryable: response.status >= 500,
          retryAt: retryAt(response),
        });
      }
    }
    if (!response.ok) {
      throw new GitHubApiError(`GitHub request failed (${response.status})`, {
        status: response.status,
        retryable: response.status === 403 || response.status === 429 || response.status >= 500,
        retryAt: retryAt(response),
      });
    }
    return { body, response };
  }

  async paginate(path, collectionField = null) {
    const values = [];
    let next = path;
    while (next) {
      const { body, response } = await this.request(next);
      const page = collectionField == null ? body : body?.[collectionField];
      if (!Array.isArray(page))
        throw new GitHubApiError("paginated GitHub response was not an array");
      values.push(...page);
      next = nextLink(response.headers.get("link"));
    }
    return values;
  }

  async commit(sha) {
    return (await this.request(`/commits/${sha}`)).body;
  }

  async associatedPullRequests(sha) {
    return this.paginate(`/commits/${sha}/pulls?per_page=100`);
  }

  async workflowRuns(workflow, branch = "main") {
    return this.paginate(
      `/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
      "workflow_runs",
    );
  }

  async workflowJobs(runId) {
    return this.paginate(`/actions/runs/${runId}/jobs?per_page=100`, "jobs");
  }

  async workflowRun(runId) {
    return (await this.request(`/actions/runs/${runId}`)).body;
  }

  async dispatch(workflow, inputs) {
    return (
      await this.request(`/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs }),
      })
    ).body;
  }

  async user(login) {
    return (await this.request(`${this.apiUrl}/users/${encodeURIComponent(login)}`)).body;
  }

  async createCommitStatus(sha, status) {
    return (
      await this.request(`/statuses/${sha}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(status),
      })
    ).body;
  }
}

export function parseTrustedIds(value) {
  if (!value?.trim()) return new Set();
  const ids = value.split(",").map((part) => Number(part.trim()));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new Error("trusted IDs must be positive integers");
  return new Set(ids);
}
