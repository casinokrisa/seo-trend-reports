# RSS Trend Reports (manual topic picker)

This repo collects items from a set of RSS / RSS.app JSON feeds and generates a single Markdown report you can skim to pick topics and write posts manually.

## What it does

- Fetches your configured feeds (RSS.app JSON and/or RSS/Atom).
- Normalizes items into a single list.
- For Reddit links, enriches each item with **score** and **comment count** via `https://www.reddit.com/api/info.json`.
- Generates:
  - `reports/report-YYYY-MM-DD.md`
  - `reports/latest_report_en.md`
  - `reports/latest_items.json` (normalized items)

## Requirements

- Node.js 18+ (Node 20 recommended)

## Setup

Edit `feeds.json` to add/remove feeds.

## Run

```bash
node scripts/generate-report.mjs
```

Optional environment variables:

- `REPORT_LANG=en` (default) or `ru`
- `REPORT_LOOKBACK_HOURS=36` (default 36)
- `REDDIT_MIN_COMMENTS=10` (default 10)
- `REDDIT_MIN_SCORE=50` (default 50)
- `REDDIT_COMMENT_WEIGHT=3` (default 3)
- `REDDIT_CONCURRENCY=4` (default 4)
- `MAX_ITEMS_PER_FEED=30` (default 30)

## Notes

- This repo **does not** auto-publish anything. It only generates reports.
- Reddit enrichment is best-effort; if Reddit rate-limits, the report still builds (with missing score/comments for some items).

