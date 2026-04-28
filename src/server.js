// ProTeen Nation — Backend Server
// Handles: API routes, admin panel, article scheduler

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const db = require('./database');
const { runMiningCycle } = require('./miner');
const { buildDailySchedule, getScheduleSummary, DAILY_SCHEDULE, getWebhookStatus } = require('./clipScheduler');
const { postScheduledSlot } = require('./poster');
const { runHealthCheck } = require('./monitor');
const { runDailyVideoPipeline, testPipeline } = require('./videoPipeline');
const { videoDB, scheduleDB } = require('./videoDatabase');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'proteen-admin';
const MINE_HOURS = parseInt(process.env.MINE_INTERVAL_HOURS) || 4;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Simple auth middleware for admin routes ────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized — invalid admin token' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API — used by the website to fetch approved articles
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/articles — all approved articles (optionally filter by topic)
app.get('/api/articles', (req, res) => {
  const { topic, limit } = req.query;
  const articles = db.getArticles({
    status: 'approved',
    topic: topic || undefined,
    limit: limit ? parseInt(limit) : undefined,
  });
  res.json({ articles, count: articles.length });
});

// GET /api/articles/:topic — approved articles for a specific topic
app.get('/api/articles/:topic', (req, res) => {
  const articles = db.getArticles({
    status: 'approved',
    topic: req.params.topic,
  });
  res.json({ articles, count: articles.length, topic: req.params.topic });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN API — password protected
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/api/queue — all pending articles awaiting review
app.get('/admin/api/queue', adminAuth, (req, res) => {
  const articles = db.getArticles({ status: 'pending' });
  res.json({ articles, count: articles.length });
});

// GET /admin/api/stats — dashboard stats
app.get('/admin/api/stats', adminAuth, (req, res) => {
  res.json(db.getStats());
});

// GET /admin/api/articles — all articles with any status
app.get('/admin/api/articles', adminAuth, (req, res) => {
  const { status, topic } = req.query;
  const articles = db.getArticles({
    status: status || undefined,
    topic: topic || undefined,
  });
  res.json({ articles, count: articles.length });
});

// POST /admin/api/approve/:id — approve an article
app.post('/admin/api/approve/:id', adminAuth, (req, res) => {
  const article = db.updateArticle(req.params.id, {
    status: 'approved',
    approvedAt: new Date().toISOString(),
  });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  console.log(`[Admin] Approved: ${article.title}`);
  res.json({ success: true, article });
});

// POST /admin/api/reject/:id — reject an article
app.post('/admin/api/reject/:id', adminAuth, (req, res) => {
  const article = db.updateArticle(req.params.id, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
  });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  console.log(`[Admin] Rejected: ${article.title}`);
  res.json({ success: true, article });
});

// GET /admin/approve/:id — one-click approve from email link
app.get('/admin/approve/:id', (req, res) => {
  const { token } = req.query;
  if (token !== ADMIN_PASSWORD) {
    return res.send('<h2>Unauthorized</h2>');
  }
  const article = db.updateArticle(req.params.id, {
    status: 'approved',
    approvedAt: new Date().toISOString(),
  });
  if (!article) return res.send('<h2>Article not found</h2>');
  res.send(`
    <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
      <div style="font-size:48px;margin-bottom:16px;">✅</div>
      <h2 style="color:#1D9E75;">Approved!</h2>
      <p style="color:#555;">"${article.title}"</p>
      <p style="color:#555;">This article is now live on the ProTeen Nation website.</p>
      <a href="/admin" style="color:#e8b84b;">← Back to Admin Dashboard</a>
    </body></html>
  `);
});

// GET /admin/reject/:id — one-click reject from email link
app.get('/admin/reject/:id', (req, res) => {
  const { token } = req.query;
  if (token !== ADMIN_PASSWORD) {
    return res.send('<h2>Unauthorized</h2>');
  }
  const article = db.updateArticle(req.params.id, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
  });
  if (!article) return res.send('<h2>Article not found</h2>');
  res.send(`
    <html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;">
      <div style="font-size:48px;margin-bottom:16px;">🗑️</div>
      <h2 style="color:#E24B4A;">Rejected</h2>
      <p style="color:#555;">"${article.title}"</p>
      <p style="color:#555;">This article has been removed from the queue.</p>
      <a href="/admin" style="color:#e8b84b;">← Back to Admin Dashboard</a>
    </body></html>
  `);
});

// POST /admin/api/mine — manually trigger a mining cycle
app.post('/admin/api/mine', adminAuth, async (req, res) => {
  console.log('[Admin] Manual mining cycle triggered');
  res.json({ message: 'Mining cycle started — check server logs for progress.' });
  // Run in background so response returns immediately
  runMiningCycle().catch(err => console.error('[Admin] Mining error:', err));
});

// POST /admin/api/settings — update posting mode
app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { mode, threshold } = req.body;
  if (mode) process.env.POSTING_MODE = mode;
  if (threshold) process.env.AUTO_POST_THRESHOLD = threshold;
  res.json({ success: true, mode: process.env.POSTING_MODE, threshold: process.env.AUTO_POST_THRESHOLD });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULE & CLIP API
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/api/schedule/today — today's posting schedule
app.get('/admin/api/schedule/today', adminAuth, (req, res) => {
  const schedule = scheduleDB.getToday();
  const stats = scheduleDB.getStats();
  res.json({ schedule: schedule?.schedule || [], stats, date: new Date().toISOString().split('T')[0] });
});

// GET /admin/api/schedule/template — the daily schedule template
app.get('/admin/api/schedule/template', adminAuth, (req, res) => {
  res.json({ schedule: DAILY_SCHEDULE });
});

// GET /admin/api/webhooks — check which social webhooks are configured
app.get('/admin/api/webhooks', adminAuth, (req, res) => {
  res.json({ webhooks: getWebhookStatus() });
});

// POST /admin/api/schedule/build — build today's schedule manually
app.post('/admin/api/schedule/build', adminAuth, async (req, res) => {
  res.json({ message: 'Building schedule in background...' });
  try {
    const todaysVideo = videoDB.getToday();
    const archive = videoDB.getArchive(30);
    const schedule = await buildDailySchedule(todaysVideo, archive);
    scheduleDB.saveSchedule(schedule);
    const summary = getScheduleSummary(schedule);
    console.log('[Admin] Schedule built:', summary);
  } catch (err) {
    console.error('[Admin] Schedule build failed:', err.message);
  }
});

// POST /admin/api/video — save today's video details + script
app.post('/admin/api/video', adminAuth, (req, res) => {
  const { id, title, script, durationSecs, videoUrl, date } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const video = videoDB.saveVideo({
    id: id || require('uuid').v4(),
    title, script, durationSecs: durationSecs || 150,
    videoUrl, date: date || new Date().toISOString().split('T')[0],
    clips: [], savedAt: new Date().toISOString(),
  });
  res.json({ success: true, video });
});

// GET /admin/api/videos — all videos in archive
app.get('/admin/api/videos', adminAuth, (req, res) => {
  res.json({ videos: videoDB.getAllVideos() });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD — served as HTML
// ═══════════════════════════════════════════════════════════════════════════
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ═══════════════════════════════════════════════════════════════════════════
// DAILY SCHEDULE BUILDER — runs at 5 AM every day to prep today's posts
// ═══════════════════════════════════════════════════════════════════════════
cron.schedule('0 5 * * *', async () => {
  console.log('[Scheduler] Building daily clip schedule...');
  try {
    const todaysVideo = videoDB.getToday();
    const archive = videoDB.getArchive(30);
    const schedule = await buildDailySchedule(todaysVideo, archive);
    scheduleDB.saveSchedule(schedule);
    console.log('[Scheduler] Daily schedule ready:', getScheduleSummary(schedule));
  } catch (err) {
    console.error('[Scheduler] Schedule build failed:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH MONITOR API
// ═══════════════════════════════════════════════════════════════════════════

// // Video pipeline routes
app.post('/admin/api/video/generate', adminAuth, async (req, res) => {
app.post('/admin/api/video/generate', adminAuth, async (req, res) => {
  res.json({ message: 'Video pipeline started.' });
  runDailyVideoPipeline().catch(err => console.error('[Admin] Pipeline error:', err.message));
});

app.post('/admin/api/video/test', adminAuth, async (req, res) => {
  res.json({ message: 'Pipeline test started.' });
  testPipeline().catch(err => console.error('[Admin] Test error:', err.message));
});

app.get('/api/video/today', (req, res) => {
  const { videoDB } = require('./videoDatabase');
  const video = videoDB.getToday();
  if (!video) return res.json({ video: null });
  res.json({ video: { id: video.id, title: video.title, topic: video.topic, date: video.date } });
});
  res.json({ message: 'Video pipeline started — check server logs for progress.' });
  runDailyVideoPipeline().catch(err => console.error('[Admin] Pipeline error:', err.message));
});

app.post('/admin/api/video/test', adminAuth, async (req, res) => {
  res.json({ message: 'Pipeline test started — check server logs.' });
  testPipeline().catch(err => console.error('[Admin] Test error:', err.message));
});

app.get('/api/video/today', (req, res) => {
  const { videoDB } = require('./videoDatabase');
  const video = videoDB.getToday();
  if (!video) return res.json({ video: null });
  res.json({ video: { id: video.id, title: video.title, subtitle: video.subtitle, topic: video.topic, topicName: video.topicName, date: video.date, durationSecs: video.durationSecs } });
});
GET /admin/api/health — run health check on demand
app.get('/admin/api/health', adminAuth, async (req, res) => {
 const { runDailyVideoPipeline, testPipeline } = require('./videoPipeline');
  const result = await
  ();
  res.json(result);
});

// Public lightweight ping endpoint (for uptime monitors like UptimeRobot)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProTeen Nation Backend', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULER — runs mining cycle on a timer
// ═══════════════════════════════════════════════════════════════════════════
function startScheduler() {
  // Convert hours to a cron expression: every N hours
  const cronExpression = `0 */${MINE_HOURS} * * *`;
  console.log(`[Scheduler] Mining scheduled every ${MINE_HOURS} hours (cron: ${cronExpression})`);

  cron.schedule(cronExpression, async () => {
    console.log('[Scheduler] Triggered mining cycle');
    try {
      const result = await runMiningCycle();
      console.log(`[Scheduler] Cycle complete:`, result);
    } catch (err) {
      console.error('[Scheduler] Mining cycle failed:', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║         ProTeen Nation Backend Server            ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${PORT}               ║
║  Admin:     http://localhost:${PORT}/admin          ║
║  API:       http://localhost:${PORT}/api/articles   ║
║  Mode:      ${(process.env.POSTING_MODE || 'review').padEnd(38)}║
║  Mine every:${String(MINE_HOURS + ' hours').padEnd(38)}║
╚══════════════════════════════════════════════════╝
  `);

  startScheduler();

  // Run an initial mining cycle 10 seconds after startup
  setTimeout(() => {
    console.log('[Server] Running initial mining cycle...');
    runMiningCycle().catch(err => console.error('Initial mine failed:', err.message));
  }, 10000);
});

module.exports = app;
