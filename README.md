# theirprs

`theirprs` is a local review queue for pull requests that need your attention.

It is built for the case where you want to focus on review work from other people without manually filtering GitHub notifications, inbox views, or the web PR list.

## Features

- Groups review requests by repository
- Shows the PR author on each item
- Sorts by oldest first or newest first
- Lets you sleep PRs for a week to temporarily hide them
- Supports wake-up for individual sleeping PRs
- Supports shift-click multi-select for bulk sleep actions
- Shows sleeping PRs on demand
- Stores sleeping state locally in `sleep.json`
- Includes a watch-mode dev server for quick local iteration

## Requirements

- Node.js
- GitHub CLI (`gh`)
- A GitHub CLI session authenticated as the reviewer whose queue you want to see

Check your current login with:

```sh
gh auth status
```

## Install

```sh
npm install
```

## Run

Start the watch-mode development server:

```sh
npm start
```

By default the app listens on <http://localhost:3000>.

If that port is already in use, choose a different one:

```sh
PORT=3001 npm start
```

To run without file watching:

```sh
npm run start:once
```

## Using The Dashboard

- Click a repository header to collapse or expand that group
- Use `Oldest first` to flip the sort direction
- Use `Sleeping` to reveal items you have snoozed
- Select one or more PRs, then use `Sleep 1 week` in the action bar
- Hold `Shift` while selecting to bulk-select a contiguous range
- Use `Refresh` to re-run the GitHub queries

## Notes

The server watches `server.js`, `public/`, and `sleep.json` when you run `npm start`. Browser tabs do not auto-refresh, so after frontend edits you still need to reload the page manually.

Sleeping state is purely local. Deleting `sleep.json` resets all snoozed items.

## How It Works

The backend uses the GitHub CLI to:

- find open PRs where review is requested from `@me`
- resolve your current GitHub login
- fetch per-repository review decision data
- remove PRs that are already handled or not actionable

This keeps the view centered on outstanding review work rather than every PR you can see.

## Troubleshooting

- If the list is unexpectedly empty, confirm you are logged into the intended GitHub account with `gh auth status`
- If the server fails to load data, make sure `gh` is installed and available in the same shell that launches the app
- If watch mode is noisy or unnecessary for your use case, use `npm run start:once`
