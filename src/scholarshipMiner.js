// ProTeen Nation — Scholarship & Grant Miner
// Searches the web daily for new scholarship and grant opportunities for teens.
// Uses Tavily for discovery, Claude to extract structured data.

require('dotenv').config();
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const { scholarshipDB } = require('./scholarshipDatabase');

// Search queries — varied to catch scholarships, grants, and contests
const SEARCH_QUERIES = [
  'new scholarship 2026 high school students deadline apply',
  'college scholarship 2026 teens eligibility deadline',
  'grant opportunity high school students 2026',
  'scholarship for teenagers 2026 no essay',
  'merit scholarship 2026 high school junior senior',
  'scholarship contest teens youth 2026 cash prize',
  'minority scholarship 2026 high school student',
  'STEM scholarship 2026 high school',
  'arts scholarship 2026 teen student',
  'community service scholarship 2026 youth leadership',
  'first generation college scholarship 2026',
  'athletic scholarship opportunity 2026 high school',
];

// ── Step 1: Search Tavily ─────────────────────────────────────────────────
async function searchScholarships(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) { console.warn('[ScholarshipMiner] TAVILY_API_KEY not set'); return []; }

  try {
    const res = await axios.post('https://api.tavily.com/search', {
      api_key: apiKey,
      query,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
      max_results: 6,
      exclude_domains: ['reddit.com', 'twitter.com', 'x.com', 'tiktok.com', 'facebook.com'],
    }, { timeout: 15000 });
    return res.data.results || [];
  } catch (err) {
    console.error('[ScholarshipMiner] Tavily error:', err.message);
    return [];
  }
}

// ── Step 2: Claude extracts structured scholarship data ───────────────────
async function extractScholarship(result) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are a scholarship researcher helping teenagers find funding opportunities.

Analyze this web result and extract scholarship/grant details:

Title: ${result.title}
URL: ${result.url}
Content: ${(result.content || '').slice(0, 1200)}

Extract the details and return ONLY valid JSON in this exact format:
{
  "isScholarship": true,
  "name": "Full official name of the scholarship/grant",
  "provider": "Organization offering it",
  "type": "scholarship|grant|contest",
  "amount": "$X,XXX",
  "amountNum": 1000,
  "deadline": "Month DD, YYYY",
  "deadlineISO": "YYYY-MM-DD",
  "eligibility": "One sentence describing who can apply",
  "description": "2-3 sentence description of the opportunity",
  "url": "${result.url}",
  "topics": ["general"]
}

Rules:
- isScholarship should be true for scholarships, grants, fellowships, awards, contests, or any financial opportunity for students. Only set false if it's completely unrelated (e.g. a news article about someone who won a scholarship, not an opportunity to apply).
- type must be exactly "scholarship", "grant", or "contest"
- If deadline is unknown, use null for both deadline fields
- amountNum should be the numeric value (e.g. 5000 for $5,000), or 0 if unknown
- topics can include: stem, arts, sports, community, leadership, writing, general, minority, first-gen
- Keep description under 200 characters
- Keep eligibility under 150 characters`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);
    if (!parsed.isScholarship) return null;
    return parsed;
  } catch (err) {
    console.warn('[ScholarshipMiner] Extract failed for:', result.title, err.message);
    return null;
  }
}

// ── Main: run a full mining cycle ─────────────────────────────────────────
async function runScholarshipMiner() {
  console.log('[ScholarshipMiner] Starting scholarship mining cycle...');
  const today = new Date().toISOString().split('T')[0];

  // Pick 4 random queries per run (avoid hammering Tavily)
  const shuffled = SEARCH_QUERIES.sort(() => Math.random() - 0.5).slice(0, 4);

  let found = 0;
  let saved = 0;

  for (const query of shuffled) {
    console.log('[ScholarshipMiner] Searching:', query);
    const results = await searchScholarships(query);

    for (const result of results) {
      // Skip if URL already in DB
      const existing = scholarshipDB.getAll().find(s => s.url === result.url);
      if (existing) continue;

      found++;
      const data = await extractScholarship(result);
      if (!data) {
        console.log('[ScholarshipMiner] Skipped (not a scholarship):', result.title?.slice(0, 60));
        continue;
      }

      // Skip if deadline already passed
      if (data.deadlineISO && data.deadlineISO < today) {
        console.log('[ScholarshipMiner] Skipping expired:', data.name);
        continue;
      }

      const scholarship = {
        id:          uuidv4(),
        name:        data.name        || result.title,
        provider:    data.provider    || '',
        type:        data.type        || 'scholarship',
        amount:      data.amount      || 'Varies',
        amountNum:   data.amountNum   || 0,
        deadline:    data.deadline    || null,
        deadlineISO: data.deadlineISO || null,
        eligibility: data.eligibility || 'High school students',
        description: data.description || '',
        url:         data.url         || result.url,
        topics:      data.topics      || ['general'],
        status:      'active',
        foundAt:     new Date().toISOString(),
      };

      scholarshipDB.save(scholarship);
      saved++;
      console.log(`[ScholarshipMiner] ✅ Saved: ${scholarship.name} (${scholarship.amount})`);

      // Small delay to avoid Claude rate limits
      await new Promise(r => setTimeout(r, 800));
    }

    // Delay between Tavily searches
    await new Promise(r => setTimeout(r, 2000));
  }

  const stats = scholarshipDB.getStats();
  console.log(`[ScholarshipMiner] Done. Found ${found} new results, saved ${saved}. Total active: ${stats.active}`);
  return { found, saved, stats };
}

module.exports = { runScholarshipMiner };
