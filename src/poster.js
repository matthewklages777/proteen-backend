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
  const res = await axios.post(BUFFER_API,
    { query: MUTATION, variables },
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (res.data.errors) throw new Error(res.data.errors[0].message);
  return res.data.data;
}

// Schedule a single post to one Buffer channel
async function schedulePost({ channelId, text, mediaUrl, dueAt }) {
  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: dueAt ? 'customScheduled' : 'addToQueue',
    ...(dueAt ? { dueAt } : {}),
    assets: mediaUrl ? [{ video: { url: mediaUrl } }] : [],
  };

  try {
    const data = await bufferQuery({ input });
    const result = data?.createPost;
    if (result?.post) {
      console.log(`[Buffer] ✅ Post ${result.post.id} | Due: ${result.post.dueAt}`);
      return { success: true, postId: result.post.id };
    }
    console.warn('[Buffer] Error:', result?.message);
    return { success: false, reason: result?.message };
  } catch (err) {
    console.error('[Buffer] schedulePost failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Post today's daily video to long-form channels at 6 AM CST (11:00 UTC CDT)
async function postDailyVideo(video) {
  if (!video?.videoUrl) { console.warn('[Buffer] No videoUrl'); return {}; }

  const now = new Date();
  const dueAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0)).toISOString();

  const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
  const caption  = `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation`;

  console.log('[Buffer] Scheduling daily video at', dueAt);
  const results = {};
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    if (CLIP_ONLY_CHANNELS.includes(platform)) {
      console.log(`[Buffer] Skipping full video for ${platform} (clip-only platform)`);
      results[platform] = { skipped: true, reason: 'clip-only platform' };
      continue;
    }
    results[platform] = await schedulePost({ channelId, text: caption, mediaUrl: video.videoUrl, dueAt });
    await delay(600);
  }
  return results;
}

// Schedule 6 clips throughout the day via Buffer
// CDT post times: 7:00, 10:00, 13:00, 16:00, 19:00, 22:00
// UTC (CDT +5):   12:00, 15:00, 18:00, 21:00, 00:00, 03:00
async function postClips(video, clips) {
  if (!clips?.length) { console.warn('[Buffer] No clips'); return []; }

  const POST_TIMES_UTC = ['12:00', '15:00', '18:00', '21:00', '00:00', '03:00'];
  const now = new Date();
  const results = [];

  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const clip   = clips[i];
    const [h, m] = POST_TIMES_UTC[i].split(':').map(Number);
    const dayOff = h < 6 ? 1 : 0; // 00:00 and 03:00 UTC are next calendar day
    const dueAt  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOff, h, m, 0)).toISOString();

    const topicTag = (video.topicName || '').replace(/[\s&]+/g, '').replace(/[^a-zA-Z]/g, '');
    const caption  = clip.caption || `"${video.title}" 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag}`;

    console.log(`[Buffer] Scheduling clip ${i + 1}/6 at ${POST_TIMES_UTC[i]} UTC to all channels`);
    const clipResults = {};
    for (const [platform, channelId] of Object.entries(CHANNELS)) {
      clipResults[platform] = await schedulePost({ channelId, text: caption, mediaUrl: clip.clipUrl, dueAt });
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
