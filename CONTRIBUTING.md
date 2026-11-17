# How we work

These rules apply across every Telonyte product and every repo in the NYTEcloud GitHub org (https://github.com/NYTEcloud), including this one. People and bots follow the same process so no one overwrites anyone else's work.

## Lanes

Work is split into two lanes.

- **Design** is owned by Romina Chale (romina@telonyte.com, GitHub @romina-ch) and the Grok bots she uses. This lane covers UI, styling, layout, visual components, and the look of copy.
- **Functionality and features** are owned by Kyle and his bots (Emperor Lightbraker and the team bots). This lane covers APIs, data, auth, agents, scans, logic, and new feature behavior.

If a change crosses into the other lane, ask that lane's owner for a review on the pull request before it is merged.

## Branches

Never push to `main` (or to this repo's default branch, if it is not `main`). Everyone, including every bot, works on their own branch and opens a pull request.

Name branches with a prefix that shows who made them:

- `romina/` for Romina
- `kyle/` for Kyle
- `lightbraker/` for Emperor Lightbraker
- `<botname>/` for any other bot, for example `obi-wan/`, `vader/`, `sally/`, `mando/`, `k-2so/`, `basement/`, `warframe/`, or `voroluxe/`

Do not reuse someone else's prefix.

## Pull requests and tests

A pull request is required for every change. Tests must pass before the pull request is merged. Nothing reaches the default branch until they do.

When Romina asks a bot for something, the pull request must say `requested by Romina`. When Kyle asks, say `requested by Kyle`.

## Claim work before you start

Before you start a job:

1. Claim it in a GitHub issue. Set the assignee and add a lane label (`lane:design`, `lane:functionality`, or `lane:feature`).
2. Log it in B.R.A.I.N. with `brain add` so other bots can see it.

Check B.R.A.I.N. first so two bots do not grab the same job, whether the request came from Kyle or from Romina.

## Deploys

Only Emperor Lightbraker deploys.

- Staging deploys from `main` (or from this repo's default branch, if it is not `main`).
- Production deploys only with Kyle's yes.

A feature branch cannot go live on its own.
