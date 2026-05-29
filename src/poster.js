// ProTeen Nation — Buffer Poster
// Posts daily videos and clips to all social media via Buffer GraphQL API
// Channels: Instagram, Facebook, X (Twitter), YouTube, TikTok

require('dotenv').config();
const axios = require('axios');

const BUFFER_API = 'https://api.buffer.com/graphql';
const ORG_ID     = '6a0b4a9276619973c3a551a3';

// Channel IDs from Buffer account (matthewklages@me.com)
const CHANNELS = {
  instagram: '6a0b4e78090476fb99332860',
  facebook:  '6a0b4f23090476fb99332b0f',
  twitter:   '6a0b5011090476fb99332ec0',
  youtube:   '6a0b5135090476fb993332bc',
  tiktok:    '6a0b5260090476fb9933368f',
};

// X/Twitter & TikTok have short video limits — only receive clips, not full video
const CLIP_ONLY_CHANNELS = ['twitter', 'tiktok'];

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
  try {
    const res = await axios.post(BUFFER_API,
      { query: MUTATION, variables },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    if (res.data.errors) throw new Error(res.data.errors[0].message);
    return res.data.data;
  } catch (err) {
    // Expose the full response body so we can see Buffer's actual error
    if (err.response) {
      throw new Error(`Buffer HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// Schedule a single post to one Buffer channel
// If dueAt is in the past (or not provided), falls back to adding to Buffer queue
async function schedulePost({ channelId, text, mediaUrl, dueAt, platform, videoTitle, isClip = false }) {
  const inFuture = dueAt && new Date(dueAt).getTime() > Date.now() + 60000; // must be >1 min future
  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: inFuture ? 'customScheduled' : 'addToQueue',
    ...(inFuture ? { dueAt } : {}),
    assets: mediaUrl ? [{ video: { url: mediaUrl } }] : [],
  };

  // Platform-specific metadata (required by Buffer GraphQL API)
  // isClip: true means this is a short clip (≤60s) eligible for Shorts/Reels
  const ytTitle = videoTitle ? videoTitle.slice(0, 100) : text.split('\n')[0].slice(0, 100);
  if (platform === 'instagram') {
    // Reels support up to 15 min — shouldShareToFeed is required
    input.metadata = { instagram: { type: 'reel', shouldShareToFeed: true } };
  } else if (platform === 'facebook') {
    // Full video (>90s) must use 'post' type — Reels are 90s max
    // For clips (≤90s), caller should pass isClip: true
    input.metadata = { facebook: { type: isClip ? 'reel' : 'post' } };
  } else if (platform === 'youtube') {
    // Shorts limit is 3 min — skip full video for YouTube, only clips work as Shorts
    if (!isClip) return { skipped: true, reason: 'Full video too long for YouTube Shorts — post clips instead' };
    input.metadata = { youtube: { title: ytTitle, categoryId: '24' } };
  } else if (platform === 'tiktok') {
    input.metadata = { tiktok: {} };
  }

  try {
    const data = await bufferQuery({ input });
    const result = data?.createPost;
    if (result?.post) {
      console.log(`[Buffer] ✅ Post ${result.post.id} | Due: ${result.post.dueAt || 'queued'}`);
      return { success: true, postId: result.post.id, dueAt: result.post.dueAt };
    }
    console.warn('[Buffer] Error:', result?.message);
    return { success: false, reason: result?.message };
  } catch (err) {
    console.error('[Buffer] schedulePost failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Post today's daily video to long-form channels at 6 AM Central time
// CDT (Mar–Nov) = UTC-5 → 11:00 UTC  |  CST (Nov–Mar) = UTC-6 → 12:00 UTC
// If that slot has already passed today, adds to Buffer queue instead
async function postDailyVideo(video) {
  if (!video?.videoUrl) { console.warn('[Buffer] No videoUrl'); return {}; }

  const now = new Date();
  // Detect UTC offset for Central time (CDT = -5, CST = -6)
  // Simple DST check: CDT runs second Sunday in March through first Sunday in November
  const month = now.getUTCMonth() + 1; // 1-12
  const isCDT = month >= 4 && month <= 10; // rough but accurate for scheduling purposes
  const centralOffsetHours = isCDT ? 5 : 6;  // hours behind UTC
  const targetUTCHour = 6 + centralOffsetHours; // 6 AM Central → 11 or 12 UTC
  // Target 6:00 AM Central; if past, use tomorrow
  let dueAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUTCHour, 0, 0));
  if (dueAt.getTime() <= Date.now() + 60000) {
    // Already passed today — add to queue (Buffer picks next available slot)
    dueAt = null;
    console.log('[Buffer] 11:00 UTC slot passed — adding daily video to queue');
  }

  const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
  const caption  = `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation`;

  console.log('[Buffer] Scheduling daily video', dueAt ? `at ${dueAt.toISOString()}` : '(add to queue)');
  const results = {};
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    if (CLIP_ONLY_CHANNELS.includes(platform)) {
      console.log(`[Buffer] Skipping full video for ${platform} (clip-only platform)`);
      results[platform] = { skipped: true, reason: 'clip-only platform' };
      continue;
    }
    results[platform] = await schedulePost({ channelId, text: caption, mediaUrl: video.videoUrl, dueAt: dueAt?.toISOString(), platform, videoTitle: video.title });
    await delay(600);
  }
  return results;
}

// Schedule 6 clips at peak engagement times for teen audience (Central time)
// 7:00 AM  — morning phone check before school
// 11:30 AM — lunch break scroll
// 3:30 PM  — just out of school, high energy
// 5:30 PM  — after-school wind-down
// 8:00 PM  — prime evening scroll (highest teen engagement)
// 10:00 PM — before bed (teens stay up late)
// If a time slot has already passed today, reschedules to next day
async function postClips(video, clips) {
  if (!clips?.length) { console.warn('[Buffer] No clips'); return []; }

  // Central times for each clip slot — stored as [hour, minute] in Central time
  const POST_TIMES_CENTRAL = [[7,0],[11,30],[15,30],[17,30],[20,0],[22,0]];
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const isCDT = month >= 4 && month <= 10;
  const centralOffsetHours = isCDT ? 5 : 6; // CDT=UTC-5, CST=UTC-6

  const results = [];

  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const clip   = clips[i];
    const [ch, cm] = POST_TIMES_CENTRAL[i];
    const utcH = ch + centralOffsetHours; // convert Central hour to UTC
    // Hours ≥ 24 wrap to next day
    const dayOff = utcH >= 24 ? 1 : 0;
    const [h, m] = [utcH % 24, cm];

    let slotTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOff, h, m, 0));
    // If slot is already in the past, push it to the next day
    if (slotTime.getTime() <= Date.now() + 60000) {
      slotTime = new Date(slotTime.getTime() + 24 * 60 * 60 * 1000);
      console.log(`[Buffer] Slot ${POST_TIMES_UTC[i]} UTC passed — rescheduled to tomorrow`);
    }
    const dueAt = slotTime.toISOString();

    const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
    const fullCaption   = clip.caption || `"${video.title}" 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag}`;
    // Twitter/X hard limit is 280 characters — truncate with ellipsis if needed
    const twitterCaption = fullCaption.length > 275 ? fullCaption.slice(0, 272) + '...' : fullCaption;

    console.log(`[Buffer] Scheduling clip ${i + 1}/6 at ${slotTime.toISOString()} to all channels`);
    const clipResults = {};
    for (const [platform, channelId] of Object.entries(CHANNELS)) {
      const caption = platform === 'twitter' ? twitterCaption : fullCaption;
      clipResults[platform] = await schedulePost({ channelId, text: caption, mediaUrl: clip.clipUrl, dueAt, platform, videoTitle: video.title, isClip: true });
      await delay(600);
    }
    results.push({ clip: i + 1, dueAt, platforms: clipResults });
    await delay(1000);
  }

  console.log(`[Buffer] All ${results.length} clips scheduled ✅`);
  return results;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { postDailyVideo, postClips, schedulePost, CHANNELS };
