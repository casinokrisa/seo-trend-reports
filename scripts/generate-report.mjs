#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd())
const FEEDS_PATH = path.join(ROOT, 'feeds.json')
const REPORTS_DIR = path.join(ROOT, 'reports')
const CACHE_DIR = path.join(ROOT, 'cache')

const REPORT_LANG = String(process.env.REPORT_LANG || 'en').toLowerCase() // en | ru
const LOOKBACK_HOURS = clampInt(process.env.REPORT_LOOKBACK_HOURS, 36, 1, 24 * 14)
const WEEK_DAYS = clampInt(process.env.REPORT_WEEK_DAYS, 7, 1, 30)
const MAX_ITEMS_PER_FEED = clampInt(process.env.MAX_ITEMS_PER_FEED, 30, 1, 200)

const REDDIT_MIN_COMMENTS = clampInt(process.env.REDDIT_MIN_COMMENTS, 10, 0, 50000)
const REDDIT_MIN_SCORE = clampInt(process.env.REDDIT_MIN_SCORE, 50, 0, 500000)
const REDDIT_COMMENT_WEIGHT = clampInt(process.env.REDDIT_COMMENT_WEIGHT, 3, 0, 100)
const REDDIT_CONCURRENCY = clampInt(process.env.REDDIT_CONCURRENCY, 4, 1, 20)
const REDDIT_FALLBACK_ENABLED = String(process.env.REDDIT_FALLBACK_ENABLED || '1').toLowerCase() !== '0'
const REDDIT_FALLBACK_MIN_TODAY = clampInt(process.env.REDDIT_FALLBACK_MIN_TODAY, 6, 0, 50)
const REDDIT_FALLBACK_MIN_WEEK = clampInt(process.env.REDDIT_FALLBACK_MIN_WEEK, 12, 0, 200)
const REDDIT_META_RETRY_429 = clampInt(process.env.REDDIT_META_RETRY_429, 1, 0, 3)
const REDDIT_META_CACHE_HOURS = clampInt(process.env.REDDIT_META_CACHE_HOURS, 12, 1, 24 * 30)
const REDDIT_META_MAX_FETCH = clampInt(process.env.REDDIT_META_MAX_FETCH, 80, 0, 500)
const REDDIT_META_BACKOFF_MS = clampInt(process.env.REDDIT_META_BACKOFF_MS, 1200, 100, 30000)
const REDDIT_META_MODE = String(process.env.REDDIT_META_MODE || 'fetch').toLowerCase() // fetch | cache | off

const REDDIT_CLIENT_ID = String(process.env.REDDIT_CLIENT_ID || '').trim()
const REDDIT_CLIENT_SECRET = String(process.env.REDDIT_CLIENT_SECRET || '').trim()
const REDDIT_OAUTH_ENABLED = Boolean(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET)

let redditOauthToken = ''
let redditOauthExpiresAtMs = 0

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

function inferSubredditFromUrl(url) {
  const s = String(url || '')
  const m = s.match(/reddit\.com\/r\/([^/]+)/i)
  return m ? decodeURIComponent(m[1]) : ''
}

function redditMetaCachePath(id) {
  return path.join(CACHE_DIR, `reddit_meta_${id}.json`)
}

function readRedditMetaCache(id) {
  try {
    const p = redditMetaCachePath(id)
    const st = fs.statSync(p)
    const ageHours = (Date.now() - st.mtimeMs) / (1000 * 60 * 60)
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const meta = raw?.meta
    if (!meta) return undefined
    return {
      meta,
      fresh: ageHours <= REDDIT_META_CACHE_HOURS,
    }
  } catch {
    return undefined
  }
}

function writeRedditMetaCache(id, meta) {
  try {
    ensureDir(CACHE_DIR)
    fs.writeFileSync(redditMetaCachePath(id), JSON.stringify({ meta, savedAt: new Date().toISOString() }), 'utf8')
  } catch {
    // ignore cache failures
  }
}

function applyRedditMetaFromCache(items) {
  for (const it of items) {
    if (it.kind !== 'reddit') continue
    const id = extractRedditPostId(it.url)
    if (!id) continue
    const cached = readRedditMetaCache(id)
    if (!cached?.meta) continue
    it.redditMetaFetched = true
    it.subreddit = cached.meta.subreddit || it.subreddit
    it.redditScore = cached.meta.score
    it.redditComments = cached.meta.comments
  }
  return items
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

function parseRedditListingMeta(json) {
  const data = json?.data?.children?.[0]?.data
  if (!data) return undefined
  return {
    subreddit: String(data.subreddit || ''),
    score: Number.isFinite(Number(data.score)) ? Number(data.score) : 0,
    comments: Number.isFinite(Number(data.num_comments)) ? Number(data.num_comments) : 0,
  }
}

async function getRedditOauthToken() {
  if (!REDDIT_OAUTH_ENABLED) return ''
  if (redditOauthToken && Date.now() + 60_000 < redditOauthExpiresAtMs) return redditOauthToken

  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64')
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'rss-trend-reports/1.0 (oauth; github.com/casinokrisa/seo-trend-reports)',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Reddit OAuth HTTP ${res.status}`)
  const json = await res.json()
  const token = String(json?.access_token || '')
  const expiresIn = Number(json?.expires_in || 0)
  if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Reddit OAuth: invalid token response')

  redditOauthToken = token
  redditOauthExpiresAtMs = Date.now() + expiresIn * 1000
  return redditOauthToken
}

async function fetchJson(url, opts = {}) {
  const needsOauth = REDDIT_OAUTH_ENABLED && String(url).startsWith('https://oauth.reddit.com/')
  const headers = {
    'user-agent': 'rss-trend-reports/1.0 (trend-report; contact: github.com/casinokrisa/seo-trend-reports)',
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
  }

  if (needsOauth) {
    const token = await getRedditOauthToken()
    if (token) headers.authorization = `Bearer ${token}`
  }

  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}) },
  })
  return res
}

async function fetchRedditMetaViaInfo(id, cached) {
  // Prefer api.reddit.com when unauthenticated: it's generally more stable from CI runners than www.reddit.com JSON endpoints.
  const infoUrl = REDDIT_OAUTH_ENABLED
    ? `https://oauth.reddit.com/api/info?id=t3_${id}&raw_json=1`
    : `https://api.reddit.com/api/info/?id=t3_${id}&raw_json=1`
  for (let attempt = 0; attempt <= REDDIT_META_RETRY_429; attempt++) {
    const res = await fetchJson(infoUrl)
    if ((res.status === 429 || res.status === 503) && attempt < REDDIT_META_RETRY_429) {
      const backoff = REDDIT_META_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 500)
      await sleep(backoff)
      continue
    }
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) return cached?.meta
      if (res.status === 401 && REDDIT_OAUTH_ENABLED) {
        redditOauthToken = ''
        redditOauthExpiresAtMs = 0
        continue
      }
      throw new Error(`Reddit meta HTTP ${res.status}`)
    }
    const json = await res.json().catch(() => undefined)
    if (!json) return cached?.meta
    const meta = parseRedditListingMeta(json)
    if (!meta) return undefined
    return meta
  }
  return cached?.meta
}

async function fetchRedditMetaViaPermalink(url, id, cached) {
  // Permalink endpoint often behaves differently than api/info.json.
  // Example: https://www.reddit.com/r/SEO/comments/abc123/title.json?raw_json=1&limit=1
  const sub = inferSubredditFromUrl(url)
  const base = REDDIT_OAUTH_ENABLED ? 'https://oauth.reddit.com' : 'https://www.reddit.com'
  const permalinkUrl = sub
    ? `${base}/r/${encodeURIComponent(sub)}/comments/${id}.json?raw_json=1&limit=1`
    : `${base}/comments/${id}.json?raw_json=1&limit=1`

  for (let attempt = 0; attempt <= REDDIT_META_RETRY_429; attempt++) {
    const res = await fetchJson(permalinkUrl)
    if ((res.status === 429 || res.status === 503) && attempt < REDDIT_META_RETRY_429) {
      const backoff = REDDIT_META_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 500)
      await sleep(backoff)
      continue
    }
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) return cached?.meta
      if (res.status === 401 && REDDIT_OAUTH_ENABLED) {
        redditOauthToken = ''
        redditOauthExpiresAtMs = 0
        continue
      }
      throw new Error(`Reddit permalink meta HTTP ${res.status}`)
    }
    const json = await res.json().catch(() => undefined)
    if (!json) return cached?.meta
    const listing = Array.isArray(json) ? json[0] : undefined
    const meta = parseRedditListingMeta(listing)
    if (!meta) return undefined
    return meta
  }
  return cached?.meta
}

async function fetchRedditMeta(url) {
  const id = extractRedditPostId(url)
  if (!id) return undefined

  const cached = readRedditMetaCache(id)
  if (cached?.fresh) return cached.meta

  // CI runners often get challenged on www.reddit.com JSON; api.reddit.com is usually more stable.
  // So for unauthenticated mode, prefer api/info first.
  if (!REDDIT_OAUTH_ENABLED) {
    const metaInfo = await fetchRedditMetaViaInfo(id, cached)
    if (metaInfo) {
      writeRedditMetaCache(id, metaInfo)
      return metaInfo
    }
    const metaPermalink = await fetchRedditMetaViaPermalink(url, id, cached)
    if (metaPermalink) {
      writeRedditMetaCache(id, metaPermalink)
      return metaPermalink
    }
    return cached?.meta
  }

  // With OAuth enabled, permalink tends to be fine and keeps subreddit context.
  const meta1 = await fetchRedditMetaViaPermalink(url, id, cached)
  if (meta1) {
    writeRedditMetaCache(id, meta1)
    return meta1
  }
  const meta2 = await fetchRedditMetaViaInfo(id, cached)
  if (meta2) {
    writeRedditMetaCache(id, meta2)
    return meta2
  }
  return cached?.meta
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

function withinDays(it, days) {
  if (!it.publishedAt) return true
  const d = new Date(it.publishedAt)
  if (!Number.isFinite(d.getTime())) return true
  const ageHours = (Date.now() - d.getTime()) / (1000 * 60 * 60)
  return ageHours <= days * 24
}

async function enrichRedditItems(items) {
  if (REDDIT_META_MODE === 'off') return items

  // Only enrich items that can show up in daily/weekly windows.
  const candidates = items
    .filter((x) => x.kind === 'reddit' && extractRedditPostId(x.url))
    .filter((x) => withinDays(x, WEEK_DAYS) || withinLookback(x))
  const redditItems = candidates
  if (!redditItems.length) return items

  // Always apply cached meta first (no network).
  applyRedditMetaFromCache(items)
  if (REDDIT_META_MODE === 'cache') return items

  // Deduplicate by post id to reduce Reddit API calls
  const byId = new Map()
  for (const it of redditItems) {
    const id = extractRedditPostId(it.url)
    if (!id) continue
    if (!byId.has(id)) byId.set(id, it)
  }
  const q = [...byId.values()]
    .filter((it) => it.redditMetaFetched !== true) // fetch only missing
    .slice(0, REDDIT_META_MAX_FETCH)
  let idx = 0
  const workers = Array.from({ length: REDDIT_CONCURRENCY }, async () => {
    while (idx < q.length) {
      const i = idx++
      const it = q[i]
      try {
        const meta = await fetchRedditMeta(it.url)
        if (meta) {
          it.redditMetaFetched = true
          it.subreddit = meta.subreddit
          it.redditScore = meta.score
          it.redditComments = meta.comments
        }
      } catch {
        // ignore; best-effort
      }
      // small jitter to be polite
      await sleep(600 + Math.floor(Math.random() * 600))
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

function inferCategory(it) {
  const t = `${it.title || ''} ${it.excerpt || ''}`.toLowerCase()
  if (/(local seo|gmb|gbp|google business profile|map pack|maps)/.test(t)) return 'Local SEO'
  if (/(index|indexing|crawl|crawled|discovered|render|robots|sitemap)/.test(t)) return 'Indexing'
  if (/(backlink|links?|guest post|link building|anchor)/.test(t)) return 'Links'
  if (/(gsc|search console|inspection|coverage|impressions|clicks|ctr)/.test(t)) return 'GSC'
  if (/(ai|overview|ai mode|llm|chatgpt|gemini|copilot|citation|cited|aeo)/.test(t)) return 'AI Search'
  if (/(schema|structured data|json-ld|core web vitals|lcp|cls|inpx|technical)/.test(t)) return 'Technical SEO'
  if (/(content|rewrite|editorial|programmatic|pseo|templates?)/.test(t)) return 'Content'
  if (/(migration|https|redirect|301|410|canonical)/.test(t)) return 'Migration'
  return 'General'
}

function siteScore(it) {
  const weight = Number.isFinite(Number(it.weight)) ? Number(it.weight) : 0
  return weight + freshnessScore(it.publishedAt)
}

function ymdToFolder(ymd) {
  const [y, m, d] = String(ymd || '').split('-')
  if (!y || !m || !d) return { y: 'unknown', m: '00', d: '00' }
  return { y, m, d }
}

function ymdToCompact(ymd) {
  return String(ymd || '').replace(/-/g, '')
}

function redditOk(it) {
  return Number(it.redditComments || 0) >= REDDIT_MIN_COMMENTS || Number(it.redditScore || 0) >= REDDIT_MIN_SCORE
}

function sortReddit(a, b) {
  const sa = Number(a.redditScore || 0)
  const sb = Number(b.redditScore || 0)
  if (sa !== sb) return sb - sa
  const ca = Number(a.redditComments || 0)
  const cb = Number(b.redditComments || 0)
  if (ca !== cb) return cb - ca
  const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0
  const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0
  return tb - ta
}

function sortByPublishedDesc(a, b) {
  const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0
  const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0
  return tb - ta
}

function pickRedditWithFallback({ pool, minCount, maxCount }) {
  const known = pool.filter((x) => x.redditMetaFetched === true)
  const unknown = pool.filter((x) => x.redditMetaFetched !== true)

  const primary = known.filter(redditOk).sort(sortReddit)
  const out = primary.slice(0, maxCount)

  if (!REDDIT_FALLBACK_ENABLED) return out
  if (out.length >= Math.min(minCount, maxCount)) return out

  const need = Math.min(maxCount, minCount) - out.length
  if (need <= 0) return out

  const seen = new Set(out.map((x) => x.url))
  const supplement = unknown
    .slice()
    .sort(sortByPublishedDesc)
    .filter((x) => !seen.has(x.url))
    .slice(0, need)

  return out.concat(supplement)
}

function fmtNumOrDash(v) {
  return Number.isFinite(Number(v)) ? String(Number(v)) : '—'
}

function renderReport({ ymd, items }) {
  const title = REPORT_LANG === 'ru' ? `Reddit SEO Trend Report - ${ymd}` : `Reddit SEO Trend Report - ${ymd}`
  const lookbackLine =
    REPORT_LANG === 'ru'
      ? `Окно: последние ${LOOKBACK_HOURS} часов. Reddit: score/comments подтягиваются (best-effort).`
      : `Window: last ${LOOKBACK_HOURS} hours. Reddit is enriched with score/comments (best-effort).`

  const today = items.filter(withinLookback)

  const redditTodayPool = today.filter((x) => x.kind === 'reddit')
  const redditToday = pickRedditWithFallback({ pool: redditTodayPool, minCount: REDDIT_FALLBACK_MIN_TODAY, maxCount: 12 })

  const redditWeekPool = items.filter((x) => x.kind === 'reddit' && withinDays(x, WEEK_DAYS))
  const redditWeek = pickRedditWithFallback({ pool: redditWeekPool, minCount: REDDIT_FALLBACK_MIN_WEEK, maxCount: 25 })

  const sitesToday = today
    .filter((x) => x.kind !== 'reddit')
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, 20)

  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`## Today's Trending Posts`)
  lines.push('')
  lines.push(lookbackLine)
  lines.push('')

  lines.push('| Title | Community | Score | Comments | Category | Posted |')
  lines.push('|---|---|---:|---:|---|---:|')
  for (const it of redditToday) {
    const sub = it.subreddit ? String(it.subreddit) : inferSubredditFromUrl(it.url)
    const comm = sub ? `[r/${mdEscape(sub)}](https://www.reddit.com/r/${encodeURIComponent(sub)})` : mdEscape(it.sourceLabel)
    const score = it.redditMetaFetched === true ? fmtNumOrDash(it.redditScore) : '—'
    const comments = it.redditMetaFetched === true ? fmtNumOrDash(it.redditComments) : '—'
    lines.push(
      `| [${mdEscape(it.title)}](${it.url}) | ${comm} | ${score} | ${comments} | ${mdEscape(inferCategory(it))} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!redditToday.length) {
    lines.push(`| _No Reddit items matched thresholds_ |  |  |  |  |  |`)
  }
  lines.push('')

  lines.push('## Weekly Popular Posts')
  lines.push('')
  lines.push('| # | Title | Community | Score | Comments | Category | Posted |')
  lines.push('|---:|---|---|---:|---:|---|---:|')
  for (let i = 0; i < redditWeek.length; i++) {
    const it = redditWeek[i]
    const sub = it.subreddit ? String(it.subreddit) : inferSubredditFromUrl(it.url)
    const comm = sub ? `[r/${mdEscape(sub)}](https://www.reddit.com/r/${encodeURIComponent(sub)})` : mdEscape(it.sourceLabel)
    const score = it.redditMetaFetched === true ? fmtNumOrDash(it.redditScore) : '—'
    const comments = it.redditMetaFetched === true ? fmtNumOrDash(it.redditComments) : '—'
    lines.push(
      `| ${i + 1} | [${mdEscape(it.title)}](${it.url}) | ${comm} | ${score} | ${comments} | ${mdEscape(inferCategory(it))} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!redditWeek.length) {
    lines.push(`|  | _No Reddit items matched thresholds_ |  |  |  |  |  |`)
  }
  lines.push('')

  lines.push(`## Notable items (Sites)`)
  lines.push('')
  lines.push('| Title | Source | Score | Category | Posted |')
  lines.push('|---|---|---:|---|---:|')
  for (const it of sitesToday) {
    lines.push(
      `| [${mdEscape(it.title)}](${it.url}) | ${mdEscape(it.sourceLabel)} | ${siteScore(it)} | ${mdEscape(inferCategory(it))} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!sitesToday.length) {
    lines.push(`| _No site items in window_ |  |  |  |  |`)
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

function renderWeeklyReport({ ymd, items }) {
  const title = REPORT_LANG === 'ru' ? `SEO Weekly Trend Report - ${ymd}` : `SEO Weekly Trend Report - ${ymd}`
  const line =
    REPORT_LANG === 'ru'
      ? `Окно: последние ${WEEK_DAYS} дней. Reddit: score/comments подтягиваются (best-effort).`
      : `Window: last ${WEEK_DAYS} days. Reddit is enriched with score/comments (best-effort).`

  const week = items.filter((x) => withinDays(x, WEEK_DAYS))

  const redditWeekPool = week.filter((x) => x.kind === 'reddit')
  const redditWeek = pickRedditWithFallback({ pool: redditWeekPool, minCount: REDDIT_FALLBACK_MIN_WEEK, maxCount: 40 }).sort(
    (a, b) => sortKey(b) - sortKey(a)
  )

  const sitesWeek = week
    .filter((x) => x.kind !== 'reddit')
    .sort((a, b) => sortKey(b) - sortKey(a))
    .slice(0, 60)

  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push('## Weekly trending posts')
  lines.push('')
  lines.push(line)
  lines.push('')
  lines.push('| Title | Community | Score | Comments | Category | Posted |')
  lines.push('|---|---|---:|---:|---|---:|')
  for (const it of redditWeek) {
    const sub = it.subreddit ? String(it.subreddit) : inferSubredditFromUrl(it.url)
    const comm = sub ? `[r/${mdEscape(sub)}](https://www.reddit.com/r/${encodeURIComponent(sub)})` : mdEscape(it.sourceLabel)
    const score = it.redditMetaFetched === true ? fmtNumOrDash(it.redditScore) : '—'
    const comments = it.redditMetaFetched === true ? fmtNumOrDash(it.redditComments) : '—'
    lines.push(
      `| [${mdEscape(it.title)}](${it.url}) | ${comm} | ${score} | ${comments} | ${mdEscape(inferCategory(it))} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!redditWeek.length) lines.push(`| _No Reddit items matched thresholds_ |  |  |  |  |  |`)
  lines.push('')

  lines.push('## Weekly notable items (Sites)')
  lines.push('')
  lines.push('| Title | Source | Score | Category | Posted |')
  lines.push('|---|---|---:|---|---:|')
  for (const it of sitesWeek) {
    lines.push(
      `| [${mdEscape(it.title)}](${it.url}) | ${mdEscape(it.sourceLabel)} | ${siteScore(it)} | ${mdEscape(inferCategory(it))} | ${mdEscape(fmtUtc(it.publishedAt))} |`
    )
  }
  if (!sitesWeek.length) lines.push(`| _No site items in window_ |  |  |  |  |`)
  lines.push('')

  lines.push('## Notes')
  lines.push('')
  lines.push(`- Same filters as daily: comments ≥ ${REDDIT_MIN_COMMENTS} OR score ≥ ${REDDIT_MIN_SCORE}.`)
  lines.push(`- Ranking uses score + ${REDDIT_COMMENT_WEIGHT}×comments.`)
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
  const weekly = renderWeeklyReport({ ymd, items })
  const dailyPath = path.join(REPORTS_DIR, `report-${ymd}.md`)
  const latestPath = path.join(REPORTS_DIR, 'latest_report_en.md')
  const weeklyPath = path.join(REPORTS_DIR, `weekly-${ymd}.md`)
  const latestWeekly = path.join(REPORTS_DIR, 'latest_report_week_en.md')
  const { y, m, d } = ymdToFolder(ymd)
  const compact = ymdToCompact(ymd)
  const archiveDir = path.join(REPORTS_DIR, y, m, d)
  const archiveDaily = path.join(archiveDir, `report_${compact}_en.md`)
  const archiveWeekly = path.join(archiveDir, `weekly_${compact}_en.md`)
  writeFile(dailyPath, report)
  writeFile(latestPath, report)
  writeFile(weeklyPath, weekly)
  writeFile(latestWeekly, weekly)
  writeFile(archiveDaily, report)
  writeFile(archiveWeekly, weekly)

  process.stdout.write(
    `Wrote:\n- ${dailyPath}\n- ${latestPath}\n- ${weeklyPath}\n- ${latestWeekly}\n- ${archiveDaily}\n- ${archiveWeekly}\n`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

