# Their PRs

`theirprs` is a small local dashboard for pull requests that need your review. It uses the GitHub CLI to find review requests, filters out work that no longer needs attention, and gives you a focused browser view grouped by repository.

## What It Shows

The app starts from open PRs where review is requested from `@me`, then filters out:

- PRs authored by you
- Draft PRs
- PRs you already marked as `APPROVED`
- PRs you already marked as `CHANGES_REQUESTED`

The remaining list is shown with repository grouping, author badges, labels, created/updated timestamps, and optional sleeping state.

## Workflow Features

- Groups PRs by repository with collapsible sections
- Switches between oldest-first and newest-first sorting
- Supports shift-click multi-select
- Sleeps one or more PRs for a week
- Wakes sleeping PRs individually
- Lets you reveal or hide the sleeping section

## Requirements

- Node.js
- GitHub CLI (`gh`)
- An authenticated GitHub session, usually via `gh auth login`

You can confirm the CLI is ready with:

```bash
gh auth status
```

## Getting Started

Install dependencies:

```bash
npm install
```

Start the watch mode server:

```bash
npm start
```

If port `3000` is already taken:

```bash
PORT=3001 npm start
```

Then open `http://localhost:3000` or the port you selected.

For a one-shot server without file watching:

```bash
npm run start:once
```

## How It Works

The backend in `server.js` serves the frontend from `public/` and exposes a small JSON API.

- `GET /api/prs` runs `gh search prs --review-requested=@me --state=open`
- The server looks up `reviewDecision` per repository
- The final result excludes your own PRs, drafts, and PRs you have already fully reviewed
- Sleep state is managed through the `/api/sleep` endpoints

## Local State And Dev Notes

- Sleeping PRs are stored in `sleep.json` in the repository root.
- `npm start` creates `sleep.json` automatically if it does not exist yet.
- The watch-mode server restarts when `server.js`, `public/`, or `sleep.json` changes.
- Browser tabs do not auto-refresh after frontend edits; reload manually.

## Troubleshooting

- If the UI shows `Failed to fetch PRs`, check `gh auth status` first.
- Sleeping PR state is local to this checkout because it is stored in `sleep.json`.
