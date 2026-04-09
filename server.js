const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SLEEP_FILE = path.join(__dirname, "sleep.json");

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
        const details = await execGhJson([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--search",
          "review-requested:@me",
          "--limit",
          "200",
          "--json",
          "number,reviewDecision",
        ]);

        const reviewDecisionByNumber = new Map(
          details.map((detail) => [detail.number, detail.reviewDecision || ""])
        );

        for (const pr of repoPrs) {
          pr.reviewDecision = reviewDecisionByNumber.get(pr.number) || "";
        }
      } catch {
        for (const pr of repoPrs) {
          pr.reviewDecision = "";
        }
      }
    }));

    const filtered = prs.filter((pr) => {
      if (!pr.author || pr.author.login === viewerLogin || pr.isDraft) {
        return false;
      }

      return pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== "CHANGES_REQUESTED";
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
