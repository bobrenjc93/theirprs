# theirprs

Small local app for reviewing GitHub pull requests that need your attention.

It shows open PRs where:

- review is requested from `@me`
- the PR author is someone else
- the PR is not a draft
- your review is not already `APPROVED`
- your review is not already `CHANGES_REQUESTED`

The UI groups PRs by repository and lets you temporarily "sleep" PRs for a week.

## Requirements

- Node.js
- `gh` CLI
- GitHub authentication via `gh auth login`

## Install

```bash
npm install
```

## Run

Hot-reloading dev server:

```bash
npm start
```

If port `3000` is already in use:

```bash
PORT=3001 npm start
```

Open the app in your browser at `http://localhost:3000` or the port you chose.

For a one-shot server without file watching:

```bash
npm run start:once
```

## Notes

- The server restarts automatically when `server.js`, files under `public/`, or `sleep.json` change.
- Browser tabs do not auto-refresh; refresh manually after frontend edits.
- Sleeping PRs are stored locally in `sleep.json`.
