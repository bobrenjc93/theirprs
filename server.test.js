const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { after, afterEach, before, beforeEach, describe, mock, test } = require("node:test");

const VIEWER = "bobrenjc93";
const REPO = "pytorch/pytorch";
let fixture;
let server;
let baseUrl;

function pr(number, overrides = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    repository: { nameWithOwner: REPO },
    url: `https://github.com/${REPO}/pull/${number}`,
    author: { login: "another-author" },
    isDraft: false,
    state: "open",
    labels: [],
    createdAt: "2026-09-14T12:00:00Z",
    updatedAt: "2026-09-15T13:57:04Z",
    ...overrides,
  };
}

function review(login, state = "CHANGES_REQUESTED", typename = "User") {
  return { author: login === null ? null : { login, __typename: typename }, state };
}

function opinionatedReviews(nodes, pageInfo = {}) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null, ...pageInfo } };
}

function detail(number, overrides = {}) {
  return {
    number,
    reviewDecision: "CHANGES_REQUESTED",
    reviewRequests: { nodes: [{ requestedReviewer: { login: VIEWER } }] },
    latestOpinionatedReviews: {
      nodes: [review(VIEWER)],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

async function fetchPRs(prs, detailsByRepo = {}, reviewPages = {}) {
  fixture.prs = prs;
  fixture.detailsByRepo = detailsByRepo;
  fixture.reviewPages = reviewPages;
  const response = await fetch(`${baseUrl}/api/prs`);
  assert.equal(response.status, 200);
  return response.json();
}

function ids(prs) {
  return prs.map((item) => `${item.repository.nameWithOwner}#${item.number}`);
}

describe("GET /api/prs", { concurrency: false }, () => {
  before(async () => {
    const readFileSync = fs.readFileSync;
    mock.method(fs, "readFileSync", function (file, ...args) {
      if (file === path.join(__dirname, "blocklist.json")) {
        return JSON.stringify(["blocked-author"]);
      }
      return readFileSync.call(this, file, ...args);
    });

    // Stub before loading server.js, which captures execFile when imported.
    mock.method(childProcess, "execFile", (command, args, options, callback) => {
      fixture.calls.push(args);
      queueMicrotask(() => {
        try {
          assert.equal(command, "gh");
          if (args[0] === "api" && args[1] === "user") {
            callback(null, `${VIEWER}\n`, "");
          } else if (args[0] === "search" && args[1] === "prs") {
            callback(null, JSON.stringify(fixture.prs), "");
          } else if (args[0] === "api" && args[1] === "graphql") {
            const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
            const repo = `${field("owner")}/${field("name")}`;
            const query = field("query");
            if (field("cursor") !== undefined) {
              const key = `${repo}#${field("number")}:${field("cursor")}`;
              assert.ok(Object.hasOwn(fixture.reviewPages, key), `Unexpected review page: ${key}`);
              const page = fixture.reviewPages[key];
              if (page instanceof Error) {
                callback(page, "", page.message);
              } else {
                callback(null, JSON.stringify({ data: { repository: {
                  pullRequest: { latestOpinionatedReviews: page },
                } } }), "");
              }
              return;
            }
            const repository = {};
            for (const item of fixture.detailsByRepo[repo] || []) {
              if (query.includes(`pr${item.number}:`)) {
                repository[`pr${item.number}`] = item;
              }
            }
            callback(null, JSON.stringify({ data: { repository } }), "");
          } else {
            throw new Error(`Unexpected gh command: ${args.join(" ")}`);
          }
        } catch (error) {
          fixture.errors.push(error);
          callback(error, "", error.message);
        }
      });
    });

    const app = require("./server");
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    fixture = { prs: [], detailsByRepo: {}, reviewPages: {}, calls: [], errors: [] };
  });

  afterEach(() => {
    assert.deepEqual(fixture.errors, []);
  });

  after(async () => {
    try {
      if (server) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    } finally {
      mock.restoreAll();
    }
  });

  test("shows a direct re-review request when the viewer is the sole blocker, even after a commented review", async () => {
    // GitHub's opinionated connection retains this changes request after the
    // viewer's later COMMENTED review; latestReviews can be empty on re-request.
    const result = await fetchPRs([pr(196150)], {
      [REPO]: [detail(196150, { latestReviews: { nodes: [] } })],
    });

    assert.deepEqual(ids(result), [`${REPO}#196150`]);
    const graphqlCall = fixture.calls.find((args) => args[0] === "api" && args[1] === "graphql");
    const query = graphqlCall.find((arg) => arg.startsWith("query="));
    assert.match(query, /pr196150:\s*pullRequest\(number:\s*196150\)/);
    assert.match(query, /latestOpinionatedReviews\s*\(/);
    assert.match(query, /pageInfo\s*\{[^}]*hasNextPage[^}]*endCursor[^}]*\}/);
    assert.match(query, /author\s*\{[^}]*__typename[^}]*\}/);
  });

  test("matches the requested viewer and blocking reviewer case-insensitively", async () => {
    const result = await fetchPRs([pr(1)], {
      [REPO]: [detail(1, {
        reviewRequests: { nodes: [{ requestedReviewer: { login: VIEWER.toUpperCase() } }] },
        latestOpinionatedReviews: {
          nodes: [review(VIEWER.toUpperCase()), review("pytorchgreenlight", "APPROVED", "Bot")],
          pageInfo: { hasNextPage: false },
        },
      })],
    });
    assert.deepEqual(ids(result), [`${REPO}#1`]);
  });

  test("keeps other reviewers' changes requests hidden despite a direct re-review request", async () => {
    const result = await fetchPRs([pr(1), pr(2)], {
      [REPO]: [
        detail(1, { latestOpinionatedReviews: {
          nodes: [review(VIEWER), review("other-reviewer")],
          pageInfo: { hasNextPage: false },
        } }),
        detail(2, { latestOpinionatedReviews: {
          nodes: [review("other-reviewer")],
          pageInfo: { hasNextPage: false },
        } }),
      ],
    });
    assert.deepEqual(result, []);
  });

  test("requires a current direct request to the viewer", async () => {
    const requests = [
      undefined,
      { nodes: [] },
      { nodes: [{ requestedReviewer: { login: "someone-else" } }] },
      { nodes: [{ requestedReviewer: { name: "review-team", slug: "review-team" } }] },
      { nodes: [{ requestedReviewer: null }] },
    ];
    const prs = requests.map((_, index) => pr(index + 1));
    const details = requests.map((reviewRequests, index) => detail(index + 1, { reviewRequests }));
    assert.deepEqual(await fetchPRs(prs, { [REPO]: details }), []);
  });

  test("keeps changes-requested PRs hidden when review information is incomplete or cannot identify every blocker", async () => {
    const opinionated = [
      undefined,
      { nodes: [review(VIEWER)] },
      { nodes: [review(VIEWER)], pageInfo: { hasNextPage: true } },
      { nodes: null, pageInfo: { hasNextPage: false } },
      { nodes: [review(VIEWER), null], pageInfo: { hasNextPage: false } },
      { nodes: [review(VIEWER), review(null)], pageInfo: { hasNextPage: false } },
      { nodes: [], pageInfo: { hasNextPage: false } },
      { nodes: [review(VIEWER, "COMMENTED")], pageInfo: { hasNextPage: false } },
    ];
    const prs = opinionated.map((_, index) => pr(index + 1));
    const details = opinionated.map((latestOpinionatedReviews, index) => detail(index + 1, { latestOpinionatedReviews }));
    assert.deepEqual(await fetchPRs(prs, { [REPO]: details }), []);
  });

  test("keeps Green Light and other bot-only approvals visible", async () => {
    const result = await fetchPRs([pr(197584), pr(2)], {
      [REPO]: [
        detail(197584, {
          reviewDecision: "APPROVED",
          latestOpinionatedReviews: opinionatedReviews([
            review("pytorchgreenlight", "APPROVED", "Bot"),
          ]),
        }),
        detail(2, {
          reviewDecision: "APPROVED",
          latestOpinionatedReviews: opinionatedReviews([
            review("automation", "APPROVED", "Bot"),
            review("another-bot", "APPROVED", "Bot"),
          ]),
        }),
      ],
    });
    assert.deepEqual(ids(result), [`${REPO}#197584`, `${REPO}#2`]);
  });

  test("hides another human's approval regardless of the aggregate review decision", async () => {
    const decisions = ["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED", ""];
    const prs = decisions.map((_, index) => pr(index + 1));
    const details = decisions.map((reviewDecision, index) => detail(index + 1, {
      reviewDecision,
      latestOpinionatedReviews: opinionatedReviews([
        review(VIEWER),
        review("pytorchgreenlight", "APPROVED", "Bot"),
        review("other-reviewer", "APPROVED"),
      ]),
    }));
    const result = await fetchPRs(prs, { [REPO]: details });
    assert.deepEqual(result, []);
  });

  test("keeps the viewer's own approval visible when requested again, case-insensitively", async () => {
    const logins = [VIEWER, VIEWER.toUpperCase()];
    const prs = logins.map((_, index) => pr(index + 1));
    const details = logins.map((login, index) => detail(index + 1, {
      reviewDecision: "APPROVED",
      latestOpinionatedReviews: opinionatedReviews([review(login, "APPROVED")]),
    }));
    assert.deepEqual(ids(await fetchPRs(prs, { [REPO]: details })), [`${REPO}#1`, `${REPO}#2`]);
  });

  test("does not infer human approval from unknown or deleted reviewers or incomplete data", async () => {
    const connections = [
      opinionatedReviews([review(null, "APPROVED")]),
      opinionatedReviews([{ author: { login: "unknown-reviewer" }, state: "APPROVED" }]),
      opinionatedReviews([{ author: { __typename: "User" }, state: "APPROVED" }]),
      opinionatedReviews([null]),
      opinionatedReviews(null),
      undefined,
    ];
    const prs = connections.map((_, index) => pr(index + 1));
    const details = connections.map((latestOpinionatedReviews, index) => detail(index + 1, {
      reviewDecision: "APPROVED", latestOpinionatedReviews,
    }));
    assert.deepEqual(ids(await fetchPRs(prs, { [REPO]: details })), ids(prs));
  });

  test("does not count dismissed approvals or comments as active human approvals", async () => {
    const states = ["DISMISSED", "COMMENTED"];
    const prs = states.map((_, index) => pr(index + 1));
    const details = states.map((state, index) => detail(index + 1, {
      reviewDecision: "REVIEW_REQUIRED",
      latestOpinionatedReviews: opinionatedReviews([review("other-reviewer", state)]),
      reviews: { nodes: [review("other-reviewer", "APPROVED")] },
    }));
    assert.deepEqual(ids(await fetchPRs(prs, { [REPO]: details })), ids(prs));
  });

  test("checks later review pages for human approval and keeps fully paginated bot-only PRs", async () => {
    const result = await fetchPRs([pr(1), pr(2)], {
      [REPO]: [1, 2].map((number) => detail(number, {
        reviewDecision: "APPROVED",
        latestOpinionatedReviews: opinionatedReviews([
          review("pytorchgreenlight", "APPROVED", "Bot"),
        ], { hasNextPage: true, endCursor: "first-page" }),
      })),
    }, {
      [`${REPO}#1:first-page`]: opinionatedReviews([review("other-reviewer", "APPROVED")]),
      [`${REPO}#2:first-page`]: opinionatedReviews([
        review("automation", "APPROVED", "Bot"),
      ], { hasNextPage: true, endCursor: "second-page" }),
      [`${REPO}#2:second-page`]: opinionatedReviews([
        review("another-bot", "APPROVED", "Bot"),
      ]),
    });
    assert.deepEqual(ids(result), [`${REPO}#2`]);
  });

  test("preserves known human approvals and blocker completeness when later review pages fail or are missing", async () => {
    const firstPages = [
      { reviewDecision: "APPROVED", reviews: [review("pytorchgreenlight", "APPROVED", "Bot")] },
      { reviewDecision: "APPROVED", reviews: [review("other-reviewer", "APPROVED")] },
      { reviewDecision: "CHANGES_REQUESTED", reviews: [review(VIEWER)] },
      { reviewDecision: "APPROVED", reviews: [review("pytorchgreenlight", "APPROVED", "Bot")] },
    ];
    const prs = firstPages.map((_, index) => pr(index + 1));
    const details = firstPages.map(({ reviewDecision, reviews }, index) => detail(index + 1, {
      reviewDecision,
      latestOpinionatedReviews: opinionatedReviews(reviews, {
        hasNextPage: true, endCursor: "first-page",
      }),
    }));
    const result = await fetchPRs(prs, { [REPO]: details }, {
      [`${REPO}#1:first-page`]: new Error("Review page unavailable"),
      [`${REPO}#2:first-page`]: new Error("Review page unavailable"),
      [`${REPO}#3:first-page`]: new Error("Review page unavailable"),
      [`${REPO}#4:first-page`]: null,
    });
    assert.deepEqual(ids(result), [`${REPO}#1`, `${REPO}#4`]);
  });

  test("keeps ordinary requested PRs visible without prior opinionated reviews", async () => {
    const result = await fetchPRs([pr(1), pr(2)], {
      [REPO]: [
        detail(1, { reviewDecision: "REVIEW_REQUIRED", latestOpinionatedReviews: undefined }),
        detail(2, { reviewDecision: "", latestOpinionatedReviews: undefined }),
      ],
    });
    assert.deepEqual(ids(result), [`${REPO}#1`, `${REPO}#2`]);
  });

  test("preserves draft, own-PR, missing-author, and blocked-author exclusions on re-review", async () => {
    const result = await fetchPRs([
      pr(1, { isDraft: true }),
      pr(2, { author: { login: VIEWER } }),
      pr(3, { author: null }),
      pr(4, { author: { login: "BLOCKED-AUTHOR" } }),
      pr(5),
    ], {
      [REPO]: [1, 2, 3, 4, 5].map((number) => detail(number)),
    });
    assert.deepEqual(ids(result), [`${REPO}#5`]);
  });

  test("looks up each discovered PR directly and keeps identical numbers in different repositories separate", async () => {
    const otherRepo = "another/project";
    const result = await fetchPRs([
      pr(42),
      pr(42, { repository: { nameWithOwner: otherRepo } }),
    ], {
      [REPO]: [detail(42)],
      [otherRepo]: [detail(42, {
        reviewDecision: "APPROVED",
        latestOpinionatedReviews: opinionatedReviews([review("other-reviewer", "APPROVED")]),
      })],
    });
    assert.deepEqual(ids(result), [`${REPO}#42`]);
    assert.equal(fixture.calls.filter((args) => args[0] === "api" && args[1] === "graphql").length, 2);
    assert.equal(fixture.calls.some((args) => args[0] === "pr" && args[1] === "list"), false);
  });
});
