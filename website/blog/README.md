# Omnesis blog

The blog lives at `/blog/`. Articles are Markdown files in `posts/`; the builder
renders static HTML, updates the index and sitemap, and embeds reader-initiated
Giscus comments and reactions. There is no RSS feed.

## Write and publish

Use Node 24 or newer. From the repository root:

```sh
npm ci --prefix scripts/blog --ignore-scripts --no-audit --no-fund
```

Copy `posts/first-post.md` to a short, permanent filename such as
`posts/bounded-work-queues.md`. Edit its YAML metadata between the `---` lines:
`title`, `description`, `date` (`YYYY-MM-DD`), `author`, optional `tags`, and
`draft` (boolean). Write the article beneath it using Markdown. Use `##` for
section headings; the title supplies the page's `h1`. Code fences, lists,
tables, links, and images are supported. Raw HTML is displayed as text; links
must use HTTPS/HTTP, a site-relative `/path`, or a `#fragment`.

Keep `draft: true` while writing. To publish, set `draft: false` and choose a
date no later than today (UTC), then generate the pages:

```sh
node scripts/blog/build.mjs
node scripts/blog/build.mjs --check
```

Commit the Markdown, generated `website/blog/*.html`, and `website/sitemap.xml`
together. The privacy guard reviews public identifiers per file; when adding a
new generated page, add its path to the existing public support address entry in
`privacy/pii-allowlist.json` if the guard requests it. Merge through a pull request; the site workflow tests the builder,
checks generated output, and deploys on main. The template remains a draft.
Drafts and future-dated posts are absent from generated pages and the sitemap.
Source Markdown, configuration and this README are excluded from deployment by
`website/.assetsignore`; committed drafts are still visible in the public Git
repository. A future date does not schedule publication: regenerate and deploy
when ready.

The index sorts posts newest first, with an empty state before the first post.
The generator removes old generated pages when their source is deleted or made
a draft. It refuses to overwrite or remove hand-authored HTML in the blog.

## Comments and reactions

`giscus.json` identifies the public GitHub repository and its **Blog comments**
Discussion category (Announcements format). The Giscus GitHub app must have
access to this repository, and Discussions must be enabled.

Each post uses the exact term `blog/<filename-without-md>` with strict matching.
Keep the filename stable after publication: changing a title is safe, renaming
the file changes its URL and discussion identity. Giscus creates a discussion
when a reader first comments or reacts. Moderate comments in GitHub Discussions.

The widget only loads when the reader presses **Show comments & reactions**.
Reading comments needs no login; posting or reacting requires GitHub sign-in.
The widget follows the website theme and offers a retry plus a GitHub fallback
when it cannot load. See `/privacy` for the third-party data handling.

## Validation

The isolated builder tests run in the site workflow. Locally, run this suite:

```sh
npm run test:unit --prefix scripts/blog
```

Also run the repository's affected checks before handoff. Review the rendered
index and a temporary invented article in both themes and at mobile widths.
Do not publish invented articles under an author's name or use corpus data in
examples, screenshots, or drafts.
