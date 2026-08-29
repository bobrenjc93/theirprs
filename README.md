# theirprs

`theirprs` is a small local review queue for pull requests from other people that still need your attention. It uses the GitHub CLI (`gh`) to query GitHub, filters that data locally, and serves a simple browser UI.

## What It Shows

- Open pull requests with review requested from `@me`
- Only PRs authored by someone else
- No draft PRs
- No PRs where your review decision is already `APPROVED` or `CHANGES_REQUESTED`
- Results grouped by repository
- Temporary one-week "sleep" support for PRs you want to hide for now

## Requirements

- Node.js
- [GitHub CLI (`gh`)](https://cli.github.com/)
- GitHub authentication configured through `gh auth login`

## Install

```bash
npm install
```

## Run

Hot-reloading development server:

```bash
npm start
```

Use a different port:

```bash
PORT=3001 npm start
```

Run once without file watching:

```bash
npm run start:once
```

Open `http://localhost:3000` or the port you selected.

## How It Works

- The server reads your GitHub login with `gh api user --jq .login`.
- It fetches candidate PRs with `gh search prs --review-requested=@me --state=open`.
- It then queries each repository with `gh pr list --search review-requested:@me` to collect `reviewDecision` values and filter out PRs you have already fully reviewed.
- Sleeping state is stored locally in `sleep.json`, and expired entries are removed automatically.

## Notes

- `npm start` uses Node's `--watch` mode for `server.js`, `public/`, and `sleep.json`.
- Browser tabs do not auto-refresh after frontend changes; refresh manually.
- If the UI cannot load data, run `gh auth status` and confirm the authenticated account can read the relevant repositories.
- Delete `sleep.json` if you want to clear all sleeping PRs.
