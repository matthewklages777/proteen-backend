// ProTeen Nation — Simple JSON Database
// Stores articles in a local JSON file.
// When you're ready to scale, this can be swapped for
// MongoDB, Supabase, or any real database with no other code changes.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/articles.json');

// Initialize database file if it doesn't exist
function init() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ articles: [] }, null, 2));
  }
}

function read() {
  init();
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { articles: [] };
  }
}

function write(data) {
  init();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

const db = {
  // Get all articles (optional filter by status/topic)
  getArticles({ status, topic, limit } = {}) {
    const { articles } = read();
    let results = articles;
    if (status) results = results.filter(a => a.status === status);
    if (topic) results = results.filter(a => a.topic === topic);
    results = results.sort((a, b) => new Date(b.minedAt) - new Date(a.minedAt));
    if (limit) results = results.slice(0, limit);
    return results;
  },

  // Add new articles to the queue
  addArticles(newArticles) {
    const data = read();
    const existingUrls = new Set(data.articles.map(a => a.url));
    const fresh = newArticles.filter(a => !existingUrls.has(a.url));
    data.articles = [...fresh, ...data.articles];
    // Keep max 500 articles to avoid file bloat
    if (data.articles.length > 500) {
      data.articles = data.articles.slice(0, 500);
    }
    write(data);
    return fresh.length;
  },

  // Update article status (pending → approved / rejected)
  updateArticle(id, updates) {
    const data = read();
    const idx = data.articles.findIndex(a => a.id === id);
    if (idx === -1) return null;
    data.articles[idx] = { ...data.articles[idx], ...updates, updatedAt: new Date().toISOString() };
    write(data);
    return data.articles[idx];
  },

  // Get single article by id
  getArticle(id) {
    const { articles } = read();
    return articles.find(a => a.id === id) || null;
  },

  // Stats for admin dashboard
  getStats() {
    const { articles } = read();
    return {
      total: articles.length,
      pending: articles.filter(a => a.status === 'pending').length,
      approved: articles.filter(a => a.status === 'approved').length,
      rejected: articles.filter(a => a.status === 'rejected').length,
      byTopic: Object.fromEntries(
        [...new Set(articles.map(a => a.topic))].map(t => [
          t,
          {
            total: articles.filter(a => a.topic === t).length,
            approved: articles.filter(a => a.topic === t && a.status === 'approved').length,
          },
        ])
      ),
    };
  },
};

module.exports = db;
