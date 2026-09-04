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

// X/Twitter has a short video limit — only receives clips, not the full daily video
const CLIP_ONLY_CHANNELS = ['twitter'];

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
async function schedulePost({ channelId, platform, text, mediaUrl, dueAt }) {
  const inFuture = dueAt && new Date(dueAt).getTime() > Date.now() + 60000;

  const input = inFuture
    ? {
        // Custom scheduled: provide exact time, no schedulingType (they conflict)
        channelId,
        text,
        mode: 'customScheduled',
        dueAt,
        assets: mediaUrl ? [{ video: { url: mediaUrl } }] : [],
      }
    : {
        // Add to queue: Buffer picks the next available slot
        channelId,
        text,
        schedulingType: 'automatic',
        mode: 'addToQueue',
        assets: mediaUrl ? [{ video: { url: mediaUrl } }] : [],
      };

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
  const caption  = `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation`;

  console.log('[Buffer] Scheduling daily video', dueAt ? `at ${dueAt.toISOString()}` : '(add to queue)');
  const results = {};
  let passed = 0, failed = 0;
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    if (CLIP_ONLY_CHANNELS.includes(platform)) {
      console.log(`[Buffer] Skipping full video for ${platform} (clip-only platform)`);
      results[platform] = { skipped: true, reason: 'clip-only platform' };
      continue;
    }
    results[platform] = await schedulePost({ channelId, platform, text: caption, mediaUrl: video.videoUrl, dueAt: dueAt?.toISOString() });
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
      clipResults[platform] = await schedulePost({ channelId, platform, text: caption, mediaUrl: clip.clipUrl, dueAt });
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
