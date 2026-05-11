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

const POST_TIMES = [
  '07:30', '09:00', '10:30', '12:00', '15:00', '19:00'
];

// ── Step 1: Identify the 6 best clip moments ──────────────────────────────
async function identifyClips(video) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are a social media editor for ProTeen Nation, a motivational platform for teenagers.

Analyze this speech and identify the 6 BEST 30-second clip moments for Instagram Reels, YouTube Shorts, and TikTok.

Video title: "${video.title}"
Duration: ~${video.durationSecs} seconds
Script:
---
${video.script}
---

Pick moments that:
- Start with a hook that grabs attention in the first 3 seconds
- Are emotionally powerful or highly quotable
- Work as standalone clips without needing context
- Cover variety: opening hook, core message, emotional peak, challenge, quote, closing

Return ONLY valid JSON array of exactly 6 items:
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const clips = JSON.parse(text);
    console.log('[ClipPipeline] Identified', clips.length, 'clip moments');
    return clips.slice(0, 6);
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a ${platformNames[platform]} caption for this ProTeen Nation clip.
Clip hook: "${clip.hookLine}"
Topic: ${video.topicName}
Keep it under ${maxLen} chars. Start strong. Add ${hashtagCount} hashtags at the end.
Include #ProTeenNation #WeAreTheFuture. Return ONLY the caption text.`,
      }],
    });
    return msg.content[0].text.trim();
  } catch {
    return `${clip.hookLine}\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${video.topicName.replace(/\s/g,'')}`;
  }
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
async function runClipPipeline(video) {
  if (!video || !video.videoPath || !video.script) {
    console.log('[ClipPipeline] No video or script — skipping');
    return;
  }

  console.log('\n[ClipPipeline] Starting clip pipeline for:', video.title);

  // Step 1: Identify 6 clip moments
  const clipMoments = await identifyClips(video);
  if (!clipMoments.length) {
    console.error('[ClipPipeline] No clip moments identified');
    return;
  }

  const results = [];

  for (let i = 0; i < clipMoments.length; i++) {
    const clip = clipMoments[i];
    const clipId = `${video.id}_clip${i + 1}`;
    const scheduleTime = POST_TIMES[i] || '12:00';

    // Clamp timestamps to video duration
    const startSec = Math.max(0, Math.floor(clip.startSec || 0));
    const endSec = Math.min(video.durationSecs, Math.ceil(clip.endSec || startSec + 30));

    console.log(`[ClipPipeline] Cutting clip ${i + 1}/6: ${startSec}s — ${endSec}s (${clip.type})`);

    let clipPath, clipUrl;
    try {
      clipPath = await renderClip(video.videoPath, startSec, endSec, clipId);
      clipUrl = `${BACKEND_URL}/videos/${clipId}_clip.mp4`;
      console.log(`[ClipPipeline] Clip ${i + 1} ready: ${clipUrl}`);
    } catch (err) {
      console.error(`[ClipPipeline] Failed to cut clip ${i + 1}:`, err.message);
      continue;
    }

    // Post to each platform with a platform-specific caption
    for (const platform of CLIP_PLATFORMS) {
      const caption = await generateCaption(clip, platform, video);
      const result = await postClip(clipUrl, caption, platform, clip, video, scheduleTime);
      results.push({ clip: i + 1, platform, ...result });
      // Small stagger between posts
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const succeeded = results.filter(r => r.success).length;
  console.log(`\n[ClipPipeline] Done. ${succeeded}/${results.length} posts sent across all platforms.`);
  console.log('[ClipPipeline] TikTok clips are at:');
  for (let i = 0; i < clipMoments.length; i++) {
    console.log(`  Clip ${i + 1}: ${BACKEND_URL}/videos/${video.id}_clip${i + 1}_clip.mp4`);
  }

  return results;
}

module.exports = { runClipPipeline };
