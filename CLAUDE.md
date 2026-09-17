# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## What this repository is

This is a **GitHub Pages site** for `scottativolve` (repo name
`scottativolve.github.io`). Its sole job is to serve a custom-domain landing
page that **immediately redirects visitors to the iVolve learning portal**.

- **Custom domain:** `learn.ivolve.care` (configured via `CNAME`)
- **Redirect target:** `https://ivolve.csod.com/` (Cornerstone OnDemand /
  CSOD learning management system)

There is no application code, build step, or test suite. The site is plain
static files served directly by GitHub Pages.

## File layout

| File              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `index.html`      | The entire site — a meta-refresh redirect to the CSOD learning portal.  |
| `CNAME`           | Custom domain for GitHub Pages: `learn.ivolve.care`.                    |
| `_config.yml`     | Jekyll config; selects the `jekyll-theme-cayman` theme.                |
| `Nourish-icon.jpg`| Image asset (not currently referenced by `index.html`).                |
| `CLAUDE.md`       | This file.                                                              |

### `index.html`

The redirect is done with an HTTP-equiv meta refresh at `content="0"`
(immediate) plus a canonical link, both pointing at
`https://ivolve.csod.com/`. To change where the site redirects, edit **both**
the `<meta http-equiv="refresh">` URL and the `<link rel="canonical">` URL so
they stay in sync.

## How it's published

GitHub Pages builds and deploys automatically:

1. Push to the default branch (`main`) — that is what GitHub Pages serves.
2. GitHub runs the Jekyll build (because `_config.yml` is present) and deploys
   the result.
3. The live site is reachable at `https://learn.ivolve.care` (and at
   `https://scottativolve.github.io`).

There is no CI workflow in this repo; deployment is handled entirely by
GitHub's built-in Pages pipeline. Nothing needs to be built or run locally for
a change to go live — committing to the published branch is the deploy.

## Working conventions

- **Keep it minimal.** This is intentionally a near-empty redirect site. Do not
  add frameworks, dependencies, or build tooling unless explicitly asked.
- **Static HTML only.** No JavaScript build, no package manager, no `node_modules`.
- **Don't touch `CNAME`** unless the intent is to change the custom domain —
  altering it can take the live domain offline.
- **Keep redirect URLs in sync** between the meta refresh and the canonical
  link in `index.html`.
- If you want to preview locally, you can serve the folder with any static
  server, or run Jekyll (`bundle exec jekyll serve`) to match the GitHub Pages
  theme rendering — but for a meta-refresh page this is rarely necessary.

## Git / branch workflow

- The published branch is `main`.
- Make changes on a feature branch and open a PR rather than pushing directly
  to `main`, unless told otherwise.
- Do not create a pull request unless explicitly asked.
