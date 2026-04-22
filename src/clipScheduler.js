// ProTeen Nation — Clip Scheduler & Content Sourcing Engine
// Manages the full daily posting schedule:
// - Slices ProTeen original videos into 30-sec clips
// - Finds safe third-party motivational content (CC/public domain)
// - Schedules 16-20 posts per day across all platforms
// - Generates captions, hashtags, and watermark specs per post

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Platform definitions ───────────────────────────────────────────────────
const PLATFORMS = {
  tiktok:    { name: 'TikTok',           format: '9:16', maxSec: 60,  hashtagStyle: 'trending' },
  instagram: { name: 'Instagram Reels',  format: '9:16', maxSec: 90,  hashtagStyle: 'mixed' },
  youtube:   { name: 'YouTube Shorts',   format: '9:16', maxSec: 60,  hashtagStyle: 'descriptive' },
  facebook:  { name: 'Facebook Reels',   format: '9:16', maxSec: 90,  hashtagStyle: 'minimal' },
  x:         { name: 'X (Twitter)',      format: '16:9', maxSec: 140, hashtagStyle: 'minimal' },
};

// All clips go to all platforms
const ALL_PLATFORMS = Object.keys(PLATFORMS);

// ── Daily schedule template (16-20 posts) ─────────────────────────────────
// Times in 24hr format. Type determines what content to use.
const DAILY_SCHEDULE = [
  { time: '06:00', type: 'full_video',      platforms: ALL_PLATFORMS,                              label: 'Full daily message' },
  { time: '07:30', type: 'clip_hook',       platforms: ['tiktok','instagram','youtube'],            label: 'Opening hook clip' },
  { time: '08:30', type: 'clip_lesson',     platforms: ['tiktok','instagram','youtube','facebook'], label: 'Core lesson clip' },
  { time: '09:30', type: 'third_party',     platforms: ['tiktok','instagram','youtube'],            label: 'Curated motivational clip' },
  { time: '10:30', type: 'clip_quote',      platforms: ALL_PLATFORMS,                              label: 'Most quotable moment' },
  { time: '11:30', type: 'archive_clip',    platforms: ['tiktok','instagram','youtube'],            label: 'Archive best clip' },
  { time: '12:30', type: 'third_party',     platforms: ['tiktok','instagram','youtube','facebook'], label: 'Midday motivational' },
  { time: '13:30', type: 'clip_challenge',  platforms: ['tiktok','instagram','youtube'],            label: 'Teen challenge clip' },
  { time: '14:30', type: 'archive_clip',    platforms: ['tiktok','instagram','facebook'],           label: 'Archive throwback' },
  { time: '15:30', type: 'third_party',     platforms: ALL_PLATFORMS,                              label: 'Afternoon inspiration' },
  { time: '16:30', type: 'clip_emotional',  platforms: ['tiktok','instagram','youtube'],            label: 'Emotional peak clip' },
  { time: '17:30', type: 'archive_clip',    platforms: ['tiktok','instagram','youtube'],            label: 'Archive deep cut' },
  { time: '18:30', type: 'clip_closing',    platforms: ALL_PLATFORMS,                              label: 'Closing message clip' },
  { time: '19:30', type: 'third_party',     platforms: ['tiktok','instagram','youtube','facebook'], label: 'Evening motivation' },
  { time: '20:00', type: 'best_yesterday',  platforms: ALL_PLATFORMS,                              label: "Yesterday's best (reshare)" },
  { time: '21:00', type: 'archive_clip',    platforms: ['tiktok','instagram'],                     label: 'Late night archive clip' },
  { time: '22:00', type: 'third_party',     platforms: ['tiktok','instagram'],                     label: 'Night owl motivation' },
];

// ── Safe third-party content sources ──────────────────────────────────────
// All sources are Creative Commons, public domain, or explicitly allow reuse
const SAFE_CONTENT_SOURCES = [
  {
    name: 'TEDx Talks',
    type: 'youtube_cc',
    description: 'TEDx talks licensed under Creative Commons',
    searchQuery: 'TEDx teen motivation resilience school life site:youtube.com',
    license: 'CC BY-NC-ND',
    creditFormat: 'TEDx Talks',
  },
  {
    name: 'Motiversity',
    type: 'youtube_reuse',
    description: 'Popular motivational channel that allows clip sharing with credit',
    searchQuery: 'Motiversity motivational speech youth teens',
    license: 'reuse_allowed',
    creditFormat: '@Motiversity',
  },
  {
    name: 'Coach Pain',
    type: 'youtube_reuse',
    description: 'Motivational speaker content widely shared with credit',
    searchQuery: 'Coach Pain motivational speech young people',
    license: 'reuse_allowed',
    creditFormat: '@CoachPain',
  },
  {
    name: 'Public Domain Speeches',
    type: 'public_domain',
    description: 'Historic speeches in the public domain',
    searchQuery: 'JFK MLK public domain speech inspiration youth',
    license: 'public_domain',
    creditFormat: 'Public Domain',
  },
  {
    name: 'Pexels Videos',
    type: 'stock_video',
    description: 'Free royalty-free motivational b-roll footage',
    apiUrl: 'https://api.pexels.com/videos/search',
    searchQuery: 'teen motivation success achievement',
    license: 'royalty_free',
    creditFormat: 'Pexels',
  },
  {
    name: 'Pixabay Videos',
    type: 'stock_video',
    description: 'Free CC0 public domain video clips',
    apiUrl: 'https://pixabay.com/api/videos/',
    searchQuery: 'motivation inspiration youth',
    license: 'CC0',
    creditFormat: 'Pixabay',
  },
  {
    name: 'Internet Archive',
    type: 'archive',
    description: 'Public domain films and speeches',
    apiUrl: 'https://archive.org/advancedsearch.php',
    searchQuery: 'motivation inspiration youth public domain',
    license: 'public_domain',
    creditFormat: 'Internet Archive',
  },
];

// ── Step 1: Analyze video script to identify clip moments ─────────────────
async function identifyClipMoments(videoScript, videoTitle, videoDurationSecs) {
  const prompt = `You are a social media video editor for ProTeen Nation, a positive platform for teenagers.

Analyze this speech script and identify the 8 best 30-second clip moments for social media.

Video title: "${videoTitle}"
Estimated duration: ${videoDurationSecs} seconds
Full script:
---
${videoScript}
---

Identify exactly 8 clip moments. For each, provide:
1. The type: hook | lesson | quote | challenge | emotional | closing | highlight | inspiration
2. Approximate start percentage through the video (0-100)
3. The exact text that would be spoken in this 30-second window
4. Why this works as a standalone clip

Respond ONLY with valid JSON array:
[
  {
    "type": "hook",
    "startPercent": 0,
    "endPercent": 20,
    "scriptExcerpt": "exact words spoken in this clip...",
    "hookLine": "the very first sentence that grabs attention",
    "why": "starts with a bold statement that hooks immediately",
    "estimatedStartSec": 0,
    "estimatedEndSec": 30
  }
]`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('[Clips] Failed to identify clip moments:', err.message);
    return [];
  }
}

// ── Step 2: Generate caption + hashtags for each post ─────────────────────
async function generatePostCaption(clip, platform, isThirdParty = false, sourceCredit = null) {
  const platformInfo = PLATFORMS[platform];
  const hashtagCount = platform === 'x' ? 3 : platform === 'facebook' ? 5 : 12;

  const prompt = `Write a social media caption for ProTeen Nation for this clip.

Platform: ${platformInfo.name}
Hashtag style: ${platformInfo.hashtagStyle} (use ${hashtagCount} hashtags)
Clip type: ${clip.type}
Clip excerpt: "${clip.scriptExcerpt || clip.description || ''}"
Third-party content: ${isThirdParty ? 'Yes — credit: ' + sourceCredit : 'No — original ProTeen content'}

Requirements:
- Start with a powerful hook line (no "Introducing" or generic openers)
- Keep it punchy and teen-appropriate
- End with a call to action (follow, share, or comment)
- ${isThirdParty ? 'Include proper credit to ' + sourceCredit : 'Include "ProTeen Nation" branding'}
- Add ${hashtagCount} relevant hashtags on separate lines at the end
- Total length: ${platform === 'x' ? 'under 200 characters plus hashtags' : '100-150 words'}

Respond with ONLY the caption text, ready to copy-paste.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch (err) {
    console.error('[Clips] Caption generation failed:', err.message);
    return `${clip.hookLine || 'Watch this.'}\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation`;
  }
}

// ── Step 3: Generate watermark spec for each clip ─────────────────────────
function getWatermarkSpec(clip, isThirdParty, sourceCredit) {
  return {
    // ProTeen Nation branding always in corner
    logo: {
      position: 'top-right',
      text: 'ProTeen Nation',
      fontSize: 18,
      color: '#e8b84b',
      background: 'rgba(0,0,0,0.6)',
      padding: '6px 12px',
      borderRadius: '4px',
    },
    // Tagline at bottom
    tagline: {
      position: 'bottom-center',
      text: 'We Are The Future',
      fontSize: 14,
      color: 'rgba(255,255,255,0.8)',
    },
    // Credit overlay for third-party content
    ...(isThirdParty && {
      credit: {
        position: 'bottom-left',
        text: `Credit: ${sourceCredit}`,
        fontSize: 12,
        color: 'rgba(255,255,255,0.7)',
        background: 'rgba(0,0,0,0.5)',
        padding: '4px 8px',
      },
    }),
    // Subtle animated lower-third for ProTeen clips
    ...(!isThirdParty && {
      lowerThird: {
        position: 'bottom',
        text: 'proteennation.com',
        fontSize: 13,
        color: 'rgba(232,184,75,0.9)',
        animateIn: true,
        showAtSecond: 3,
      },
    }),
  };
}

// ── Step 4: Search for safe third-party content ────────────────────────────
async function findSafeThirdPartyContent(topic = 'motivation') {
  // Select a random safe source
  const source = SAFE_CONTENT_SOURCES[Math.floor(Math.random() * SAFE_CONTENT_SOURCES.length)];

  if (!process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY === 'YOUR_TAVILY_KEY_HERE') {
    // Return structured placeholder when Tavily isn't connected
    return {
      id: uuidv4(),
      type: 'third_party',
      source: source.name,
      license: source.license,
      creditFormat: source.creditFormat,
      title: `Motivational clip — ${source.name}`,
      description: `Inspiring content from ${source.name} on teen motivation and success`,
      url: null,
      status: 'placeholder — connect Tavily to find real content',
    };
  }

  try {
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: process.env.TAVILY_API_KEY,
      query: `${source.searchQuery} ${topic} creative commons reuse allowed`,
      search_depth: 'basic',
      max_results: 3,
    }, { timeout: 10000 });

    const results = response.data.results || [];
    if (!results.length) return null;

    // Verify with Claude that it's actually safe to use
    const result = results[0];
    const safety = await verifyCopyrightSafety(result, source);
    if (!safety.safe) return null;

    return {
      id: uuidv4(),
      type: 'third_party',
      source: source.name,
      license: source.license,
      creditFormat: source.creditFormat,
      title: safety.cleanTitle,
      description: safety.summary,
      url: result.url,
      clipDuration: 30,
      status: 'pending',
    };
  } catch (err) {
    console.error('[Clips] Third-party content search failed:', err.message);
    return null;
  }
}

// ── Step 5: Claude verifies copyright safety ───────────────────────────────
async function verifyCopyrightSafety(content, source) {
  const prompt = `You are a copyright compliance officer for a teen platform.

Evaluate whether this content is safe to use as a 30-second clip with proper credit:

Title: ${content.title}
URL: ${content.url}
Source type: ${source.type}
Expected license: ${source.license}
Preview: ${content.content?.slice(0, 300) || 'No preview'}

Rules — mark as UNSAFE if:
- Content appears to be from a major studio film or TV show
- Music appears to be copyrighted commercial music
- Content is from a major news network (CNN, Fox, NBC, etc.)
- Sports league footage (NFL, NBA, MLB, etc.)
- Content creator has not indicated reuse is allowed

Respond ONLY with JSON:
{
  "safe": true or false,
  "reason": "one sentence",
  "cleanTitle": "teen-friendly title for this clip",
  "summary": "one sentence description of what this clip shows"
}`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    return JSON.parse(msg.content[0].text.trim().replace(/```json|```/g, ''));
  } catch {
    return { safe: false, reason: 'Verification failed — defaulting to safe rejection' };
  }
}

// ── Step 6: Build full daily schedule ─────────────────────────────────────
async function buildDailySchedule(todaysVideo, archiveVideos = []) {
  console.log('[Scheduler] Building daily posting schedule...');
  const schedule = [];
  const today = new Date().toISOString().split('T')[0];

  // Identify clip moments from today's video script
  let clipMoments = [];
  if (todaysVideo?.script) {
    clipMoments = await identifyClipMoments(
      todaysVideo.script,
      todaysVideo.title,
      todaysVideo.durationSecs || 150
    );
    console.log(`[Scheduler] Identified ${clipMoments.length} clip moments from today's video`);
  }

  // Find archive clips
  const archiveClips = archiveVideos
    .flatMap(v => v.clips || [])
    .sort(() => Math.random() - 0.5); // Shuffle for variety

  let clipIndex = 0;
  let archiveIndex = 0;
  let thirdPartyCache = [];

  for (const slot of DAILY_SCHEDULE) {
    let content = null;

    if (slot.type === 'full_video') {
      content = {
        id: uuidv4(),
        type: 'full_video',
        videoId: todaysVideo?.id,
        title: todaysVideo?.title || "Today's Message",
        isFullVideo: true,
      };
    } else if (slot.type === 'best_yesterday') {
      // Pick the best performing clip from yesterday's archive
      const yesterday = archiveVideos[0];
      content = yesterday?.clips?.[0] ? {
        ...yesterday.clips[0],
        id: uuidv4(),
        type: 'best_yesterday',
        isReshare: true,
        originalDate: yesterday.date,
      } : null;
    } else if (slot.type === 'third_party') {
      // Use cached or fetch new
      if (!thirdPartyCache.length) {
        const found = await findSafeThirdPartyContent();
        if (found) thirdPartyCache.push(found);
      }
      content = thirdPartyCache.shift() || null;
    } else if (slot.type === 'archive_clip') {
      content = archiveClips[archiveIndex++ % Math.max(archiveClips.length, 1)] || null;
    } else {
      // ProTeen original clip
      const moment = clipMoments.find(m => m.type === slot.type.replace('clip_', ''))
        || clipMoments[clipIndex++ % Math.max(clipMoments.length, 1)];
      if (moment) {
        content = {
          id: uuidv4(),
          type: slot.type,
          videoId: todaysVideo?.id,
          ...moment,
          isOriginal: true,
        };
      }
    }

    if (!content) continue;

    // Generate captions and watermarks for each platform
    const isThirdParty = content.type === 'third_party';
    const platformPosts = [];

    for (const platform of slot.platforms) {
      const caption = await generatePostCaption(
        content, platform, isThirdParty, content.creditFormat
      );
      const watermark = getWatermarkSpec(content, isThirdParty, content.creditFormat);

      platformPosts.push({
        platform,
        platformName: PLATFORMS[platform].name,
        caption,
        watermark,
        format: PLATFORMS[platform].format,
        scheduledFor: `${today}T${slot.time}:00`,
        status: 'scheduled',
      });

      // Small delay to avoid Claude rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    schedule.push({
      id: uuidv4(),
      scheduledTime: slot.time,
      label: slot.label,
      content,
      platforms: platformPosts,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
    });
  }

  console.log(`[Scheduler] Built schedule with ${schedule.length} time slots, ${schedule.reduce((n, s) => n + s.platforms.length, 0)} total platform posts`);
  return schedule;
}

// ── Step 7: Get today's schedule summary ──────────────────────────────────
function getScheduleSummary(schedule) {
  const totalPosts = schedule.reduce((n, s) => n + s.platforms.length, 0);
  const byPlatform = {};
  schedule.forEach(slot => {
    slot.platforms.forEach(p => {
      byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
    });
  });

  return {
    totalSlots: schedule.length,
    totalPosts,
    byPlatform,
    firstPost: schedule[0]?.scheduledTime,
    lastPost: schedule[schedule.length - 1]?.scheduledTime,
    thirdPartyCount: schedule.filter(s => s.content?.type === 'third_party').length,
    originalCount: schedule.filter(s => s.content?.isOriginal).length,
    archiveCount: schedule.filter(s => s.content?.type === 'archive_clip').length,
  };
}

module.exports = {
  buildDailySchedule,
  identifyClipMoments,
  generatePostCaption,
  getWatermarkSpec,
  findSafeThirdPartyContent,
  getScheduleSummary,
  DAILY_SCHEDULE,
  PLATFORMS,
  SAFE_CONTENT_SOURCES,
};
