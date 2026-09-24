const { CLAUDE_SONNET, CLAUDE_HAIKU } = require('./aiModels');
// ProTeen Nation — Clip Pipeline
// After the daily video is generated:
//   1. Claude identifies the 6 best 30-second moments
//   2. FFmpeg cuts each clip from the full MP4
//   3. Each clip is posted to Instagram, YouTube, Facebook, and X via webhooks
//   (TikTok is manual — user downloads and posts)

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const path = require('path');

const { renderClip } = require('./videoRenderer');

const BACKEND_URL = process.env.BACKEND_URL || 'https://proteen-backend-production.up.railway.app';
const CLIP_PLATFORMS = ['instagram', 'youtube', 'facebook', 'x']; // TikTok is manual

// Times to post each clip throughout the day (spread for max algorithm reach)
const POST_TIMES = [
  '07:30', // Morning commute
  '09:15', // School start energy
  '11:45', // Pre-lunch scroll
  '14:00', // Afternoon slump
  '16:30', // After school
  '20:00', // Evening wind-down
];

// ── Step 1: Identify the 6 best clip moments ──────────────────────────────
async function identifyClips(video) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are a social media editor for ProTeen Nation, a motivational platform for teenagers.

Analyze this speech and identify 6 DIFFERENT 30-second clip moments for Instagram Reels, YouTube Shorts, and TikTok.

Video title: "${video.title}"
Duration: ~${video.durationSecs} seconds
Script:
---
${video.script}
---

CRITICAL RULES:
- Each clip must be from a DIFFERENT part of the video — no two clips can overlap or cover the same moment
- Spread clips across the full duration (beginning, early-middle, middle, late-middle, near-end, end)
- Each clip must work as a standalone piece without needing context from the others
- No two clips should have the same hookLine or feel like the same moment

Pick moments that:
- Start with a hook that grabs attention in the first 3 seconds
- Are emotionally powerful or highly quotable
- Cover variety: opening hook, core lesson, emotional peak, challenge/call-to-action, powerful quote, closing

Return ONLY valid JSON array of exactly 6 items with NON-OVERLAPPING time ranges:
[
  {
    "type": "hook",
    "startSec": 0,
    "endSec": 30,
    "hookLine": "the opening sentence of this clip",
    "caption": "punchy 1-2 sentence caption for this clip"
  }
]`;

  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_SONNET,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    let clips = JSON.parse(text);
    console.log('[ClipPipeline] Identified', clips.length, 'clip moments');

    // Enforce non-overlapping: if two clips share >50% of their duration, drop the later one
    // and replace it with a segment from a gap in the video
    clips = clips.slice(0, 6).sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
    const nonOverlapping = [clips[0]];
    for (let i = 1; i < clips.length; i++) {
      const prev = nonOverlapping[nonOverlapping.length - 1];
      const cur  = clips[i];
      const overlapEnd = Math.min(prev.endSec || 0, cur.endSec || 0);
      const overlapStart = Math.max(prev.startSec || 0, cur.startSec || 0);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const curDuration = (cur.endSec || 0) - (cur.startSec || 0);
      if (overlap / Math.max(curDuration, 1) < 0.5) {
        nonOverlapping.push(cur);
      } else {
        console.warn(`[ClipPipeline] Dropping overlapping clip ${i + 1} (${cur.startSec}–${cur.endSec})`);
      }
    }
    // If we dropped any, fill gaps with evenly-spaced replacements
    if (nonOverlapping.length < 6) {
      const step = Math.floor(video.durationSecs / 7);
      const usedStarts = new Set(nonOverlapping.map(c => Math.floor((c.startSec || 0) / step)));
      const types = ['hook','lesson','quote','challenge','emotional','closing'];
      for (let s = 1; s <= 6 && nonOverlapping.length < 6; s++) {
        if (!usedStarts.has(s)) {
          nonOverlapping.push({
            type: types[nonOverlapping.length] || 'clip',
            startSec: step * s - 15,
            endSec: step * s + 15,
            hookLine: video.title,
            caption: `"${video.title}" — ProTeen Nation 🔥`,
          });
          usedStarts.add(s);
        }
      }
    }

    return nonOverlapping.slice(0, 6);
  } catch (err) {
    console.error('[ClipPipeline] Failed to identify clips:', err.message);
    // Fallback: evenly space 6 clips through the video
    const step = Math.floor(video.durationSecs / 7);
    return Array.from({ length: 6 }, (_, i) => ({
      type: ['hook','lesson','quote','challenge','emotional','closing'][i],
      startSec: step * (i + 1) - 15,
      endSec: step * (i + 1) + 15,
      hookLine: video.title,
      caption: `"${video.title}" — ProTeen Nation 🔥`,
    }));
  }
}

// ── Step 2: Generate platform caption ─────────────────────────────────────
async function generateCaption(clip, platform, video) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const platformNames = { instagram: 'Instagram Reels', youtube: 'YouTube Shorts', facebook: 'Facebook Reels', x: 'X (Twitter)' };
  const hashtagCount = platform === 'x' ? 3 : 10;
  const maxLen = platform === 'x' ? 200 : 150;

  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_HAIKU,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a powerful ${platformNames[platform]} caption for this ProTeen Nation motivational clip.
Clip hook: "${clip.hookLine}"
Topic: ${video.topicName}

Rules:
- Open with the most compelling line from the clip — not a generic intro
- Write for teenagers (13–19) — direct, real, no corporate speak
- Under ${maxLen} characters total
- End with ONE of these engagement CTAs (pick the most fitting): "💾 Save this.", "👇 Tag someone who needs this.", "💬 Tell me your biggest challenge below.", "🔁 Share this with someone going through it."
- Add ${hashtagCount} hashtags at the end, include #ProTeenNation #WeAreTheFuture
- Return ONLY the caption text, nothing else`,
      }],
    });
    return msg.content[0].text.trim();
  } catch {
    return `${clip.hookLine}\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${video.topicName.replace(/\s/g,'')}`;
  }
}

// ── Helper: ms until a given HH:MM time today ─────────────────────────────
function msUntil(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(h, m, 0, 0);
  // If time already passed today, schedule for tomorrow
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

// ── Step 3: Post clip to a platform via webhook ────────────────────────────
async function postClip(clipUrl, caption, platform, clip, video, scheduleTime) {
  const webhookUrl = process.env[`WEBHOOK_${platform.toUpperCase()}`];
  if (!webhookUrl) {
    console.log(`[ClipPipeline] No webhook for ${platform} — skipping`);
    return { success: false, reason: 'No webhook configured' };
  }

  const payload = {
    platform,
    clipUrl,
    caption,
    videoTitle: video.title,
    topic: video.topicName,
    clipType: clip.type,
    scheduledFor: scheduleTime,
    format: platform === 'x' ? '16:9' : '9:16',
    postedBy: 'ProTeen Nation Automated System',
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await axios.post(webhookUrl, payload, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
    console.log(`[ClipPipeline] ✅ Posted clip to ${platform}`);
    return { success: true, status: res.status };
  } catch (err) {
    console.error(`[ClipPipeline] ❌ Failed to post to ${platform}:`, err.message);
    return { success: false, reason: err.message };
  }
}

// ── Main: run the full clip pipeline for a video ──────────────────────────
async function runClipPipeline(video, { force = false } = {}) {
  if (!video || !video.videoPath || !video.script) {
    console.log('[ClipPipeline] No video or script — skipping');
    return;
  }

  // Guard: don't double-schedule clips for the same video
  if (!force && video.clipsScheduledAt) {
    console.log('[ClipPipeline] Clips already scheduled for this video at', video.clipsScheduledAt, '— skipping. Pass force=true to override.');
    return;
  }

  console.log('\n[ClipPipeline] Starting clip pipeline for:', video.title);

  // Step 1: Identify 6 clip moments
  const clipMoments = await identifyClips(video);
  if (!clipMoments.length) {
    console.error('[ClipPipeline] No clip moments identified');
    return;
  }

  // Verify the source video file exists before attempting any clip cuts
  const fs = require('fs');
  if (video.videoPath && !fs.existsSync(video.videoPath)) {
    console.warn('[ClipPipeline] videoPath not found on disk:', video.videoPath, '— clips will use full video URL');
  }

  // Step 2: Cut all 6 clips — each clip is attempted independently.
  // IMPORTANT: we track every URL we've already scheduled. If FFmpeg fails for a clip
  // and the fallback URL is identical to a previous clip's URL, we skip that slot
  // entirely rather than posting the same video twice in one day.
  const readyClips = [];
  const scheduledUrls = new Set();

  for (let i = 0; i < clipMoments.length; i++) {
    const clip     = clipMoments[i];
    const clipId   = `${video.id}_clip${i + 1}`;
    const startSec = Math.max(0, Math.floor(clip.startSec || 0));
    const endSec   = Math.min(video.durationSecs, Math.ceil(clip.endSec || startSec + 30));

    console.log(`[ClipPipeline] Cutting clip ${i + 1}/6: ${startSec}s–${endSec}s (${clip.type})`);

    let clipUrl;
    try {
      await renderClip(video.videoPath, startSec, endSec, clipId);
      clipUrl = `${BACKEND_URL}/videos/${clipId}_clip.mp4`;
      console.log(`[ClipPipeline] Clip ${i + 1} ready: ${clipUrl}`);
    } catch (err) {
      console.warn(`[ClipPipeline] FFmpeg failed on clip ${i + 1}:`, err.message);
      clipUrl = video.videoUrl; // last-resort fallback: full video
      console.log(`[ClipPipeline] Clip ${i + 1} fallback → full video URL`);
    }

    // Guard: never schedule the same URL into two different time slots
    if (scheduledUrls.has(clipUrl)) {
      console.warn(`[ClipPipeline] Clip ${i + 1} URL already used in an earlier slot — skipping to avoid duplicate post`);
      continue;
    }
    scheduledUrls.add(clipUrl);

    // Generate a clip-specific caption (use 'instagram' as the base platform style)
    const caption = await generateCaption(clip, 'instagram', video);
    readyClips.push({ clip, clipUrl, caption, index: i + 1 });
  }

  console.log(`[ClipPipeline] ${readyClips.length}/6 unique clips ready. Scheduling via Buffer...`);

  // Step 3: Schedule all posts via Buffer (spreads posts throughout the day automatically)
  try {
    const { postClips } = require('./poster');
    const bufferClips = readyClips.map(c => ({ clipUrl: c.clipUrl, caption: c.caption }));
    await postClips(video, bufferClips);
    console.log('[ClipPipeline] All posts scheduled in Buffer ✅');
    // Mark video so clips are never double-scheduled
    const { videoDB } = require('./videoDatabase');
    video.clipsScheduledAt = new Date().toISOString();
    videoDB.saveVideo(video);
  } catch (err) {
    console.error('[ClipPipeline] Buffer scheduling failed:', err.message);
  }

  return readyClips.map(c => ({ clip: c.index, url: c.clipUrl }));
}

module.exports = { runClipPipeline };
