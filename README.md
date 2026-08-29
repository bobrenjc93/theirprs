# Their PRs

`theirprs` is a local review queue for pull requests that currently need your attention. It asks the GitHub CLI for review requests, filters out PRs that no longer need a response, and presents the remaining work grouped by repository.

## What Counts As "Needs My Review"

A PR is shown only when all of the following are true:

- Your review is requested
- The PR is open
- The PR author is someone else
- The PR is not a draft
- You have not already reviewed it with `APPROVED`
- You have not already reviewed it with `CHANGES_REQUESTED`

## UI Features

- Toggle between oldest-first and newest-first sorting
- Show or hide sleeping PRs
- Collapse repository groups
- Select multiple PRs, including shift-click range selection
- Sleep selected PRs for 7 days
- Wake sleeping PRs early
- Refresh data on demand

## Requirements

- Node.js
- GitHub CLI (`gh`)
- GitHub authentication through `gh auth login` or an existing session. Check with:

```sh
gh auth status
```

## Install

```sh
npm install
```

## Run

Watched development server:

```sh
npm start
```

This starts the app at `http://localhost:3000`.

If port `3000` is already in use:

```sh
PORT=3001 npm start
```

Single-run server without watch mode:

```sh
npm run start:once
```

## Sleep State

Sleeping PRs are stored in `sleep.json` in the repo root. The file is created on first write, and expired entries are removed automatically when the app reads sleep state.

## How It Fetches Data

The server combines a few GitHub CLI queries:

- `gh api user --jq .login` to identify the current viewer
- `gh search prs --review-requested=@me --state=open` for the base PR list
- `gh pr list --search review-requested:@me` per repository to enrich each PR with `reviewDecision`

## Development Notes

- `npm start` watches `server.js`, `public/`, and `sleep.json`
- Browser tabs do not auto-refresh, so refresh manually after frontend changes
