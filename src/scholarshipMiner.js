// ProTeen Nation — Scholarship & Grant Miner (No-API version)
// Free sources: Google News RSS + DuckDuckGo HTML search + direct scholarship pages
// No Tavily or other paid APIs needed.

require('dotenv').config();
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { scholarshipDB } = require('./scholarshipDatabase');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Source 1: Google News RSS (free, no key) ──────────────────────────────
const RSS_QUERIES = [
  'scholarship 2026 high school students apply deadline',
  'new scholarship grant teen students 2026',
  'college scholarship opportunity 2026 eligibility',
  'youth scholarship contest 2026 award',
  'STEM scholarship high school 2026',
  'scholarship essay contest teenagers 2026',
];

async function fetchGoogleNewsRSS(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(res.data)) !== null) {
      const block = match[1];
      const title = extractXml(block, 'title');
      const link  = extractXml(block, 'link') || extractAttr(block, 'guid');
      const desc  = extractXml(block, 'description');
      if (title && link) items.push({ title: stripHtml(title), url: link.trim(), content: stripHtml(desc || '') });
    }
    console.log(`[ScholarshipMiner] RSS "${query.slice(0,40)}..." → ${items.length} items`);
    return items.slice(0, 8);
  } catch (err) {
    console.warn('[ScholarshipMiner] RSS failed:', err.message);
    return [];
  }
}

// ── Source 2: DuckDuckGo HTML search (free, no key) ───────────────────────
const DDG_QUERIES = [
  'site:scholarships.com OR site:fastweb.com OR site:bold.org scholarship high school 2026',
  'site:goingmerry.com OR site:cappex.com scholarship 2026 apply',
  '"apply now" scholarship "$" high school students 2026 deadline',
  'scholarship grant competition "open to" "high school" 2026',
];

async function fetchDuckDuckGo(query) {
  try {
    const res = await axios.post(
      'https://html.duckduckgo.com/html/',
      `q=${encodeURIComponent(query)}&kl=us-en`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT }, timeout: 15000 }
    );
    const html = res.data;
    const results = [];
    // Extract result blocks
    const blockRe = /class="result results_links[^"]*"([\s\S]*?)(?=class="result results_links|$)/g;
    const linkRe  = /<a[^>]+href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/;
    const snippRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;
    let bm;
    while ((bm = blockRe.exec(html)) !== null && results.length < 8) {
      const block = bm[1];
      const lm = linkRe.exec(block);
      const sm = snippRe.exec(block);
      if (lm) {
        const url = decodeURIComponent(lm[1].replace('/l/?uddg=', '').split('&')[0]).replace('//duckduckgo.com/l/?uddg=','');
        const title = stripHtml(lm[2]);
        const snippet = sm ? stripHtml(sm[1]) : '';
        if (url.startsWith('http') && title) results.push({ title, url, content: snippet });
      }
    }
    console.log(`[ScholarshipMiner] DDG "${query.slice(0,40)}..." → ${results.length} items`);
    return results;
  } catch (err) {
    console.warn('[ScholarshipMiner] DDG failed:', err.message);
    return [];
  }
}

// ── Source 3: Known scholarship listing pages ─────────────────────────────
const DIRECT_PAGES = [
  { url: 'https://www.scholarships.com/financial-aid/college-scholarships/scholarships-by-type/scholarships-for-high-school-students/', label: 'Scholarships.com HS' },
  { url: 'https://bold.org/scholarships/?filter=high-school', label: 'Bold.org HS' },
  { url: 'https://www.goingmerry.com/scholarships/high-school-scholarships', label: 'GoingMerry HS' },
  { url: 'https://www.niche.com/colleges/scholarships/', label: 'Niche Scholarships' },
  { url: 'https://studentscholarships.org/scholarships_for_high_school_students.php', label: 'StudentScholarships.org' },
];

async function fetchDirectPage(source) {
  try {
    const res = await axios.get(source.url, {
      timeout: 20000,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
    });
    // Strip scripts/styles, keep visible text
    const clean = res.data
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .slice(0, 6000); // First 6000 chars is plenty
    console.log(`[ScholarshipMiner] Direct page "${source.label}" → ${clean.length} chars`);
    return [{ title: source.label, url: source.url, content: clean }];
  } catch (err) {
    console.warn(`[ScholarshipMiner] Direct page failed (${source.label}):`, err.message);
    return [];
  }
}

// ── Claude extraction ─────────────────────────────────────────────────────
async function extractScholarships(results) {
  if (!results.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Batch up to 5 results into one Claude call for efficiency
  const batch = results.slice(0, 5);
  const itemText = batch.map((r, i) =>
    `--- Item ${i+1} ---\nTitle: ${r.title}\nURL: ${r.url}\nContent: ${r.content.slice(0, 600)}`
  ).join('\n\n');

  const prompt = `You are a scholarship researcher for ProTeen Nation, a platform for teenagers.

Analyze these web results and extract any scholarship, grant, fellowship, award, or contest opportunities that high school students can apply for.

${itemText}

For EACH real scholarship/grant/contest opportunity found, return a JSON object. Return ONLY a JSON array (may be empty [] if none found):
[
  {
    "name": "Full official scholarship name",
    "provider": "Organization offering it",
    "type": "scholarship",
    "amount": "$5,000",
    "amountNum": 5000,
    "deadline": "June 15, 2026",
    "deadlineISO": "2026-06-15",
    "eligibility": "High school students, GPA 3.0+",
    "description": "Brief description under 180 chars",
    "url": "direct application or info URL",
    "topics": ["general"]
  }
]

Rules:
- Only include opportunities students can actually apply for (not just news about past winners)
- type must be "scholarship", "grant", or "contest"
- If amount unknown use "Varies" and amountNum 0
- If deadline unknown use null for both deadline fields
- topics options: stem, arts, sports, community, leadership, writing, general, minority, first-gen, faith
- If a page lists multiple scholarships, include each one as a separate item
- Keep eligibility under 150 chars, description under 180 chars
- URL should be the most direct link to apply or learn more`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[ScholarshipMiner] Extraction failed:', err.message);
    return [];
  }
}

// ── Helper utilities ──────────────────────────────────────────────────────
function extractXml(text, tag) {
  const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = cdataRe.exec(text) || plainRe.exec(text);
  return m ? m[1] : '';
}
function extractAttr(text, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(text);
  return m ? m[1] : '';
}
function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
}

// ── Main mining cycle ─────────────────────────────────────────────────────
async function runScholarshipMiner() {
  console.log('[ScholarshipMiner] Starting free-source scholarship mining...');
  const today = new Date().toISOString().split('T')[0];
  const existingUrls = new Set(scholarshipDB.getAll().map(s => s.url));

  let totalSaved = 0;

  // Pick 2 random RSS queries, 1 DDG query, and 2 direct pages per run
  const rssQueries  = RSS_QUERIES.sort(() => Math.random() - 0.5).slice(0, 2);
  const ddgQueries  = DDG_QUERIES.sort(() => Math.random() - 0.5).slice(0, 1);
  const directPages = DIRECT_PAGES.sort(() => Math.random() - 0.5).slice(0, 2);

  // Gather all raw results
  const allResults = [];
  for (const q of rssQueries) {
    allResults.push(...await fetchGoogleNewsRSS(q));
    await delay(1500);
  }
  for (const q of ddgQueries) {
    allResults.push(...await fetchDuckDuckGo(q));
    await delay(1500);
  }
  for (const p of directPages) {
    allResults.push(...await fetchDirectPage(p));
    await delay(1000);
  }

  // Deduplicate raw results by URL
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (!r.url || seen.has(r.url) || existingUrls.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  console.log(`[ScholarshipMiner] ${unique.length} unique results to process`);

  // Process in batches of 5
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const extracted = await extractScholarships(batch);
    console.log(`[ScholarshipMiner] Batch ${Math.floor(i/5)+1}: extracted ${extracted.length} scholarships`);

    for (const data of extracted) {
      if (!data.name || !data.url) continue;
      // Skip expired
      if (data.deadlineISO && data.deadlineISO < today) continue;
      // Skip already saved
      if (existingUrls.has(data.url)) continue;

      const scholarship = {
        id:          uuidv4(),
        name:        data.name,
        provider:    data.provider    || '',
        type:        data.type        || 'scholarship',
        amount:      data.amount      || 'Varies',
        amountNum:   data.amountNum   || 0,
        deadline:    data.deadline    || null,
        deadlineISO: data.deadlineISO || null,
        eligibility: data.eligibility || 'High school students',
        description: data.description || '',
        url:         data.url,
        topics:      data.topics      || ['general'],
        status:      'active',
        foundAt:     new Date().toISOString(),
      };

      scholarshipDB.save(scholarship);
      existingUrls.add(data.url);
      totalSaved++;
      console.log(`[ScholarshipMiner] ✅ ${scholarship.amount} — ${scholarship.name.slice(0, 55)}`);
    }

    await delay(1200);
  }

  const stats = scholarshipDB.getStats();
  console.log(`[ScholarshipMiner] Done. Saved ${totalSaved} new scholarships. Total active: ${stats.active}`);
  return { saved: totalSaved, stats };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runScholarshipMiner };
