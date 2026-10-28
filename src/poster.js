// ProTeen Nation — Buffer Poster
// Posts daily videos and clips to all social media via Buffer GraphQL API
// Channels: Instagram, Facebook, X (Twitter), YouTube

require('dotenv').config();
const axios = require('axios');

const BUFFER_API = 'https://api.buffer.com/graphql';
const ORG_ID     = '6a0b4a9276619973c3a551a3';

// Channel IDs from Buffer account (matthewklages@me.com)
// TikTok excluded — Buffer cannot auto-publish video to TikTok (API restriction).
// TikTok clip URLs are logged after each run for manual posting.
const CHANNELS = {
  instagram: '6a0b4e78090476fb99332860',
  facebook:  '6a0b4f23090476fb99332b0f',
  twitter:   '6a0b5011090476fb99332ec0',
  youtube:   '6a0b5135090476fb993332bc',
};

// Instagram and X/Twitter are short-form platforms — only receive clips, not the full daily video.
// Instagram reels max is 90s; the full daily speech (~110s) would appear right before clip 1 (1h later),
// making it look like the same video posted twice to followers.
const CLIP_ONLY_CHANNELS = ['instagram', 'twitter'];

const MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess { post { id status dueAt } }
      ... on InvalidInputError  { message }
      ... on UnexpectedError    { message }
      ... on LimitReachedError  { message }
    }
  }`;

async function bufferQuery(variables) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not set in Railway variables');
  const res = await axios.post(BUFFER_API,
    { query: MUTATION, variables },
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (res.data.errors) throw new Error(res.data.errors[0].message);
  return res.data.data;
}

// Platform-specific metadata required by Buffer API
// metadata must be nested under the platform key
// isClip: clips are short enough for Facebook Reels (≤90s); daily videos are not
function getPlatformMetadata(platform, title, isClip = false, ytTitle = null) {
  const youtubeTitle = isClip
    ? `${(title || 'ProTeen Nation').slice(0, 80)} #Shorts`
    : ((ytTitle || title || 'ProTeen Nation Daily').slice(0, 100));
  switch (platform) {
    case 'instagram': return { instagram: { type: 'reel', shouldShareToFeed: true } };
    case 'facebook':  return isClip ? { facebook: { type: 'reel' } } : { facebook: { type: 'post' } };
    case 'youtube':   return { youtube: { title: youtubeTitle, categoryId: '27' } };
    default:          return {};
  }
}

// Schedule a single post to one Buffer channel
async function schedulePost({ channelId, platform, text, mediaUrl, dueAt, title, isClip = false, ytTitle = null }) {
  const inFuture = dueAt && new Date(dueAt).getTime() > Date.now() + 60000;
  const metadata = getPlatformMetadata(platform, title, isClip, ytTitle);

  const base = {
    channelId,
    text,
    assets: mediaUrl ? [{ video: { url: mediaUrl } }] : [],
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  // Buffer CreatePostInput requires both 'schedulingType' AND 'mode'.
  // SchedulingType enum has only: 'automatic' (Buffer publishes) | 'notification' (manual/TikTok)
  // Mode controls timing: 'customScheduled' + dueAt = specific time, 'addToQueue' = Buffer picks time.
  const input = inFuture
    ? { ...base, schedulingType: 'automatic', mode: 'customScheduled', dueAt }
    : { ...base, schedulingType: 'automatic', mode: 'addToQueue' };

  console.log(`[Buffer] Posting to ${platform} (${channelId}) | ${inFuture ? `scheduled ${dueAt}` : 'add to queue'}`);

  try {
    const data = await bufferQuery({ input });
    const result = data?.createPost;
    if (result?.post) {
      console.log(`[Buffer] ✅ ${platform} | Post ${result.post.id} | Due: ${result.post.dueAt || 'queued'}`);
      return { success: true, postId: result.post.id, dueAt: result.post.dueAt };
    }
    // Buffer returned an error type (InvalidInputError, LimitReachedError, etc.)
    console.error(`[Buffer] ❌ ${platform} rejected: ${result?.message || 'unknown error'} | input: ${JSON.stringify(input)}`);
    return { success: false, reason: result?.message };
  } catch (err) {
    console.error(`[Buffer] ❌ ${platform} request failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Build the YouTube description — use AI-generated one if available, otherwise a rich fallback
function buildYouTubeDescription(video) {
  if (video.youtubeDescription) return video.youtubeDescription;
  const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
  const year = new Date().getFullYear();
  return `${video.title}\n\nA powerful daily motivational message for teenagers from ProTeen Nation. This speech is part of our daily series helping teens build confidence, resilience, and a winning mindset.\n\n🔥 Subscribe for daily teen motivation → ProTeen Nation\n\n💪 What You'll Get From This Channel:\n• Daily motivational speeches designed for teens\n• Real talk about ${video.topicName || 'mindset and growth'}\n• Practical advice teens can act on today\n\n📲 Follow Us:\nWebsite: https://proteennation.com\nInstagram: @proteennation\nTikTok: @proteennation\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation #${year} #GrowthMindset #YoungPeople #TeenLife`;
}

// Post today's daily video to long-form channels at 6 AM CST (11:00 UTC)
async function postDailyVideo(video) {
  if (!video?.videoUrl) { console.warn('[Buffer] No videoUrl'); return {}; }

  const now = new Date();
  let dueAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0));
  if (dueAt.getTime() <= Date.now() + 60000) {
    dueAt = null;
    console.log('[Buffer] 11:00 UTC slot passed — adding daily video to queue');
  }

  const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
  const facebookCaption = `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation`;
  const youtubeCaption  = buildYouTubeDescription(video);

  console.log('[Buffer] Scheduling daily video', dueAt ? `at ${dueAt.toISOString()}` : '(add to queue)');
  if (video.youtubeTitle) console.log('[Buffer] YouTube SEO title:', video.youtubeTitle);

  const results = {};
  let passed = 0, failed = 0;
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    if (CLIP_ONLY_CHANNELS.includes(platform)) {
      console.log(`[Buffer] Skipping full video for ${platform} (clip-only platform)`);
      results[platform] = { skipped: true, reason: 'clip-only platform' };
      continue;
    }
    const text = platform === 'youtube' ? youtubeCaption : facebookCaption;
    results[platform] = await schedulePost({ channelId, platform, text, mediaUrl: video.videoUrl, dueAt: dueAt?.toISOString(), title: video.title, ytTitle: video.youtubeTitle });
    results[platform].success ? passed++ : failed++;
    await delay(600);
  }
  console.log(`[Buffer] Daily video done — ${passed} posted, ${failed} failed`);
  return results;
}

// Schedule 6 clips at peak engagement times for teen audience (CDT = UTC-5)
// 7:00 AM, 11:30 AM, 3:30 PM, 5:30 PM, 8:00 PM, 10:00 PM CDT
// UTC: 12:00, 16:30, 20:30, 22:30, 01:00, 03:00
async function postClips(video, clips) {
  if (!clips?.length) { console.warn('[Buffer] No clips'); return []; }

  const POST_TIMES_UTC = ['12:00', '16:30', '20:30', '22:30', '01:00', '03:00'];
  const now = new Date();
  const results = [];

  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const clip   = clips[i];
    const [h, m] = POST_TIMES_UTC[i].split(':').map(Number);
    const dayOff = h < 6 ? 1 : 0; // 01:00 and 03:00 UTC are next calendar day

    let slotTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOff, h, m, 0));
    if (slotTime.getTime() <= Date.now() + 60000) {
      slotTime = new Date(slotTime.getTime() + 24 * 60 * 60 * 1000);
      console.log(`[Buffer] Slot ${POST_TIMES_UTC[i]} UTC passed — rescheduled to tomorrow`);
    }
    const dueAt = slotTime.toISOString();

    const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
    const baseCaption = clip.caption || `"${video.title}" 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag}`;

    console.log(`[Buffer] Scheduling clip ${i + 1}/6 at ${slotTime.toISOString()}`);
    const clipResults = {};
    let passed = 0, failed = 0;
    for (const [platform, channelId] of Object.entries(CHANNELS)) {
      const caption = platform === 'youtube' ? `${baseCaption}\n#Shorts` : baseCaption;
      clipResults[platform] = await schedulePost({ channelId, platform, text: caption, mediaUrl: clip.clipUrl, dueAt, title: video.title, isClip: true, ytTitle: video.youtubeTitle });
      clipResults[platform].success ? passed++ : failed++;
      await delay(600);
    }
    console.log(`[Buffer] Clip ${i + 1} done — ${passed} posted, ${failed} failed`);
    results.push({ clip: i + 1, dueAt, platforms: clipResults });
    await delay(1000);
  }

  console.log(`[Buffer] All ${results.length} clips scheduled ✅`);
  console.log('[TikTok] Manual posting required — clip URLs:');
  clips.forEach((c, idx) => console.log(`  Clip ${idx + 1}: ${c.clipUrl}`));
  return results;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { postDailyVideo, postClips, schedulePost, CHANNELS };
