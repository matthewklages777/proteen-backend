// ProTeen Nation — Article Miner
// 1. Uses Tavily to search the web for relevant articles per topic
// 2. Uses Claude to score, summarize, and filter each article
// 3. Saves approved candidates to the review queue

require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const TOPICS = require('./topics');
const db = require('./database');
const { sendReviewEmail } = require('./mailer');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_PER_TOPIC = parseInt(process.env.MAX_ARTICLES_PER_TOPIC) || 3;
const POSTING_MODE = process.env.POSTING_MODE || 'review';
const AUTO_THRESHOLD = parseInt(process.env.AUTO_POST_THRESHOLD) || 85;

// ── Step 1: Search Tavily for articles on a topic ─────────────────────────
async function searchArticles(topic, query) {
  // If Tavily key not set yet, return mock data so the system still works
  if (!process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY === 'YOUR_TAVILY_KEY_HERE') {
    console.log(`[Miner] Tavily key not set — using placeholder data for topic: ${topic.id}`);
    return getMockArticles(topic);
  }

  try {
    const response = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
        max_results: 5,
        include_domains: [],
        exclude_domains: [
          // Exclude adult/inappropriate sites
          'reddit.com', 'twitter.com', 'x.com', 'tiktok.com',
        ],
      },
      { timeout: 15000 }
    );
    return response.data.results || [];
  } catch (err) {
    console.error(`[Miner] Tavily search failed for "${query}":`, err.message);
    return [];
  }
}

// ── Step 2: Claude scores and summarizes each article ─────────────────────
async function evaluateArticle(article, topicName) {
  const prompt = `You are a content moderator for ProTeen Nation, a positive platform for teenagers aged 13-19.

Evaluate this article for inclusion on the platform:

Title: ${article.title}
URL: ${article.url}
Content preview: ${article.content?.slice(0, 800) || 'No preview available'}

Topic category: ${topicName}

Respond with ONLY valid JSON in exactly this format:
{
  "score": <0-100 integer, how suitable for teens>,
  "type": "<one of: article | news | video | tip>",
  "teen_title": "<rewritten title in an engaging, teen-friendly way, max 12 words>",
  "excerpt": "<2-sentence summary written for a teen audience, max 40 words>",
  "appropriate": <true or false>,
  "reason": "<one sentence explaining the score>",
  "flags": []
}

Scoring guide:
- 90-100: Excellent — directly relevant, positive, age-appropriate, inspiring
- 75-89: Good — relevant and appropriate, post with confidence
- 60-74: Borderline — relevant but needs human review
- 0-59: Reject — inappropriate, irrelevant, political bias, adult content, or low quality

Set appropriate=false and score below 60 if the article contains:
- Adult content, violence, explicit language
- Strong political bias or divisive messaging
- Advertising disguised as content
- Anything that could harm teen wellbeing`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return json;
  } catch (err) {
    console.error('[Miner] Claude evaluation failed:', err.message);
    return null;
  }
}

// ── Step 3: Run a full mining cycle ───────────────────────────────────────
async function runMiningCycle() {
  console.log(`\n[Miner] Starting mining cycle at ${new Date().toLocaleString()}`);
  const newArticles = [];

  for (const topic of Object.values(TOPICS)) {
    console.log(`[Miner] Mining topic: ${topic.name}`);
    const topicArticles = [];

    // Search with multiple queries, stop when we have enough
    for (const query of topic.searchQueries) {
      if (topicArticles.length >= MAX_PER_TOPIC * 2) break;

      const results = await searchArticles(topic, query);
      for (const result of results) {
        if (topicArticles.length >= MAX_PER_TOPIC * 2) break;

        // Skip if already in database
        const existing = db.getArticles({ topic: topic.id });
        if (existing.some(a => a.url === result.url)) continue;

        // Evaluate with Claude
        const evaluation = await evaluateArticle(result, topic.name);
        if (!evaluation || !evaluation.appropriate || evaluation.score < 60) {
          console.log(`  ✗ Rejected (score ${evaluation?.score || '?'}): ${result.title?.slice(0, 60)}`);
          continue;
        }

        topicArticles.push({
          id: uuidv4(),
          topic: topic.id,
          topicName: topic.name,
          topicIcon: topic.icon,
          url: result.url,
          originalTitle: result.title,
          title: evaluation.teen_title,
          excerpt: evaluation.excerpt,
          type: evaluation.type || 'article',
          score: evaluation.score,
          reason: evaluation.reason,
          source: new URL(result.url).hostname.replace('www.', ''),
          // Auto-post if mode is 'auto' and score is high enough
          status: (POSTING_MODE === 'auto' && evaluation.score >= AUTO_THRESHOLD)
            ? 'approved'
            : 'pending',
          minedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        console.log(`  ✓ Queued (score ${evaluation.score}): ${evaluation.teen_title}`);
      }
    }

    newArticles.push(...topicArticles.slice(0, MAX_PER_TOPIC));

    // Small delay between topics to be respectful to APIs
    await new Promise(r => setTimeout(r, 1500));
  }

  // Save to database
  const added = db.addArticles(newArticles);
  console.log(`\n[Miner] Cycle complete. ${added} new articles added to queue.`);

  // Send review email if in review mode and we have pending articles
  const pending = newArticles.filter(a => a.status === 'pending');
  if (POSTING_MODE === 'review' && pending.length > 0) {
    await sendReviewEmail(pending);
  }

  return { added, pending: pending.length };
}

// ── Mock data when Tavily isn't connected yet ─────────────────────────────
function getMockArticles(topic) {
  return [
    {
      title: `Sample article for ${topic.name}`,
      url: `https://example.com/${topic.id}-article-${Date.now()}`,
      content: `This is placeholder content for the ${topic.name} topic. Once your Tavily API key is connected, real articles will appear here automatically.`,
    },
  ];
}

module.exports = { runMiningCycle };

// Run directly if called as a script: node src/miner.js
if (require.main === module) {
  runMiningCycle()
    .then(result => {
      console.log('Done:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Mining failed:', err);
      process.exit(1);
    });
}
