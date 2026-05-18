// ProTeen Nation — Buffer Poster
// Posts daily videos and clips to all social media via Buffer API
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

async function bufferQuery(query, variables = {}) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) throw new Error('BUFFER_ACCESS_TOKEN not set in Railway variables');
  const res = await axios.post(BUFFER_API,
    { query, variables },
    { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  if (res.data.errors) throw new Error(res.data.errors[0].message);
  return res.data.data;
}

// Schedule a single post to one channel
async function schedulePost({ channelId, text, mediaUrl, scheduledAt }) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        post { id status scheduledAt }
        userFeedback { message type }
      }
    }`;

  const input = {
    organizationId: ORG_ID,
    channelId,
    text,
    scheduledAt,
    ...(mediaUrl ? { media: [{ url: mediaUrl, mediaType: 'video' }] } : {}),
  };

  try {
    const data = await bufferQuery(mutation, { input });
    const post     = data.createPost?.post;
    const feedback = data.createPost?.userFeedback;
    if (post) {
      console.log(`[Buffer] ✅ Scheduled post ${post.id} at ${scheduledAt}`);
      return { success: true, postId: post.id };
    }
    console.warn('[Buffer] Feedback:', feedback?.message);
    return { success: false, reason: feedback?.message };
  } catch (err) {
    console.error('[Buffer] schedulePost failed:', err.message);
    return { success: false, error: err.message };
  }
}

// Post today's daily video to ALL channels at 6 AM CST (11:00 UTC in CDT / 12:00 UTC standard)
async function postDailyVideo(video) {
  if (!video?.videoUrl) { console.warn('[Buffer] No videoUrl on video record'); return {}; }

  // 6:00 AM CST = 11:00 UTC (CDT, UTC-5, May–Nov) or 12:00 UTC (CST, UTC-6, Nov–Mar)
  const now = new Date();
  const scheduledAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 0, 0)).toISOString();

  const topicTag = (video.topicName || '').replace(/\s+&?\s*/g, '').replace(/[^a-zA-Z]/g, '');
  const caption  = `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #Motivation`;

  console.log('[Buffer] Scheduling daily video to all channels at', scheduledAt);
  const results = {};
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    results[platform] = await schedulePost({ channelId, text: caption, mediaUrl: video.videoUrl, scheduledAt });
    await delay(600);
  }
  console.log('[Buffer] Daily video scheduled:', results);
  return results;
}

// Post 6 clips spread throughout the day (CST)
// 7:30, 9:15, 11:45, 14:00, 16:30, 20:00 CST → UTC+5 (CDT): 12:30, 14:15, 16:45, 19:00, 21:30, 01:00
async function postClips(video, clips) {
  if (!clips?.length) { console.warn('[Buffer] No clips provided'); return []; }

  const POST_TIMES_UTC = ['12:30', '14:15', '16:45', '19:00', '21:30', '01:00'];
  const now = new Date();
  const results = [];

  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const clip   = clips[i];
    const [h, m] = POST_TIMES_UTC[i].split(':').map(Number);
    // For 01:00 UTC, that's next day
    const dayOffset = h < 5 ? 1 : 0;
    const schedAt   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, m, 0)).toISOString();

    const topicTag = (video.topicName || '').replace(/\s+&?\s*/g, '').replace(/[^a-zA-Z]/g, '');
    const caption  = clip.caption ||
      `"${video.title}" 🔥\n\n#ProTeenNation #WeAreTheFuture #TeenMotivation #${topicTag} #Teens #DailyMessage`;

    console.log(`[Buffer] Scheduling clip ${i + 1}/6 at ${POST_TIMES_UTC[i]} UTC to all channels`);
    const clipResults = {};
    for (const [platform, channelId] of Object.entries(CHANNELS)) {
      clipResults[platform] = await schedulePost({ channelId, text: caption, mediaUrl: clip.clipUrl, scheduledAt: schedAt });
      await delay(600);
    }
    results.push({ clip: i + 1, scheduledAt: schedAt, platforms: clipResults });
    await delay(1000);
  }

  console.log(`[Buffer] All ${results.length} clips scheduled`);
  return results;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { postDailyVideo, postClips, schedulePost, CHANNELS };
