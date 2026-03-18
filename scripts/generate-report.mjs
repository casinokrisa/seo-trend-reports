#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const FEEDS_PATH = path.join(ROOT, 'feeds.json')
const REPORTS_DIR = path.join(ROOT, 'reports')
const CACHE_DIR = path.join(ROOT, 'cache')

const REPORT_LANG = String(process.env.REPORT_LANG || 'en').toLowerCase() // en | ru
const LOOKBACK_HOURS = clampInt(process.env.REPORT_LOOKBACK_HOURS, 36, 1, 24 * 14)
const MAX_ITEMS_PER_FEED = clampInt(process.env.MAX_ITEMS_PER_FEED, 30, 1, 200)

const REDDIT_MIN_COMMENTS = clampInt(process.env.REDDIT_MIN_COMMENTS, 10, 0, 50000)
const REDDIT_MIN_SCORE = clampInt(process.env.REDDIT_MIN_SCORE, 50, 0, 500000)
const REDDIT_COMMENT_WEIGHT = clampInt(process.env.REDDIT_COMMENT_WEIGHT, 3, 0, 100)
const REDDIT_CONCURRENCY = clampInt(process.env.REDDIT_CONCURRENCY, 4, 1, 20)

function clampInt(v, fallback, min, max) {
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : fallback
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeFile(p, s) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, s, 'utf8')
}

function sha1(s) {
  // small stable cache keys
  let h = 0
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return String(h)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function nowYmdUtc() {
  return new Date().toISOString().slice(0, 10)
}

function toIso(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return undefined
  return d.toISOString()
}

function parseDateLoose(s) {
  const d = new Date(String(s || '').trim())
  return Number.isFinite(d.getTime()) ? d : undefined
}

function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeUrl(u) {
  const s = String(u || '').trim()
  if (!s) return ''
  try {
    const url = new URL(s)
    url.hash = ''
    ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'].forEach((k) =>
      url.searchParams.delete(k)
    )
    return url.toString()
  } catch {
    return s
  }
}

function extractRedditPostId(url) {
  const s = String(url || '')
  const m = s.match(/\/comments\/([a-z0-9]+)\//i)
  return m ? m[1] : ''
}

async function fetchTextWithCache(url) {
  ensureDir(CACHE_DIR)
  const key = path.join(CACHE_DIR, `${sha1(url)}.txt`)
  const freshMs = 1000 * 60 * 20 // 20 min
  try {
    const st = fs.statSync(key)
    if (Date.now() - st.mtimeMs < freshMs) return fs.readFileSync(key, 'utf8')
  } catch {
    // ignore
  }
  const res = await fetch(url, {
    headers: {
      'user-agent': 'rss-trend-reports/1.0',
      accept:
        'application/json,application/feed+json,application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.1',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const txt = await res.text()
  fs.writeFileSync(key, txt, 'utf8')
  return txt
}

function parseRssAppJson(text, feed) {
  const items = []
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return items
  }
  const rawItems = Array.isArray(json?.items) ? json.items : []
  for (const it of rawItems.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = stripTags(it?.title || '')
    const link = normalizeUrl(it?.url || it?.link || '')
    const pubDate = parseDateLoose(it?.date_published || it?.datePublished || it?.published || it?.updated)
    const excerpt = stripTags(it?.content_text || it?.contentText || it?.summary || '')
    if (!title || !link) continue
    items.push({
      kind: String(feed.kind || 'site'),
      feedId: String(feed.id || feed.label || ''),
      sourceLabel: String(feed.label || ''),
      url: link,
      title,
      publishedAt: toIso(pubDate),
      excerpt,
      weight: Number(feed.weight || 0),
    })
  }
  return items
}

function firstMatch(re, s) {
  const m = re.exec(s)
  return m ? m[1] : ''
}

function matchAll(re, s) {
  const out = []
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let m
  while ((m = r.exec(s))) out.push(m[1])
  return out
}

function parseRssOrAtom(xml, feed) {
  const trimmed = String(xml || '').trim()
  if (/^\s*\{/.test(trimmed) && trimmed.includes('"items"')) return parseRssAppJson(trimmed, feed)

  const items = []
  const looksAtom = /<feed\b[\s\S]*?>/i.test(xml) && /<entry\b/i.test(xml)
  if (looksAtom) {
    const blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []
    for (const b of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
      const title = stripTags(firstMatch(/<title\b[^>]*>([\s\S]*?)<\/title>/i, b))
      const updatedRaw =
        firstMatch(/<updated\b[^>]*>([\s\S]*?)<\/updated>/i, b) ||
        firstMatch(/<published\b[^>]*>([\s\S]*?)<\/published>/i, b)
      const linkRaw =
        firstMatch(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/i, b) ||
        stripTags(firstMatch(/<link\b[^>]*>([\s\S]*?)<\/link>/i, b))
      const link = normalizeUrl(linkRaw)
      const pubDate = parseDateLoose(updatedRaw)
      if (!title || !link) continue
      items.push({
        kind: String(feed.kind || 'site'),
        feedId: String(feed.id || feed.label || ''),
        sourceLabel: String(feed.label || ''),
        url: link,
        title,
        publishedAt: toIso(pubDate),
        excerpt: '',
        weight: Number(feed.weight || 0),
      })
    }
    return items
  }

  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || []
  for (const b of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = stripTags(firstMatch(/<title\b[^>]*>([\s\S]*?)<\/title>/i, b))
    const linkRaw = stripTags(firstMatch(/<link\b[^>]*>([\s\S]*?)<\/link>/i, b))
    const link = normalizeUrl(linkRaw)
    const pubDateRaw =
      firstMatch(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i, b) ||
      firstMatch(/<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i, b) ||
      firstMatch(/<published\b[^>]*>([\s\S]*?)<\/published>/i, b)
    const pubDate = parseDateLoose(pubDateRaw)
    const desc = stripTags(firstMatch(/<description\b[^>]*>([\s\S]*?)<\/description>/i, b))
    if (!title || !link) continue
    items.push({
      kind: String(feed.kind || 'site'),
      feedId: String(feed.id || feed.label || ''),
      sourceLabel: String(feed.label || ''),
      url: link,
      title,
      publishedAt: toIso(pubDate),
      excerpt: desc,
      weight: Number(feed.weight || 0),
    })
  }
  return items
}

async function fetchRedditMeta(url) {
  const id = extractRedditPostId(url)
  if (!id) return undefined
  const infoUrl = `https://www.reddit.com/api/info.json?id=t3_${id}&raw_json=1`
  const res = await fetch(infoUrl, {
    headers: { 'user-agent': 'rss-trend-reports/1.0', accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Reddit meta HTTP ${res.status}`)
  const json = await res.json()
  const data = json?.data?.children?.[0]?.data
  if (!data) return undefined
  return {
    subreddit: String(data.subreddit || ''),
    score: Number.isFinite(Number(data.score)) ? Number(data.score) : 0,
    comments: Number.isFinite(Number(data.num_comments)) ? Number(data.num_comments) : 0,
  }
}

function engagementScore(it) {
  const s = Number.isFinite(Number(it.redditScore)) ? Number(it.redditScore) : 0
  const c = Number.isFinite(Number(it.redditComments)) ? Number(it.redditComments) : 0
  return s + c * REDDIT_COMMENT_WEIGHT
}

function freshnessScore(publishedAtIso) {
  const d = publishedAtIso ? new Date(publishedAtIso) : undefined
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return 0
  const ageHours = (Date.now() - d.getTime()) / (1000 * 60 * 60)
  if (ageHours <= 6) return 80
  if (ageHours <= 24) return 60
  if (ageHours <= 72) return 40
  if (ageHours <= 7 * 24) return 25
  return 10
}

function sortKey(it) {
  if (it.kind === 'reddit') return 1000000 + engagementScore(it)
  return (Number(it.weight || 0) || 0) + freshnessScore(it.publishedAt)
}

function withinLookback(it) {
  if (!it.publishedAt) return true
  const d = new Date(it.publishedAt)
  if (!Number.isFinite(d.getTime())) return true
  const ageHours = (Date.now() - d.getTime()) / (1000 * 60 * 60)
  return ageHours <= LOOKBACK_HOURS
}

async function enrichRedditItems(items) {
  const redditItems = items.filter((x) => x.kind === 'reddit' && extractRedditPostId(x.url))
  if (!redditItems.length) return items

  const q = [...redditItems]
  let idx = 0
  const workers = Array.from({ length: REDDIT_CONCURRENCY }, async () => {
    while (idx < q.length) {
      const i = idx++
      const it = q[i]
      try {
        const meta = await fetchRedditMeta(it.url)
        if (meta) {
          it.subreddit = meta.subreddit
          it.redditScore = meta.score
          it.redditComments = meta.comments
        }
      } catch {
        // ignore; best-effort
      }
      // small jitter to be polite
      await sleep(120)
    }
  })
  await Promise.all(workers)
  return items
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}

function fmtUtc(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`
}

function renderReport({ ymd, items }) {
  const title = REPORT_LANG === 'ru' ? `RSS Trend Report — ${ymd}` : `RSS Trend Report — ${ymd}`
  const lookbackLine =
    REPORT_LANG === 'ru'
      ? `Lookback window: last ${LOOKBACK_HOURS} hours. Reddit is enriched with score/comments (best-effort).`
      : `Lookback window: last ${LOOKBACK_HOURS} hours. Reddit is enriched with score/comments (best-effort).`

  const today = items.filter(withinLookback)

  const redditToday = today
    .filter((x) => x.kind === 'reddit')
    .filter((x) => Number(x.redditComments || 0) >= REDDIT_MIN_COMMENTS || Number(x.redditScore || 0) >= REDDIT_MIN_SCORE)
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, 20)

  const sitesToday = today
    .filter((x) => x.kind !== 'reddit')
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, 30)

  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(lookbackLine)
  lines.push('')

  lines.push('## Today’s trending items (Reddit)')
  lines.push('')
  lines.push('| Title | Community | Score | Comments | Posted |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const it of redditToday) {
    const comm = it.subreddit ? `r/${it.subreddit}` : it.sourceLabel
    lines.push(
      `| [${mdEscape(it.title)}](${it.url}) | ${mdEscape(comm)} | ${Number(it.redditScore || 0)} | ${Number(it.redditComments || 0)} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!redditToday.length) {
    lines.push(`| _No Reddit items matched thresholds_ |  |  |  |  |`)
  }
  lines.push('')

  lines.push('## Today’s notable items (Sites)')
  lines.push('')
  lines.push('| Title | Source | Posted |')
  lines.push('|---|---|---:|')
  for (const it of sitesToday) {
    lines.push(`| [${mdEscape(it.title)}](${it.url}) | ${mdEscape(it.sourceLabel)} | ${mdEscape(fmtUtc(it.publishedAt))} |`)
  }
  if (!sitesToday.length) {
    lines.push(`| _No site items in lookback window_ |  |  |`)
  }
  lines.push('')

  lines.push('## Notes for manual writing')
  lines.push('')
  lines.push('- Prefer Reddit topics with **high comments** (discussion) over pure score (headline upvotes).')
  lines.push(`- Current filters: comments ≥ ${REDDIT_MIN_COMMENTS} OR score ≥ ${REDDIT_MIN_SCORE}. Ranking uses score + ${REDDIT_COMMENT_WEIGHT}×comments.`)
  lines.push('- For each picked topic: write an “interpretation” post (mechanism → checklist → what to measure).')
  lines.push('')

  return lines.join('\n')
}

async function main() {
  if (!fs.existsSync(FEEDS_PATH)) throw new Error(`Missing ${FEEDS_PATH}`)
  const cfg = readJson(FEEDS_PATH)
  const feeds = Array.isArray(cfg?.feeds) ? cfg.feeds : []
  if (!feeds.length) throw new Error('No feeds configured')

  ensureDir(REPORTS_DIR)

  const all = []
  for (const f of feeds) {
    const url = String(f?.url || '').trim()
    if (!url) continue
    const label = String(f?.label || url)
    const feed = { ...f, label }
    try {
      const txt = await fetchTextWithCache(url)
      const parsed = parseRssOrAtom(txt, feed)
      all.push(...parsed)
    } catch (e) {
      // keep going
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`Feed failed: ${label}: ${msg}\n`)
    }
  }

  // de-dupe by URL
  const byUrl = new Map()
  for (const it of all) {
    if (!it?.url) continue
    if (!byUrl.has(it.url)) byUrl.set(it.url, it)
  }
  const items = [...byUrl.values()]

  await enrichRedditItems(items)

  // Persist normalized items for debugging
  writeFile(path.join(REPORTS_DIR, 'latest_items.json'), JSON.stringify(items, null, 2))

  const ymd = nowYmdUtc()
  const report = renderReport({ ymd, items })
  const dailyPath = path.join(REPORTS_DIR, `report-${ymd}.md`)
  const latestPath = path.join(REPORTS_DIR, 'latest_report_en.md')
  writeFile(dailyPath, report)
  writeFile(latestPath, report)

  process.stdout.write(`Wrote:\n- ${dailyPath}\n- ${latestPath}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

