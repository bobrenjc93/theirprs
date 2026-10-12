const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SLEEP_FILE = path.join(__dirname, "sleep.json");
const BLOCKLIST_FILE = path.join(__dirname, "blocklist.json");
// GitHub is queried at most once per REFRESH_INTERVAL_MS: automatically by the
// server, or earlier via the Refresh button if the last fetch is that old. Page
// loads, tabs, and every dev server read one on-disk copy of the results, so they
// never spend the GraphQL quota (5,000 points/hour, shared with every other gh
// user on the account).
const CACHE_FILE = process.env.PRS_CACHE_FILE || path.join(__dirname, ".prs-cache.json");
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_REFRESH_CHECK_MS = 60 * 1000;
// After a failed automatic refresh, wait this long before trying again.
const AUTO_REFRESH_RETRY_MS = 5 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), { etag: false, maxAge: 0 }));

function readSleep() {
  try {
    return JSON.parse(fs.readFileSync(SLEEP_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSleep(data) {
  fs.writeFileSync(SLEEP_FILE, JSON.stringify(data, null, 2));
}

function readBlocklist() {
  try {
    const data = JSON.parse(fs.readFileSync(BLOCKLIST_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeBlocklist(names) {
  fs.writeFileSync(BLOCKLIST_FILE, JSON.stringify(names, null, 2));
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(data) {
  // Write then rename so another server never reads a half-written file.
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, CACHE_FILE);
}

function getActiveSleep() {
  const sleep = readSleep();
  const now = Date.now();
  let changed = false;

  for (const key of Object.keys(sleep)) {
    if (new Date(sleep[key].until).getTime() <= now) {
      delete sleep[key];
      changed = true;
    }
  }

  if (changed) {
    writeSleep(sleep);
  }

  return sleep;
}

function execGhJson(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

function execGhText(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function isRateLimitError(error) {
  return /rate limit/i.test(`${error?.message}\n${error?.stderr}`);
}

// Rate-limited responses still carry X-RateLimit-Reset, which gh prints with -i.
function graphqlRateLimitReset() {
  return new Promise((resolve) => {
    execFile("gh", ["api", "-i", "graphql", "-f", "query={ rateLimit { resetAt } }"],
      { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const match = /^x-ratelimit-reset:\s*(\d+)/im.exec(stdout || "");
        const reset = match ? Number(match[1]) * 1000 : Date.now() + RATE_LIMIT_FALLBACK_MS;
        // Secondary limits can trip with quota left; still back off briefly.
        resolve(Math.max(reset, Date.now() + 60 * 1000));
      });
  });
}

async function loadRemainingOpinionatedReviews(repo, number, reviews) {
  if (!Array.isArray(reviews?.nodes)) {
    return;
  }

  const [owner, name] = repo.split("/");
  while (reviews.pageInfo?.hasNextPage && reviews.pageInfo.endCursor) {
    const cursor = reviews.pageInfo.endCursor;
    try {
      const result = await execGhJson([
        "api", "graphql",
        "-f", `query=query($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              latestOpinionatedReviews(first: 100, after: $cursor) {
                nodes { author { login __typename } state }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`,
        "-F", `number=${number}`,
        "-f", `cursor=${cursor}`,
      ]);
      const next = result.data?.repository?.pullRequest?.latestOpinionatedReviews;
      if (!Array.isArray(next?.nodes)) {
        return;
      }
      reviews.nodes.push(...next.nodes);
      reviews.pageInfo = next.pageInfo;
      if (reviews.pageInfo?.endCursor === cursor) {
        return;
      }
    } catch (error) {
      if (isRateLimitError(error)) {
        throw error;
      }
      // Keep known reviews, but leave the connection incomplete so a re-request
      // cannot override a changes request whose reviewers we could not load.
      return;
    }
  }
}

function hasOtherHumanApproval(detail, viewerLogin) {
  const reviews = detail?.latestOpinionatedReviews?.nodes;
  const viewer = viewerLogin.toLowerCase();
  return Array.isArray(reviews) && reviews.some((review) =>
    review?.state === "APPROVED" && review.author?.__typename === "User" &&
    review.author.login && review.author.login.toLowerCase() !== viewer
  );
}

function isReReviewRequested(detail, viewerLogin) {
  const viewer = viewerLogin.toLowerCase();
  const requested = detail?.reviewRequests?.nodes?.some(
    (request) => request?.requestedReviewer?.login?.toLowerCase() === viewer
  );
  const reviews = detail?.latestOpinionatedReviews;

  // Only override the aggregate decision with complete review information.
  if (!requested || !Array.isArray(reviews?.nodes) ||
      reviews.pageInfo?.hasNextPage !== false || reviews.nodes.some((review) => !review)) {
    return false;
  }

  const blockers = reviews.nodes.filter((review) => review.state === "CHANGES_REQUESTED");

  // Submitting a review consumes the original request. A current direct request
  // means the viewer has been asked again, but it cannot clear anyone else's
  // outstanding changes request. Opinionated reviews also survive later comments.
  return blockers.length > 0 && blockers.every(
    (review) => review.author?.login?.toLowerCase() === viewer
  );
}

async function fetchPRsFromGitHub() {
  const [viewerLogin, prs] = await Promise.all([
    execGhText(["api", "user", "--jq", ".login"]),
    execGhJson([
      "search",
      "prs",
      "--review-requested=@me",
      "--state=open",
      "--limit=200",
      "--json",
      "number,title,repository,updatedAt,url,isDraft,state,createdAt,labels,author",
    ]),
  ]);

  const byRepo = new Map();
  for (const pr of prs) {
    const repo = pr.repository.nameWithOwner;
    if (!byRepo.has(repo)) {
      byRepo.set(repo, []);
    }
    byRepo.get(repo).push(pr);
  }

  await Promise.all([...byRepo.entries()].map(async ([repo, repoPrs]) => {
    try {
      const [owner, name] = repo.split("/");
      // Look up the discovered PRs directly: a second search can disagree with
      // the first, and gh pr list does not expose latestOpinionatedReviews.
      const query = `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          ${repoPrs.map((pr) => `pr${pr.number}: pullRequest(number: ${pr.number}) {
            reviewDecision
            reviewRequests(first: 100) {
              nodes { requestedReviewer { ... on User { login } } }
            }
            latestOpinionatedReviews(first: 100) {
              nodes { author { login __typename } state }
              pageInfo { hasNextPage endCursor }
            }
          }`).join("\n")}
        }
      }`;
      const details = await execGhJson([
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`,
      ]);

      await Promise.all(repoPrs.map(async (pr) => {
        const detail = details.data.repository?.[`pr${pr.number}`];
        await loadRemainingOpinionatedReviews(repo, pr.number, detail?.latestOpinionatedReviews);
        pr.reviewDecision = (detail && detail.reviewDecision) || "";
        pr.hasOtherHumanApproval = hasOtherHumanApproval(detail, viewerLogin);
        pr.isReReviewRequested = isReReviewRequested(detail, viewerLogin);
      }));
    } catch (error) {
      // Don't cache a degraded answer: changes-requested PRs would reappear.
      if (isRateLimitError(error)) {
        throw error;
      }
      for (const pr of repoPrs) {
        pr.reviewDecision = "";
        pr.hasOtherHumanApproval = false;
        pr.isReReviewRequested = false;
      }
    }
  }));

  return { viewerLogin, prs };
}

function filterPRs(prs, viewerLogin) {
  const blocklist = new Set(readBlocklist().map((name) => name.toLowerCase()));

  return prs.filter((pr) => {
    if (!pr.author || pr.author.login === viewerLogin || pr.isDraft) {
      return false;
    }

    if (blocklist.has(pr.author.login.toLowerCase())) {
      return false;
    }

    // Bot approvals do not replace a human review. Our own earlier approval
    // also does not clear a new request to review again.
    if (pr.hasOtherHumanApproval) {
      return false;
    }

    // A fresh request can return our own review to the queue; other reviewers'
    // outstanding changes requests still leave the ball in the author's court.
    return pr.reviewDecision !== "CHANGES_REQUESTED" || pr.isReReviewRequested;
  });
}

let inFlight = null;

// Concurrent requests share one fetch. A rate-limit error records when the
// quota resets so no further gh calls are made until then.
function refreshCache(cache) {
  inFlight ??= (async () => {
    try {
      const next = { ...(await fetchPRsFromGitHub()), fetchedAt: Date.now() };
      writeCache(next);
      return next;
    } catch (e) {
      console.error("gh error:", e.message);
      if (e.stderr) {
        console.error(e.stderr);
      }
      if (!isRateLimitError(e)) {
        throw e;
      }
      const next = { ...cache, rateLimitedUntil: await graphqlRateLimitReset() };
      console.error(`GitHub rate limited; pausing gh calls until ${new Date(next.rateLimitedUntil).toLocaleTimeString()}`);
      writeCache(next);
      return next;
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function nextRefreshAt(cache) {
  return Math.max(cache.fetchedAt ? cache.fetchedAt + REFRESH_INTERVAL_MS : 0, cache.rateLimitedUntil || 0);
}

function sendPRs(res, cache, status = 200) {
  const next = nextRefreshAt(cache);
  if (next > Date.now()) {
    res.set("X-Next-Refresh-At", new Date(next).toISOString());
  }
  if (cache.rateLimitedUntil > Date.now()) {
    res.set("X-Rate-Limited", "1");
  }
  if (cache.fetchedAt) {
    res.set("X-Fetched-At", new Date(cache.fetchedAt).toISOString());
  }
  res.status(status).json(cache.prs ? filterPRs(cache.prs, cache.viewerLogin) : []);
}

// Never queries GitHub; returns the results of the last refresh (empty before
// the first one, which X-Fetched-At's absence signals).
app.get("/api/prs", (req, res) => {
  sendPRs(res, readCache());
});

// Queries GitHub unless the last refresh was under an hour ago or we are rate
// limited; either way the response carries the current results.
app.post("/api/prs/refresh", async (req, res) => {
  let cache = readCache();
  if (nextRefreshAt(cache) > Date.now()) {
    return sendPRs(res, cache, 429);
  }

  try {
    cache = await refreshCache(cache);
  } catch {
    return res.status(500).json({ error: "Failed to fetch PRs" });
  }
  sendPRs(res, cache, cache.rateLimitedUntil > Date.now() ? 429 : 200);
});

app.get("/api/sleep", (req, res) => {
  res.json(getActiveSleep());
});

app.post("/api/sleep", (req, res) => {
  const { keys, days } = req.body;

  if (!Array.isArray(keys) || !days) {
    return res.status(400).json({ error: "keys (array) and days (number) required" });
  }

  const sleep = getActiveSleep();
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  for (const key of keys) {
    sleep[key] = { until };
  }

  writeSleep(sleep);
  res.json(sleep);
});

app.delete("/api/sleep/:key", (req, res) => {
  const sleep = getActiveSleep();
  delete sleep[req.params.key];
  writeSleep(sleep);
  res.json(sleep);
});

app.get("/api/blocklist", (req, res) => {
  res.json(readBlocklist());
});

app.post("/api/blocklist", (req, res) => {
  const { name } = req.body;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name (non-empty string) required" });
  }

  const cleaned = name.trim().replace(/^@/, "");
  const blocklist = readBlocklist();

  if (!blocklist.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) {
    blocklist.push(cleaned);
    blocklist.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    writeBlocklist(blocklist);
  }

  res.json(blocklist);
});

app.delete("/api/blocklist/:name", (req, res) => {
  const target = req.params.name.toLowerCase();
  const blocklist = readBlocklist().filter((name) => name.toLowerCase() !== target);
  writeBlocklist(blocklist);
  res.json(blocklist);
});

let lastAutoRefreshAttempt = 0;

// Refreshes from GitHub once the hour is up (or a rate limit has reset), so the
// list stays current without a click. Reading the timestamp from the cache file
// means --watch restarts don't trigger extra fetches.
function autoRefreshIfDue() {
  const cache = readCache();
  const now = Date.now();
  if (nextRefreshAt(cache) > now || now - lastAutoRefreshAttempt < AUTO_REFRESH_RETRY_MS) {
    return;
  }
  lastAutoRefreshAttempt = now;
  refreshCache(cache).catch(() => {
    // refreshCache already logged the error; try again after the retry delay.
  });
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
  autoRefreshIfDue();
  setInterval(autoRefreshIfDue, AUTO_REFRESH_CHECK_MS);
}

module.exports = app;
