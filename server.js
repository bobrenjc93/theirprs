const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SLEEP_FILE = path.join(__dirname, "sleep.json");
const BLOCKLIST_FILE = path.join(__dirname, "blocklist.json");

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
    } catch {
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

app.get("/api/prs", async (req, res) => {
  try {
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
      } catch {
        for (const pr of repoPrs) {
          pr.reviewDecision = "";
          pr.hasOtherHumanApproval = false;
          pr.isReReviewRequested = false;
        }
      }
    }));

    const blocklist = new Set(readBlocklist().map((name) => name.toLowerCase()));

    const filtered = prs.filter((pr) => {
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

    res.json(filtered);
  } catch (e) {
    console.error("gh error:", e.message);
    if (e.stderr) {
      console.error(e.stderr);
    }
    res.status(500).json({ error: "Failed to fetch PRs" });
  }
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
