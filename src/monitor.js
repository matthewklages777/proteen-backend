// ProTeen Nation — Health Monitor
// Watches every service ProTeen depends on and alerts the team
// if anything stops working. Runs every 15 minutes.
//
// Services monitored:
//   - Anthropic API (Claude)
//   - Tavily Search API
//   - HeyGen Video API
//   - All 5 social media webhooks (Zapier)
//   - Article mining pipeline (did it run? did it find articles?)
//   - Daily video pipeline (was today's video generated?)
//   - Clip scheduler (did posts go out on time?)
//   - The ProTeen website itself (is it loading?)
//   - Database health (can we read/write?)

require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { videoDB, scheduleDB } = require('./videoDatabase');
const db = require('./database');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Alert thresholds ───────────────────────────────────────────────────────
const THRESHOLDS = {
  articleMineMaxAgeHours: 6,      // Alert if no mining run in 6+ hours
  videoMaxAgeHours: 25,           // Alert if today's video is missing by 7 AM
  schedulePostMaxDelayMins: 30,   // Alert if a scheduled post is 30+ min late
  websiteTimeoutMs: 8000,         // Alert if website takes 8+ sec to load
  apiTimeoutMs: 10000,            // Timeout for API health checks
};

// ── Service check results ──────────────────────────────────────────────────
// status: 'ok' | 'warning' | 'down'
async function checkAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'YOUR_ANTHROPIC_KEY_HERE') {
    return { service: 'Anthropic (Claude)', status: 'warning', message: 'API key not configured in .env' };
  }
  try {
    const msg = await Promise.race([
      anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with the word OK only.' }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), THRESHOLDS.apiTimeoutMs)),
    ]);
    if (msg?.content?.[0]?.text) {
      return { service: 'Anthropic (Claude)', status: 'ok', message: 'Responding normally' };
    }
    return { service: 'Anthropic (Claude)', status: 'warning', message: 'Unexpected response format' };
  } catch (err) {
    return { service: 'Anthropic (Claude)', status: 'down', message: err.message };
  }
}

async function checkTavily() {
  if (!process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY === 'YOUR_TAVILY_KEY_HERE') {
    return { service: 'Tavily (Search)', status: 'warning', message: 'API key not configured — article mining will use placeholders' };
  }
  try {
    const res = await Promise.race([
      axios.post('https://api.tavily.com/search', {
        api_key: process.env.TAVILY_API_KEY,
        query: 'teen motivation',
        max_results: 1,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), THRESHOLDS.apiTimeoutMs)),
    ]);
    if (res.data?.results) {
      return { service: 'Tavily (Search)', status: 'ok', message: `Responding normally` };
    }
    return { service: 'Tavily (Search)', status: 'warning', message: 'Unexpected response' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return { service: 'Tavily (Search)', status: 'down', message: 'Invalid API key' };
    if (status === 429) return { service: 'Tavily (Search)', status: 'warning', message: 'Rate limit hit — too many requests' };
    return { service: 'Tavily (Search)', status: 'down', message: err.message };
  }
}

async function checkHeyGen() {
  if (!process.env.HEYGEN_API_KEY) {
    return { service: 'HeyGen (Video)', status: 'warning', message: 'API key not configured in .env' };
  }
  try {
    const res = await Promise.race([
      axios.get('https://api.heygen.com/v1/video.list?limit=1', {
        headers: { 'X-Api-Key': process.env.HEYGEN_API_KEY },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), THRESHOLDS.apiTimeoutMs)),
    ]);
    if (res.status === 200) {
      return { service: 'HeyGen (Video)', status: 'ok', message: 'Responding normally' };
    }
    return { service: 'HeyGen (Video)', status: 'warning', message: `Status ${res.status}` };
  } catch (err) {
    if (err.response?.status === 401) return { service: 'HeyGen (Video)', status: 'down', message: 'Invalid API key' };
    return { service: 'HeyGen (Video)', status: 'down', message: err.message };
  }
}

async function checkWebhooks() {
  const platforms = ['TIKTOK', 'INSTAGRAM', 'YOUTUBE', 'FACEBOOK', 'X'];
  const results = [];
  for (const platform of platforms) {
    const url = process.env[`WEBHOOK_${platform}`];
    if (!url || url.includes('YOUR_')) {
      results.push({ service: `Webhook — ${platform}`, status: 'warning', message: 'Not configured yet' });
      continue;
    }
    // Just check the URL is reachable (GET returns 405 for POST-only webhooks — that's fine)
    try {
      await Promise.race([
        axios.get(url).catch(e => e.response),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000)),
      ]);
      results.push({ service: `Webhook — ${platform}`, status: 'ok', message: 'Reachable' });
    } catch (err) {
      results.push({ service: `Webhook — ${platform}`, status: 'down', message: `Unreachable: ${err.message}` });
    }
  }
  return results;
}

async function checkWebsite() {
  const websiteUrl = process.env.WEBSITE_URL || 'https://proteennation.com';
  if (websiteUrl.includes('localhost')) {
    return { service: 'ProTeen Website', status: 'warning', message: 'Website URL not set to live domain yet' };
  }
  try {
    const start = Date.now();
    const res = await Promise.race([
      axios.get(websiteUrl, { timeout: THRESHOLDS.websiteTimeoutMs }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), THRESHOLDS.websiteTimeoutMs)),
    ]);
    const ms = Date.now() - start;
    if (res.status === 200) {
      const speedStatus = ms > 5000 ? 'warning' : 'ok';
      return { service: 'ProTeen Website', status: speedStatus, message: `Loaded in ${ms}ms${ms > 5000 ? ' — slower than usual' : ''}` };
    }
    return { service: 'ProTeen Website', status: 'down', message: `HTTP ${res.status}` };
  } catch (err) {
    return { service: 'ProTeen Website', status: 'down', message: `Unreachable: ${err.message}` };
  }
}

function checkDatabase() {
  try {
    const stats = db.getStats();
    const videos = videoDB.getAllVideos();
    return { service: 'Database', status: 'ok', message: `${stats.total} articles, ${videos.length} videos stored` };
  } catch (err) {
    return { service: 'Database', status: 'down', message: `Read/write error: ${err.message}` };
  }
}

function checkArticlePipeline() {
  try {
    const articles = db.getArticles({ limit: 1 });
    if (!articles.length) {
      return { service: 'Article Mining Pipeline', status: 'warning', message: 'No articles in database yet — pipeline may not have run' };
    }
    const latest = new Date(articles[0].minedAt);
    const ageHours = (Date.now() - latest.getTime()) / 1000 / 60 / 60;
    if (ageHours > THRESHOLDS.articleMineMaxAgeHours) {
      return {
        service: 'Article Mining Pipeline',
        status: 'warning',
        message: `Last mining run was ${ageHours.toFixed(1)} hours ago — expected every ${process.env.MINE_INTERVAL_HOURS || 4} hours`,
      };
    }
    return { service: 'Article Mining Pipeline', status: 'ok', message: `Last ran ${ageHours.toFixed(1)} hours ago` };
  } catch (err) {
    return { service: 'Article Mining Pipeline', status: 'down', message: err.message };
  }
}

function checkVideoSchedule() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const todaysVideo = videoDB.getToday();
    const hour = new Date().getHours();

    // Only flag missing video if it's past 7 AM
    if (!todaysVideo && hour >= 7) {
      return {
        service: 'Daily Video Pipeline',
        status: 'down',
        message: `No video generated for today (${today}) — daily speech pipeline may have failed`,
      };
    }
    if (!todaysVideo) {
      return { service: 'Daily Video Pipeline', status: 'ok', message: 'Before 7 AM — video generation not yet due' };
    }

    // Check if clip schedule was built
    const schedule = scheduleDB.getToday();
    if (!schedule && hour >= 6) {
      return { service: 'Daily Video Pipeline', status: 'warning', message: "Today's video exists but clip schedule wasn't built" };
    }

    const stats = scheduleDB.getStats();
    return {
      service: 'Daily Video Pipeline',
      status: 'ok',
      message: `Today's video ready — ${stats?.posted || 0}/${stats?.totalSlots || 0} posts sent`,
    };
  } catch (err) {
    return { service: 'Daily Video Pipeline', status: 'down', message: err.message };
  }
}

function checkPostingSchedule() {
  try {
    const schedule = scheduleDB.getToday();
    if (!schedule?.schedule?.length) {
      return { service: 'Post Scheduler', status: 'warning', message: "No schedule built for today yet" };
    }

    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const overdueSlots = schedule.schedule.filter(slot => {
      if (slot.status === 'posted') return false;
      const [h, m] = slot.scheduledTime.split(':').map(Number);
      const slotMins = h * 60 + m;
      const nowMins = now.getHours() * 60 + now.getMinutes();
      return nowMins - slotMins > THRESHOLDS.schedulePostMaxDelayMins;
    });

    if (overdueSlots.length > 0) {
      return {
        service: 'Post Scheduler',
        status: 'warning',
        message: `${overdueSlots.length} scheduled post(s) are overdue: ${overdueSlots.map(s => s.scheduledTime + ' ' + s.label).join(', ')}`,
      };
    }

    const stats = scheduleDB.getStats();
    return { service: 'Post Scheduler', status: 'ok', message: `${stats?.posted || 0} of ${stats?.totalSlots || 0} posts sent today` };
  } catch (err) {
    return { service: 'Post Scheduler', status: 'down', message: err.message };
  }
}

// ── Run all checks ─────────────────────────────────────────────────────────
async function runHealthCheck() {
  console.log(`\n[Monitor] Running health check at ${new Date().toLocaleString()}`);

  const [
    anthropicResult,
    tavilyResult,
    heygenResult,
    webhookResults,
    websiteResult,
  ] = await Promise.all([
    checkAnthropic(),
    checkTavily(),
    checkHeyGen(),
    checkWebhooks(),
    checkWebsite(),
  ]);

  const syncResults = [
    checkDatabase(),
    checkArticlePipeline(),
    checkVideoSchedule(),
    checkPostingSchedule(),
  ];

  const allResults = [
    anthropicResult,
    tavilyResult,
    heygenResult,
    ...webhookResults,
    websiteResult,
    ...syncResults,
  ];

  // Summarize
  const downs    = allResults.filter(r => r.status === 'down');
  const warnings = allResults.filter(r => r.status === 'warning');
  const oks      = allResults.filter(r => r.status === 'ok');

  console.log(`[Monitor] Results: ${oks.length} OK, ${warnings.length} warnings, ${downs.length} down`);
  downs.forEach(r => console.log(`  ✗ DOWN: ${r.service} — ${r.message}`));
  warnings.forEach(r => console.log(`  ⚠ WARN: ${r.service} — ${r.message}`));

  // Send alert if anything is down or warning
  if (downs.length > 0 || warnings.length > 0) {
    await sendAlertEmail(allResults, downs, warnings);
  }

  return { allResults, downs, warnings, oks };
}

// ── Alert email ────────────────────────────────────────────────────────────
async function sendAlertEmail(allResults, downs, warnings) {
  if (!process.env.EMAIL_FROM || process.env.EMAIL_FROM === 'your-email@gmail.com') {
    console.log('[Monitor] Email not configured — cannot send alert. Fix EMAIL_FROM in .env');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASSWORD },
  });

  const alertLevel = downs.length > 0 ? 'ACTION REQUIRED' : 'WARNING';
  const alertColor = downs.length > 0 ? '#E24B4A' : '#e8b84b';
  const alertBg    = downs.length > 0 ? '#ffeaea' : '#fdf6e3';

  const statusRows = allResults.map(r => {
    const icon  = r.status === 'ok' ? '✅' : r.status === 'warning' ? '⚠️' : '🔴';
    const color = r.status === 'ok' ? '#27500a' : r.status === 'warning' ? '#633806' : '#a32d2d';
    const bg    = r.status === 'ok' ? '#eaf3de' : r.status === 'warning' ? '#faeeda' : '#ffeaea';
    return `
      <tr>
        <td style="padding:8px 12px;font-size:13px;">${icon} ${r.service}</td>
        <td style="padding:8px 12px;">
          <span style="background:${bg};color:${color};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">${r.status.toUpperCase()}</span>
        </td>
        <td style="padding:8px 12px;font-size:12px;color:#555;">${r.message}</td>
      </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:24px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">

  <div style="background:#000;padding:20px 28px;display:flex;align-items:center;justify-content:space-between;">
    <div>
      <div style="font-size:18px;font-weight:700;color:#fff;">ProTeen Nation</div>
      <div style="font-size:11px;color:#e8b84b;letter-spacing:0.1em;text-transform:uppercase;margin-top:2px;">System Health Alert</div>
    </div>
    <div style="background:${alertColor};color:#fff;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;">${alertLevel}</div>
  </div>

  <div style="padding:20px 28px;">
    <div style="background:${alertBg};border-left:4px solid ${alertColor};padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px;">
      <p style="margin:0;font-size:14px;font-weight:600;color:#222;">
        ${downs.length > 0
          ? `🔴 ${downs.length} service${downs.length > 1 ? 's are' : ' is'} DOWN — ProTeen Nation may not be functioning properly.`
          : `⚠️ ${warnings.length} warning${warnings.length > 1 ? 's' : ''} detected — monitor closely.`}
      </p>
      <p style="margin:6px 0 0;font-size:13px;color:#555;">
        Detected at ${new Date().toLocaleString()} · Check the admin dashboard for details.
      </p>
    </div>

    ${downs.length > 0 ? `
    <div style="margin-bottom:20px;">
      <p style="font-size:13px;font-weight:700;color:#a32d2d;margin:0 0 8px;">Services that are DOWN:</p>
      ${downs.map(d => `<div style="background:#ffeaea;padding:10px 14px;border-radius:8px;margin-bottom:6px;font-size:13px;">
        <b>${d.service}</b> — ${d.message}
      </div>`).join('')}
    </div>` : ''}

    <p style="font-size:13px;font-weight:600;margin:0 0 8px;color:#222;">Full system status:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#999;font-weight:600;">SERVICE</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#999;font-weight:600;">STATUS</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#999;font-weight:600;">DETAILS</th>
        </tr>
      </thead>
      <tbody>${statusRows}</tbody>
    </table>

    <div style="margin-top:20px;text-align:center;">
      <a href="${process.env.ADMIN_URL || 'http://localhost:3001/admin'}"
         style="background:#000;color:#e8b84b;padding:11px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;display:inline-block;">
        Open Admin Dashboard
      </a>
    </div>
  </div>

  <div style="background:#f5f5f5;padding:14px 28px;text-align:center;">
    <p style="font-size:11px;color:#aaa;margin:0;">
      ProTeen Nation Health Monitor · Checks run every 15 minutes ·
      <a href="mailto:${process.env.EMAIL_FROM}" style="color:#aaa;">Unsubscribe</a>
    </p>
  </div>
</div>
</body></html>`;

  try {
    await transporter.sendMail({
      from: `"ProTeen Nation Monitor" <${process.env.EMAIL_FROM}>`,
      to: process.env.ALERT_EMAIL || process.env.EMAIL_TO,
      subject: `${downs.length > 0 ? '🔴' : '⚠️'} ProTeen Nation — ${alertLevel} · ${downs.length > 0 ? downs.map(d => d.service).join(', ') + ' DOWN' : warnings.length + ' warning(s)'}`,
      html,
    });
    console.log(`[Monitor] Alert email sent to ${process.env.ALERT_EMAIL || process.env.EMAIL_TO}`);
  } catch (err) {
    console.error('[Monitor] Failed to send alert email:', err.message);
  }
}

module.exports = { runHealthCheck };

// Run directly: node src/monitor.js
if (require.main === module) {
  runHealthCheck()
    .then(({ downs, warnings, oks }) => {
      console.log(`\nHealth check complete: ${oks.length} OK, ${warnings.length} warnings, ${downs.length} down`);
      process.exit(downs.length > 0 ? 1 : 0);
    })
    .catch(err => { console.error(err); process.exit(1); });
}
