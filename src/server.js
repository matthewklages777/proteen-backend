require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const db = require('./database');
const { runMiningCycle } = require('./miner');
const { buildDailySchedule, getScheduleSummary, DAILY_SCHEDULE, getWebhookStatus } = require('./clipScheduler');
const { postScheduledSlot } = require('./poster');
const { videoDB, scheduleDB, quoteDB } = require('./videoDatabase');
const { runHealthCheck } = require('./monitor');
const { runDailyVideoPipeline, testPipeline } = require('./videoPipeline');
const { runClipPipeline } = require('./clipPipeline');
const { runScholarshipMiner } = require('./scholarshipMiner');
const { scholarshipDB } = require('./scholarshipDatabase');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'proteen-admin';
const MINE_HOURS = parseInt(process.env.MINE_INTERVAL_HOURS) || 4;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/videos', express.static(path.join(__dirname, '../data/videos')));

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

// Public archive — all videos, optionally filtered by topic
app.get('/api/videos', (req, res) => {
  const { topic, limit } = req.query;
  let videos = videoDB.getAllVideos().map(v => ({
    id: v.id, title: v.title, topic: v.topic, topicName: v.topicName,
    date: v.date, durationSecs: v.durationSecs, videoUrl: v.videoUrl,
  }));
  if (topic) videos = videos.filter(v => v.topic === topic);
  if (limit) videos = videos.slice(0, parseInt(limit));
  res.json({ videos, count: videos.length });
});

// Public scholarship endpoints
app.get('/api/scholarships', (req, res) => {
  const { type, limit } = req.query;
  const scholarships = scholarshipDB.getActive({ type, limit });
  res.json({ scholarships, count: scholarships.length, stats: scholarshipDB.getStats() });
});

app.get('/api/quote/today', async (req, res) => {
  let quote = quoteDB.getToday();
  // If no quote for today yet, generate one on the fly
  if (!quote) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: 'Write one short powerful quote (under 20 words) specifically for teenagers about growth, resilience, or potential. Make it original, not a famous quote. Return ONLY a JSON object like: {"text":"quote here","author":"ProTeen Nation"}' }],
      });
      const parsed = JSON.parse(msg.content[0].text.trim().replace(/```json|```/g, '').trim());
      quote = { ...parsed, date: new Date().toISOString().split('T')[0], generatedAt: new Date().toISOString() };
      quoteDB.saveQuote(quote);
      console.log('[Quote] On-demand quote generated:', quote.text);
    } catch (err) {
      console.error('[Quote] On-demand generation failed:', err.message);
      // Fallback quote so the site never shows blank
      quote = { text: "Your potential is limitless. Start proving it today.", author: "ProTeen Nation", date: new Date().toISOString().split('T')[0] };
    }
  }
  res.set('Cache-Control', 'no-store');
  res.json({ quote });
});

app.get('/api/video/today', (req, res) => {
  const video = videoDB.getToday();
  if (!video) return res.json({ video: null });
  res.json({ video: { id: video.id, title: video.title, subtitle: video.subtitle, topic: video.topic, topicName: video.topicName, date: video.date, durationSecs: video.durationSecs, caption: video.caption, hashtags: video.hashtags, videoUrl: video.videoUrl } });
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

app.post('/admin/api/approve-pending', adminAuth, (req, res) => {
  const threshold = parseInt(req.query.threshold) || 75;
  const articles = db.getArticles({ status: 'pending' });
  let approved = 0;
  articles.forEach(a => {
    if ((a.score || 0) >= threshold) {
      db.updateArticle(a.id, { status: 'approved', approvedAt: new Date().toISOString() });
      approved++;
    }
  });
  res.json({ success: true, approved, total: articles.length, threshold });
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
  try {
    const force = req.query.force === 'true' || req.body.force === true;
    const topicOverride = req.query.topic || req.body.topic || null;
    if (force) {
      const today = new Date().toISOString().split('T')[0];
      videoDB.deleteByDate(today);
      console.log('[Admin] Force flag set — deleted existing video for today');
    }
    console.log('[Admin] Starting video pipeline (blocking)...');
    const video = await runDailyVideoPipeline(topicOverride);
    res.json({ success: true, video });
  } catch (err) {
    console.error('[Admin] Pipeline error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// Manually trigger Buffer posting for today's video
app.post('/admin/api/buffer/post-today', adminAuth, async (req, res) => {
  try {
    const video = videoDB.getToday();
    if (!video) return res.status(404).json({ success: false, error: 'No video for today' });
    if (!video.videoUrl) return res.status(400).json({ success: false, error: 'Video has no URL' });
    const { postDailyVideo } = require('./poster');
    console.log('[Admin] Manually triggering Buffer post for:', video.title);
    const results = await postDailyVideo(video);
    res.json({ success: true, video: video.title, videoUrl: video.videoUrl, bufferResults: results });
  } catch (err) {
    console.error('[Admin] Buffer manual post failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually trigger Buffer clip pipeline for today's video
app.post('/admin/api/buffer/post-clips', adminAuth, async (req, res) => {
  try {
    const video = videoDB.getToday();
    if (!video) return res.status(404).json({ success: false, error: 'No video for today' });
    console.log('[Admin] Manually triggering clip pipeline for:', video.title);
    res.json({ success: true, message: 'Clip pipeline started in background' });
    runClipPipeline(video).catch(err => console.error('[Admin] Clip pipeline error:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/api/quote/generate', adminAuth, async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: 'Write one short powerful quote (under 20 words) specifically for teenagers about growth, resilience, or potential. Make it original, not a famous quote. Return ONLY a JSON object like: {"text":"quote here","author":"ProTeen Nation"}' }],
    });
    const parsed = JSON.parse(msg.content[0].text.trim().replace(/```json|```/g, '').trim());
    const quote = { ...parsed, date: new Date().toISOString().split('T')[0], generatedAt: new Date().toISOString() };
    quoteDB.saveQuote(quote);
    res.json({ success: true, quote });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/api/video/generate/:topicId', adminAuth, async (req, res) => {
  const TOPICS = ['resilience','school','relationships','faith','sports','health','careers'];
  const topicId = req.params.topicId;
  const TOPIC_NAMES = { resilience:'Resilience & Mindset', school:'School & Academics', relationships:'Relationships', faith:'Faith & Spirituality', sports:'Sports & Competition', health:'Health & Fitness', careers:'Careers & Ambition' };
  if (!TOPICS.includes(topicId)) return res.status(400).json({ error: 'Unknown topic. Use: ' + TOPICS.join(', ') });
  try {
    const { generateSpeech, generateAudio } = require('./videoPipeline');
    const { renderVideo } = require('./videoRenderer');
    const { v4: uuidv4 } = require('uuid');
    const topic = { id: topicId, name: TOPIC_NAMES[topicId] };
    const videoId = uuidv4();
    console.log('[Admin] Generating video for topic:', topic.name);
    const script = await generateSpeech(topic);
    const audioPath = await generateAudio(script, videoId);
    const rawTitle = script.split('.')[0].trim();
    const title = rawTitle.length <= 60 ? rawTitle : rawTitle.slice(0, 60).replace(/\s+\S*$/, '').trim();
    const BACKEND_URL = process.env.BACKEND_URL || 'https://proteen-backend-production.up.railway.app';
    const videoPath = await renderVideo(audioPath, { id: videoId, title, topic: topicId, topicName: topic.name });
    const videoUrl = `${BACKEND_URL}/videos/${videoId}.mp4`;
    const videoRecord = { id: videoId, date: new Date().toISOString().split('T')[0], topic: topicId, topicName: topic.name, title, script, audioPath, videoPath, videoUrl, status: 'ready', durationSecs: Math.ceil(script.split(' ').length / 2.5), generatedAt: new Date().toISOString(), voiceName: 'Frank' };
    videoDB.saveVideo(videoRecord);
    res.json({ success: true, video: videoRecord });
  } catch (err) {
    console.error('[Admin] Topic video error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/admin/api/clips/generate', adminAuth, async (req, res) => {
  try {
    const video = videoDB.getToday();
    if (!video) return res.status(404).json({ error: 'No video for today yet. Generate a video first.' });
    res.json({ message: 'Clip pipeline started. 6 clips will be cut and posted.' });
    runClipPipeline(video).catch(err => console.error('[Admin] Clip pipeline error:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scholarship admin endpoints
app.post('/admin/api/scholarships/mine', adminAuth, async (req, res) => {
  const sync = req.query.sync === 'true';
  if (sync) {
    try {
      const result = await runScholarshipMiner();
      res.json({ success: true, result, stats: scholarshipDB.getStats() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  } else {
    res.json({ message: 'Scholarship mining started. Results will appear in /api/scholarships shortly.' });
    runScholarshipMiner().catch(err => console.error('[Admin] Scholarship miner error:', err.message));
  }
});

app.post('/admin/api/webhooks/test', adminAuth, async (req, res) => {
  const axios = require('axios');
  const platforms = ['INSTAGRAM', 'YOUTUBE', 'FACEBOOK', 'X'];
  const results = {};
  for (const p of platforms) {
    const url = process.env[`WEBHOOK_${p}`];
    if (!url) { results[p] = { ok: false, reason: 'Not configured' }; continue; }
    // Mask URL for display
    const masked = url.slice(0, 40) + '...';
    try {
      const r = await axios.post(url, {
        test: true, platform: p.toLowerCase(),
        message: 'ProTeen Nation webhook test ping',
        timestamp: new Date().toISOString(),
      }, { timeout: 10000 });
      results[p] = { ok: true, status: r.status, url: masked };
    } catch (err) {
      results[p] = { ok: false, status: err.response?.status, error: err.message, url: masked };
    }
  }
  res.json(results);
});

app.get('/admin/api/scholarships/test-sources', adminAuth, async (req, res) => {
  const axios = require('axios');
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
  const results = {};
  // Test Google News RSS
  try {
    const r = await axios.get('https://news.google.com/rss/search?q=scholarship+2026+high+school&hl=en-US&gl=US&ceid=US:en', { timeout: 10000, headers: { 'User-Agent': UA } });
    const count = (r.data.match(/<item>/g) || []).length;
    results.googleRSS = { ok: true, items: count, sample: r.data.slice(0, 300) };
  } catch (e) { results.googleRSS = { ok: false, error: e.message }; }
  // Test DuckDuckGo
  try {
    const r = await axios.post('https://html.duckduckgo.com/html/', 'q=scholarship+2026+high+school+apply', { timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA } });
    results.duckduckgo = { ok: true, length: r.data.length, hasResults: r.data.includes('result__a') };
  } catch (e) { results.duckduckgo = { ok: false, error: e.message }; }
  // Test direct page
  try {
    const r = await axios.get('https://studentscholarships.org/scholarships_for_high_school_students.php', { timeout: 10000, headers: { 'User-Agent': UA } });
    results.directPage = { ok: true, length: r.data.length, sample: r.data.replace(/<[^>]+>/g,' ').slice(0,400) };
  } catch (e) { results.directPage = { ok: false, error: e.message }; }
  res.json(results);
});

app.get('/admin/api/scholarships/test-extraction', adminAuth, async (req, res) => {
  try {
    const axios = require('axios');
    const Anthropic = require('@anthropic-ai/sdk');
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    // Fetch a few RSS items
    const rssRes = await axios.get('https://news.google.com/rss/search?q=scholarship+2026+high+school+apply&hl=en-US&gl=US&ceid=US:en', { timeout: 10000, headers: { 'User-Agent': UA } });
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(rssRes.data)) !== null && items.length < 5) {
      const b = m[1];
      const title = b.match(/<title><!\[CDATA\[(.*?)\]\]>/)?.[1] || b.match(/<title>(.*?)<\/title>/)?.[1] || '';
      const link  = b.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const desc  = b.match(/<description><!\[CDATA\[(.*?)\]\]>/)?.[1] || '';
      if (title) items.push({ title: title.replace(/<[^>]+>/g,'').trim(), url: link.trim(), content: desc.replace(/<[^>]+>/g,'').trim().slice(0,300) });
    }
    // Run Claude extraction
    const { runScholarshipMiner } = require('./scholarshipMiner');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const itemText = items.map((r,i) => `--- Item ${i+1} ---\nTitle: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join('\n\n');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
      messages: [{ role: 'user', content: `Extract scholarships from these items as JSON array:\n${itemText}\nReturn only JSON array.` }],
    });
    res.json({ rssItems: items, claudeRaw: msg.content[0].text.slice(0, 1000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/api/scholarships/test-tavily', adminAuth, async (req, res) => {
  const axios = require('axios');
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return res.json({ error: 'TAVILY_API_KEY not set' });
  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: apiKey,
      query: 'scholarship 2026 high school students',
      max_results: 3,
    }, { timeout: 15000 });
    res.json({ success: true, resultCount: response.data.results?.length || 0, sample: response.data.results?.slice(0,2).map(r => ({ title: r.title, url: r.url })) });
  } catch (err) {
    res.json({ success: false, status: err.response?.status, error: err.response?.data || err.message });
  }
});

app.get('/admin/api/scholarships', adminAuth, (req, res) => {
  res.json({ scholarships: scholarshipDB.getAll(), stats: scholarshipDB.getStats() });
});

app.delete('/admin/api/scholarships/:id', adminAuth, (req, res) => {
  scholarshipDB.expire(req.params.id);
  res.json({ success: true });
});

app.post('/admin/api/video/test', adminAuth, async (req, res) => {
  try {
    console.log('[Admin] Starting pipeline test (blocking)...');
    await testPipeline();
    res.json({ success: true, message: 'Pipeline test complete — check server logs.' });
  } catch (err) {
    console.error('[Admin] Test error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

app.get('/admin/api/health', adminAuth, async (req, res) => {
  const result = await runHealthCheck();
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ProTeen Nation Backend', time: new Date().toISOString(), version: '2026-05-29-v2' });
});

// Quick FFmpeg availability check — no auth required for diagnosis
app.get('/diag/ffmpeg', async (req, res) => {
  const { execFile } = require('child_process');
  const ffmpegPath = require('ffmpeg-static');
  execFile(ffmpegPath, ['-version'], { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) return res.json({ available: false, error: err.message, stderr });
    const version = (stdout || stderr || '').split('\n')[0];
    res.json({ available: true, version, path: ffmpegPath });
  });
});

// Quick clip cut test using real video
app.get('/diag/clip-test', adminAuth, async (req, res) => {
  try {
    const video = videoDB.getToday();
    if (!video || !video.videoPath) return res.json({ error: 'No video today', hint: 'Generate a video first' });

    const { execFile } = require('child_process');
    const ffmpegPath = require('ffmpeg-static');
    const outputPath = video.videoPath.replace('.mp4', '_diagclip.mp4');

    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-y', '-ss', '5', '-t', '10',
        '-i', video.videoPath,
        '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p',
        outputPath,
      ], { timeout: 60000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });

    const fs = require('fs');
    const exists = fs.existsSync(outputPath);
    const size = exists ? fs.statSync(outputPath).size : 0;
    const clipUrl = `${process.env.BACKEND_URL || 'https://proteen-backend-production.up.railway.app'}/videos/${require('path').basename(outputPath)}`;
    res.json({ success: true, exists, size, clipUrl, videoPath: video.videoPath });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/admin/api/debug-env', adminAuth, (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  const elKey = process.env.ELEVENLABS_API_KEY;
  res.json({
    ANTHROPIC_API_KEY: key ? `SET (starts: ${key.slice(0,12)}..., length: ${key.length})` : 'NOT SET',
    ELEVENLABS_API_KEY: elKey ? `SET (starts: ${elKey.slice(0,8)}..., length: ${elKey.length})` : 'NOT SET',
    PIXABAY_API_KEY: process.env.PIXABAY_API_KEY ? 'SET' : 'NOT SET',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ? 'SET' : 'NOT SET',
    allEnvKeys: Object.keys(process.env).filter(k => !k.toLowerCase().includes('path') && !k.toLowerCase().includes('home')).sort(),
  });
});

// Test FFmpeg clip cutting directly
app.get('/admin/api/test-ffmpeg', adminAuth, async (req, res) => {
  try {
    const { renderClip } = require('./videoRenderer');
    const video = videoDB.getToday();
    if (!video || !video.videoPath) return res.json({ error: 'No video today' });
    const testClipId = `${video.id}_test`;
    console.log('[Test] Running FFmpeg clip cut on:', video.videoPath);
    await renderClip(video.videoPath, 10, 40, testClipId);
    const clipUrl = `${process.env.BACKEND_URL || 'https://proteen-backend-production.up.railway.app'}/videos/${testClipId}_clip.mp4`;
    res.json({ success: true, clipUrl, videoPath: video.videoPath });
  } catch (err) {
    console.error('[Test] FFmpeg test failed:', err.message);
    res.json({ success: false, error: err.message, stack: err.stack });
  }
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

  // Generate daily quote at 6 AM
  cron.schedule('0 6 * * *', async () => {
    console.log('[Scheduler] Generating daily quote...');
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: 'Write one short powerful quote (under 20 words) specifically for teenagers about growth, resilience, or potential. Make it original, not a famous quote. Return ONLY a JSON object like: {"text":"quote here","author":"ProTeen Nation"}' }],
      });
      const parsed = JSON.parse(msg.content[0].text.trim());
      quoteDB.saveQuote({ ...parsed, date: new Date().toISOString().split('T')[0], generatedAt: new Date().toISOString() });
      console.log('[Scheduler] Daily quote saved:', parsed.text);
    } catch (err) {
      console.error('[Scheduler] Quote generation failed:', err.message);
    }
  });

  cron.schedule('0 5 * * *', async () => {
    console.log('[Scheduler] Running daily video pipeline...');
    try {
      const video = await runDailyVideoPipeline();
      console.log('[Scheduler] Video ready:', video.title);
      // Post full video to all platforms via Buffer at 6 AM CST
      try {
        const { postDailyVideo } = require('./poster');
        await postDailyVideo(video);
        console.log('[Scheduler] Daily video scheduled in Buffer ✅');
      } catch (bufferErr) {
        console.error('[Scheduler] Buffer daily video post failed:', bufferErr.message);
      }
      // Cut 6 clips and schedule via Buffer throughout the day
      try {
        await runClipPipeline(video);
      } catch (clipErr) {
        console.error('[Scheduler] Clip pipeline failed:', clipErr.message);
      }
    } catch (err) {
      console.error('[Scheduler] Video pipeline failed:', err.message);
    }
  });

  // Mine scholarships daily at 7 AM
  cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Running daily scholarship mining...');
    try {
      const result = await runScholarshipMiner();
      console.log('[Scheduler] Scholarship mining done:', result);
    } catch (err) {
      console.error('[Scheduler] Scholarship mining failed:', err.message);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    try { await runHealthCheck(); }
    catch (err) { console.error('[Monitor] Health check failed:', err.message); }
  });

  console.log('[Monitor] Health checks scheduled every 15 minutes');

  // Self-heal on startup: re-mine articles and regenerate video if data was wiped
  setTimeout(async () => {
    console.log('[Server] Running startup self-heal check...');
    try {
      const stats = db.getStats();
      if (stats.approved < 10) {
        console.log('[Server] Few approved articles found — running mining cycle...');
        await runMiningCycle();
      } else {
        console.log('[Server] Articles OK:', stats.approved, 'approved');
      }
    } catch (err) {
      console.error('[Server] Startup mining failed:', err.message);
    }
    try {
      const todayQuote = quoteDB.getToday();
      if (!todayQuote) {
        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          messages: [{ role: 'user', content: 'Write one short powerful quote (under 20 words) specifically for teenagers about growth, resilience, or potential. Make it original, not a famous quote. Return ONLY a JSON object like: {"text":"quote here","author":"ProTeen Nation"}' }],
        });
        const parsed = JSON.parse(msg.content[0].text.trim());
        quoteDB.saveQuote({ ...parsed, date: new Date().toISOString().split('T')[0], generatedAt: new Date().toISOString() });
        console.log('[Server] Startup quote generated:', parsed.text);
      }
    } catch (err) {
      console.error('[Server] Startup quote generation failed:', err.message);
    }
    try {
      const todayVideo = videoDB.getToday();
      if (!todayVideo) {
        console.log('[Server] No video for today — running video pipeline...');
        await runDailyVideoPipeline();
        console.log('[Server] Startup video generation complete');
      } else {
        console.log('[Server] Video OK:', todayVideo.title);
      }
    } catch (err) {
      console.error('[Server] Startup video generation failed:', err.message);
    }
  }, 15000);
}

app.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║         ProTeen Nation Backend Server            ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Server:    http://localhost:' + PORT + '               ║');
  console.log('║  Admin:     http://localhost:' + PORT + '/admin          ║');
  console.log('║  API:       http://localhost:' + PORT + '/api/articles   ║');
  console.log('║  Mode:      ' + (process.env.POSTING_MODE || 'auto') + '                                ║');
  console.log('║  Mine every:' + MINE_HOURS + ' hours                               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  startScheduler();
});

module.exports = app;
// deploy Mon May 11 14:38:37 CDT 2026
// build-check-v2
// Mon May 11 20:23:30 CDT 2026
