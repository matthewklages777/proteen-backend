require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const db = require('./database');
const { runMiningCycle } = require('./miner');
const { buildDailySchedule, getScheduleSummary, DAILY_SCHEDULE, getWebhookStatus } = require('./clipScheduler');
const { postScheduledSlot } = require('./poster');
const { videoDB, scheduleDB } = require('./videoDatabase');
const { runHealthCheck } = require('./monitor');
const { runDailyVideoPipeline, testPipeline } = require('./videoPipeline');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'proteen-admin';
const MINE_HOURS = parseInt(process.env.MINE_INTERVAL_HOURS) || 4;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/articles', (req, res) => {
  const { topic, limit } = req.query;
  const articles = db.getArticles({ status: 'approved', topic: topic || undefined, limit: limit ? parseInt(limit) : undefined });
  res.json({ articles, count: articles.length });
});

app.get('/api/articles/:topic', (req, res) => {
  const articles = db.getArticles({ status: 'approved', topic: req.params.topic });
  res.json({ articles, count: articles.length, topic: req.params.topic });
});

app.get('/api/video/today', (req, res) => {
  const video = videoDB.getToday();
  if (!video) return res.json({ video: null });
  res.json({ video: { id: video.id, title: video.title, subtitle: video.subtitle, topic: video.topic, topicName: video.topicName, date: video.date, durationSecs: video.durationSecs, caption: video.caption, hashtags: video.hashtags } });
});

app.get('/admin/api/queue', adminAuth, (req, res) => {
  const articles = db.getArticles({ status: 'pending' });
  res.json({ articles, count: articles.length });
});

app.get('/admin/api/stats', adminAuth, (req, res) => {
  res.json(db.getStats());
});

app.get('/admin/api/articles', adminAuth, (req, res) => {
  const { status, topic } = req.query;
  const articles = db.getArticles({ status: status || undefined, topic: topic || undefined });
  res.json({ articles, count: articles.length });
});

app.post('/admin/api/approve/:id', adminAuth, (req, res) => {
  const article = db.updateArticle(req.params.id, { status: 'approved', approvedAt: new Date().toISOString() });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json({ success: true, article });
});

app.post('/admin/api/reject/:id', adminAuth, (req, res) => {
  const article = db.updateArticle(req.params.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json({ success: true, article });
});

app.get('/admin/approve/:id', (req, res) => {
  const { token } = req.query;
  if (token !== ADMIN_PASSWORD) return res.send('<h2>Unauthorized</h2>');
  const article = db.updateArticle(req.params.id, { status: 'approved', approvedAt: new Date().toISOString() });
  if (!article) return res.send('<h2>Article not found</h2>');
  res.send('<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;"><div style="font-size:48px;margin-bottom:16px;">✅</div><h2 style="color:#1D9E75;">Approved!</h2><p>"' + article.title + '"</p><a href="/admin" style="color:#e8b84b;">Back to Admin</a></body></html>');
});

app.get('/admin/reject/:id', (req, res) => {
  const { token } = req.query;
  if (token !== ADMIN_PASSWORD) return res.send('<h2>Unauthorized</h2>');
  const article = db.updateArticle(req.params.id, { status: 'rejected', rejectedAt: new Date().toISOString() });
  if (!article) return res.send('<h2>Article not found</h2>');
  res.send('<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center;"><div style="font-size:48px;margin-bottom:16px;">🗑️</div><h2 style="color:#E24B4A;">Rejected</h2><p>"' + article.title + '"</p><a href="/admin" style="color:#e8b84b;">Back to Admin</a></body></html>');
});

app.post('/admin/api/mine', adminAuth, async (req, res) => {
  res.json({ message: 'Mining cycle started.' });
  runMiningCycle().catch(err => console.error('[Admin] Mining error:', err.message));
});

app.get('/admin/api/schedule/today', adminAuth, (req, res) => {
  const schedule = scheduleDB.getToday();
  const stats = scheduleDB.getStats();
  res.json({ schedule: schedule ? schedule.schedule : [], stats, date: new Date().toISOString().split('T')[0] });
});

app.get('/admin/api/schedule/template', adminAuth, (req, res) => {
  res.json({ schedule: DAILY_SCHEDULE });
});

app.get('/admin/api/webhooks', adminAuth, (req, res) => {
  res.json({ webhooks: getWebhookStatus() });
});

app.post('/admin/api/schedule/build', adminAuth, async (req, res) => {
  res.json({ message: 'Building schedule in background...' });
  try {
    const todaysVideo = videoDB.getToday();
    const archive = videoDB.getArchive(30);
    const schedule = await buildDailySchedule(todaysVideo, archive);
    scheduleDB.saveSchedule(schedule);
    console.log('[Admin] Schedule built:', getScheduleSummary(schedule));
  } catch (err) {
    console.error('[Admin] Schedule build failed:', err.message);
  }
});

app.post('/admin/api/video', adminAuth, (req, res) => {
  const { id, title, script, durationSecs, videoUrl, date } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const video = videoDB.saveVideo({ id: id || require('uuid').v4(), title, script, durationSecs: durationSecs || 150, videoUrl, date: date || new Date().toISOString().split('T')[0], clips: [], savedAt: new Date().toISOString() });
  res.json({ success: true, video });
});

app.get('/admin/api/videos', adminAuth, (req, res) => {
  res.json({ videos: videoDB.getAllVideos() });
});

app.post('/admin/api/video/generate', adminAuth, async (req, res) => {
  res.json({ message: 'Video pipeline started.' });
  runDailyVideoPipeline().catch(err => console.error('[Admin] Pipeline error:', err.message));
});

app.post('/admin/api/video/test', adminAuth, async (req, res) => {
  res.json({ message: 'Pipeline test started.' });
  testPipeline().catch(err => console.error('[Admin] Test error:', err.message));
});

app.get('/admin/api/health', adminAuth, async (req, res) => {
  const result = await runHealthCheck();
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProTeen Nation Backend', time: new Date().toISOString() });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.post('/admin/api/settings', adminAuth, (req, res) => {
  const { mode, threshold } = req.body;
  if (mode) process.env.POSTING_MODE = mode;
  if (threshold) process.env.AUTO_POST_THRESHOLD = threshold;
  res.json({ success: true, mode: process.env.POSTING_MODE, threshold: process.env.AUTO_POST_THRESHOLD });
});

function startScheduler() {
  const cronExpression = '0 */' + MINE_HOURS + ' * * *';
  console.log('[Scheduler] Mining scheduled every ' + MINE_HOURS + ' hours');

  cron.schedule(cronExpression, async () => {
    console.log('[Scheduler] Triggered mining cycle');
    try {
      const result = await runMiningCycle();
      console.log('[Scheduler] Cycle complete:', result);
    } catch (err) {
      console.error('[Scheduler] Mining cycle failed:', err.message);
    }
  });

  cron.schedule('0 5 * * *', async () => {
    console.log('[Scheduler] Running daily video pipeline...');
    try {
      const video = await runDailyVideoPipeline();
      console.log('[Scheduler] Video ready:', video.title);
    } catch (err) {
      console.error('[Scheduler] Video pipeline failed:', err.message);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try { await runHealthCheck(); }
    catch (err) { console.error('[Monitor] Health check failed:', err.message); }
  });

  console.log('[Monitor] Health checks scheduled every 15 minutes');

  setTimeout(() => {
    console.log('[Server] Running initial mining cycle...');
    runMiningCycle().catch(err => console.error('Initial mine failed:', err.message));
  }, 10000);
}

app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         ProTeen Nation Backend Server            ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Server:    http://localhost:' + PORT + '               ║');
  console.log('║  Admin:     http://localhost:' + PORT + '/admin          ║');
  console.log('║  API:       http://localhost:' + PORT + '/api/articles   ║');
  console.log('║  Mode:      ' + (process.env.POSTING_MODE || 'review') + '                                ║');
  console.log('║  Mine every:' + MINE_HOURS + ' hours                               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  startScheduler();
});

module.exports = app;

