const { CLAUDE_SONNET, CLAUDE_HAIKU } = require('./aiModels');
// ProTeen Nation — Buffer Poster
// Posts daily videos and clips to all social media via Buffer GraphQL API
// Channels: Instagram, Facebook, X (Twitter), YouTube, TikTok

require('dotenv').config();
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    if (err.response) {
      throw new Error(`Buffer HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ── Buffer housekeeping helpers ────────────────────────────────────────────

async function fetchAllScheduledPosts() {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const query = `
    query GetPosts($input: PostsInput!, $first: Int, $after: String) {
      posts(input: $input, first: $first, after: $after) {
        edges { node { id dueAt channelId createdAt } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  let all = [], cursor = null;
  while (true) {
    const vars = { input: { organizationId: ORG_ID, filter: { status: ['scheduled'] } }, first: 100 };
    if (cursor) vars.after = cursor;
    const res = await axios.post(BUFFER_API,
      { query, variables: vars },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const data = res.data?.data;
    if (res.data?.errors) throw new Error(res.data.errors[0].message);
    all.push(...(data?.posts?.edges || []).map(e => e.node));
    const pi = data?.posts?.pageInfo;
    if (!pi?.hasNextPage) break;
    cursor = pi.endCursor;
  }
  return all;
}

async function deleteBufferPost(postId) {
  const token = process.env.BUFFER_ACCESS_TOKEN;
  const query = `
    mutation DeletePost($input: DeletePostInput!) {
      deletePost(input: $input) {
        ... on DeletePostSuccess { id }
        ... on VoidMutationError { message }
      }
    }
  `;
  const res = await axios.post(BUFFER_API,
    { query, variables: { input: { id: postId } } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return res.data?.data?.deletePost;
}

// Clear any already-scheduled posts that fall within 25 minutes of our target clip slots.
// Called before scheduling a fresh day's clips so old leftovers don't stack up.
async function clearStaleClipSlots(targetSlotTimes) {
  try {
    const existing = await fetchAllScheduledPosts();
    if (!existing.length) return 0;

    const targets = targetSlotTimes.map(t => new Date(t).getTime());
    const WINDOW_MS = 25 * 60 * 1000; // ±25 min window

    const toDelete = existing.filter(p => {
      const pt = new Date(p.dueAt).getTime();
      return targets.some(t => Math.abs(pt - t) <= WINDOW_MS);
    });

    let deleted = 0;
    for (const post of toDelete) {
      try {
        await deleteBufferPost(post.id);
        deleted++;
        console.log(`[Buffer] Cleared stale clip slot post ${post.id} @ ${post.dueAt}`);
      } catch (err) {
        console.warn(`[Buffer] Could not delete stale post ${post.id}:`, err.message);
      }
      await delay(300);
    }
    return deleted;
  } catch (err) {
    // Non-fatal — log and continue scheduling
    console.warn('[Buffer] clearStaleClipSlots failed (non-fatal):', err.message);
    return 0;
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

  // Generate video-specific hashtags from Claude once for the daily video
  console.log('[Buffer] Generating video-specific hashtags for daily post...');
  const dailyVideoTags = await generateVideoHashtags(video);
  console.log('[Buffer] Daily video tags:', dailyVideoTags.join(' '));

  // Platform-specific captions for the full daily video post
  const dailyIdx = new Date().getDay(); // rotate hashtag set by day of week
  const dailyCaptions = {
    instagram: `"${video.title}"\n\nToday's Daily Message — ProTeen Nation 🔥\n\n💾 Save this for the days you need it most.\n\n${getHashtagSet('instagram', dailyIdx, video.topic, dailyVideoTags)}`,
    facebook:  `"${video.title}"\n\nToday's Daily Message is here — and it's one you need to hear. 🔥\n\n👇 Tag a teen who needs this today.\n\nFollow ProTeen Nation for daily motivation built for the next generation.\n\n${getHashtagSet('facebook', dailyIdx, video.topic, dailyVideoTags)}`,
    youtube:   `"${video.title}"\n\nToday's Daily Message — watch it, share it, come back to it. 🔥\n\n🔔 Subscribe for new motivation every single day!\n\n${getHashtagSet('youtube', dailyIdx, video.topic, dailyVideoTags)}`,
  };

  console.log('[Buffer] Scheduling daily video', dueAt ? `at ${dueAt.toISOString()}` : '(add to queue)');
  const results = {};
  for (const [platform, channelId] of Object.entries(CHANNELS)) {
    if (CLIP_ONLY_CHANNELS.includes(platform)) {
      console.log(`[Buffer] Skipping full video for ${platform} (clip-only platform)`);
      results[platform] = { skipped: true, reason: 'clip-only platform' };
      continue;
    }
    const caption = dailyCaptions[platform] || dailyCaptions.instagram;
    results[platform] = await schedulePost({ channelId, text: caption, mediaUrl: video.videoUrl, dueAt: dueAt?.toISOString(), platform, videoTitle: video.title });
    await delay(600);
  }
  return results;
}

// ── Hashtag banks — rotated per post so no two posts look identical ────────
const HASHTAGS = {

  // TikTok — 25 tags, algorithm-optimized. First 5 carry the most weight.
  tiktok: [
    ['#ProTeenNation','#WeAreTheFuture','#fyp','#foryoupage','#viral',
     '#teen','#motivation','#teenlife','#inspire','#motivational',
     '#youthempowerment','#teenmotivation','#nextgeneration','#genz',
     '#dailymotivation','#successmindset','#growthmindset','#youngambitious',
     '#dreambig','#hardwork','#nevergiveup','#levelup','#mindset',
     '#positivevibes','#motivationaldaily'],
    ['#ProTeenNation','#WeAreTheFuture','#fyp','#foryoupage','#viral',
     '#teentok','#motivationdaily','#teeninspiration','#youngmindset',
     '#successhabits','#schoolmotivation','#youthleadership','#genzlife',
     '#selfimprovement','#teenmentalhealth','#buildingcharacter','#goaldigger',
     '#mindsetshift','#motivationalvideo','#inspirationalquotes','#staystrong',
     '#positivemindset','#teensuccess','#workhardplayhard','#bethechange'],
    ['#ProTeenNation','#WeAreTheFuture','#fyp','#foryoupage','#trending',
     '#motivate','#inspire','#youth','#teen','#genz',
     '#dailyinspiration','#motivationalquote','#successquotes','#selfgrowth',
     '#teenempowerment','#youngentrepreneur','#hustlehard','#neversettle',
     '#keepgoing','#focusonyourself','#believeinyourself','#makeithappen',
     '#potentialunlocked','#buildyourself','#teenmindset'],
  ],

  // Instagram — 28–30 tags, mix of mega/large/medium/niche for maximum discovery
  instagram: [
    ['#ProTeenNation','#WeAreTheFuture','#TeenMotivation','#Motivation',
     '#Teens','#YoungAndAmbitious','#TeenLife','#MotivationalSpeech',
     '#GrowthMindset','#BelieveInYourself','#YoungMinds','#TeenSuccess',
     '#DailyMotivation','#InspireYouth','#InspirationalVideo','#YoungLeaders',
     '#FutureIsNow','#ThinkBig','#KeepGoing','#NeverGiveUp','#SuccessMindset',
     '#Empowerment','#GenZ','#YouthEmpowerment','#Inspire','#SelfImprovement',
     '#PositiveMindset','#DailyInspiration'],
    ['#ProTeenNation','#WeAreTheFuture','#TeenInspiration','#MotivationDaily',
     '#YoungLeader','#TeenCoach','#SchoolMotivation','#NextGeneration',
     '#YoungMindset','#SuccessHabits','#CharacterBuilding','#TeenMentalHealth',
     '#YouthLeadership','#BuildYourself','#FocusOnYourself','#Resilience',
     '#SelfBelief','#WorkEthic','#DreamBig','#MakeItHappen','#MindsetShift',
     '#GoalDigger','#TeenEntrepreneur','#HardWork','#Discipline',
     '#BetterEveryDay','#Potential','#GenZLife'],
    ['#ProTeenNation','#WeAreTheFuture','#Motivation','#Teens','#GenZ',
     '#YouthEmpowerment','#InspirationalQuotes','#SuccessQuotes','#SelfGrowth',
     '#PositiveVibes','#DailyMotivation','#MindsetMatters','#NeverSettle',
     '#BeTheChange','#StayStrong','#Hustle','#TeenPower','#YoungAndHungry',
     '#FutureleadersOfAmerica','#AmericanYouth','#HighSchool','#College',
     '#StudentMotivation','#AcademicSuccess','#Leadership','#Purpose',
     '#YoungAndFocused','#KeepPushing'],
  ],

  // Facebook — 10–12 tags. FB reach is share-driven but tags still help discoverability.
  facebook: [
    ['#ProTeenNation','#WeAreTheFuture','#TeenMotivation','#YouthEmpowerment',
     '#DailyMotivation','#Teens','#GrowthMindset','#YoungLeaders',
     '#Inspire','#NextGeneration','#MotivationalVideo','#GenZ'],
    ['#ProTeenNation','#WeAreTheFuture','#TeenInspiration','#Motivation',
     '#SchoolLife','#YoungMinds','#BelieveInYourself','#CharacterBuilding',
     '#SuccessMindset','#NeverGiveUp','#YoungAndAmbitious','#TeenLife'],
    ['#ProTeenNation','#WeAreTheFuture','#DailyInspiration','#TeenSuccess',
     '#YouthLeadership','#GrowthMindset','#Resilience','#Discipline',
     '#FutureLeaders','#AmericanYouth','#HighSchool','#MotivationalSpeech'],
  ],

  // YouTube Shorts — 15 tags, mix of channel + content + topic discovery
  youtube: [
    ['#ProTeenNation','#WeAreTheFuture','#Shorts','#TeenMotivation',
     '#MotivationalSpeech','#YoungAndAmbitious','#GrowthMindset',
     '#DailyMotivation','#YouthEmpowerment','#Teens','#GenZ',
     '#SuccessMindset','#Inspire','#BelieveInYourself','#NextGeneration'],
    ['#ProTeenNation','#WeAreTheFuture','#Shorts','#TeenInspiration',
     '#YoungLeaders','#SchoolMotivation','#MotivationDaily','#Teens',
     '#CharacterBuilding','#NeverGiveUp','#Resilience','#Discipline',
     '#FutureLeaders','#GenZLife','#HighSchoolLife'],
    ['#ProTeenNation','#WeAreTheFuture','#Shorts','#DailyMotivation',
     '#TeenSuccess','#YouthLeadership','#MindsetMatters','#Hustle',
     '#KeepGoing','#DreamBig','#WorkEthic','#YoungEntrepreneur',
     '#PotentialUnlocked','#AmericanYouth','#MotivationalVideo'],
  ],

  // Topic-specific bonus tags — appended to base set
  topics: {
    resilience:    ['#Resilience','#MentalToughness','#BounceBack','#Grit','#Perseverance'],
    school:        ['#SchoolMotivation','#StudyTips','#AcademicSuccess','#HighSchool','#GradeUp'],
    relationships: ['#TeenRelationships','#Friendship','#HealthyRelationships','#SocialSkills','#Community'],
    faith:         ['#Faith','#Blessed','#Purpose','#Hope','#SpiritualGrowth'],
    sports:        ['#AthleteMindset','#SportsMotivation','#YoungAthlete','#TrainHard','#WinningMindset'],
    health:        ['#TeenHealth','#FitnessMotivation','#HealthyLifestyle','#MentalHealth','#Wellness'],
    careers:       ['#YoungEntrepreneur','#CareerGoals','#FutureLeader','#Ambition','#Success'],
    civics:        ['#YouthLeadership','#CivicEngagement','#BeTheChange','#Community','#FutureLeaders'],
  },
};

// Ask Claude to generate 6-8 hashtags specific to this video's actual content.
// Called once per video — result is reused across all clips and platforms.
async function generateVideoHashtags(video) {
  const title  = video.title  || '';
  const script = video.script ? video.script.slice(0, 600) : '';
  const topic  = video.topicName || video.topic || '';

  if (!title) return [];

  try {
    const msg = await anthropic.messages.create({
      model: CLAUDE_SONNET,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are a social media hashtag specialist for ProTeen Nation, a motivational platform for American teenagers.

Generate 8 hashtags that are SPECIFIC to this video's actual content — not generic motivation tags.
Focus on the specific theme, lesson, action, or emotion in this video.

Video title: "${title}"
Topic: ${topic}
Script excerpt: "${script}"

Rules:
- Each hashtag must relate directly to what THIS video is actually about
- No generic tags like #Motivation #Teen #GenZ (those are added separately)
- CamelCase, no spaces, no punctuation other than #
- Mix specific concepts (e.g. #OvercomingRejection) with searchable terms (e.g. #CollegePrep)
- Appropriate for teenagers aged 13-19

Respond with ONLY a JSON array of 8 hashtag strings, e.g.:
["#OvercomingFailure","#StudyHabits","#CollegeReady","#SelfDiscipline","#MorningRoutine","#AcademicSuccess","#MindOverMatter","#BuildingConfidence"]`,
      }],
    });

    const text = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const tags = JSON.parse(text);
    if (Array.isArray(tags)) return tags.slice(0, 8);
    return [];
  } catch (err) {
    console.error('[Hashtags] Claude generation failed:', err.message);
    return [];
  }
}

// Pick a rotating hashtag set — cycles through 3 banks so posts never look identical.
// videoTags: content-specific tags from Claude (generated once per video).
function getHashtagSet(platform, clipIndex, topicId, videoTags = []) {
  const bank        = HASHTAGS[platform] || HASHTAGS.instagram;
  const setIdx      = clipIndex % bank.length;
  const base        = bank[setIdx];
  const topicExtras = (HASHTAGS.topics[topicId] || []);
  const limits      = { tiktok: 25, instagram: 30, facebook: 12, youtube: 15, twitter: 4 };
  const limit       = limits[platform] || 25;

  // Priority order: base platform tags → video-specific tags → topic tags
  // Video-specific tags inserted after the first 5 platform tags so they appear early
  const firstFive = base.slice(0, 5);
  const rest      = base.slice(5);
  const merged    = [...new Set([...firstFive, ...videoTags, ...rest, ...topicExtras])].slice(0, limit);

  // Safety net: always guarantee at least 5 hashtags
  const FALLBACK = ['#ProTeenNation','#WeAreTheFuture','#TeenMotivation','#DailyMotivation','#YoungAndAmbitious'];
  const final = merged.length >= 5 ? merged : [...new Set([...merged, ...FALLBACK])].slice(0, limit);
  return final.join(' ');
}

// ── Platform-specific caption builder ─────────────────────────────────────
// Tailors caption, hashtags, and CTA for each platform's algorithm.
// Key insight: saves, comments, and shares are the top reach signals.
function buildPlatformCaption(baseCaption, platform, video, clipIndex = 0, videoTags = []) {
  const topicId  = video.topic || '';
  const hook     = baseCaption || `"${video.title}"`;
  const tags     = getHashtagSet(platform, clipIndex, topicId, videoTags);

  // Rotate CTAs so each clip feels fresh — saves + comments + shares cover all 3 algorithm signals
  const ctas = [
    '💾 Save this for when you need it most.',
    '👇 Tag someone who needs to hear this today.',
    '💬 Drop your biggest goal in the comments — let\'s go!',
    '🔁 Share this with someone who\'s going through it.',
    '🔥 Follow ProTeen Nation for your daily dose of motivation.',
    '💡 Save this — come back to it on your hardest day.',
  ];
  const cta = ctas[clipIndex % ctas.length];

  if (platform === 'tiktok') {
    return `${hook}\n\n${cta}\n\n${tags}`;

  } else if (platform === 'instagram') {
    return `${hook}\n\n${cta}\n\n${tags}`;

  } else if (platform === 'facebook') {
    return `${hook}\n\n${cta}\n\nFollow ProTeen Nation for daily motivation built for the next generation. 🔥\n\n${tags}`;

  } else if (platform === 'youtube') {
    return `${hook}\n\n${cta}\n\n🔔 Subscribe to ProTeen Nation — new motivation every single day!\n\n${tags}`;

  } else if (platform === 'twitter') {
    // X/Twitter: character-limited — 5 tags minimum
    const twitterTags = `#ProTeenNation #TeenMotivation #WeAreTheFuture #YoungAndAmbitious #DailyMotivation`;
    const base = `${hook}\n\n${cta}`;
    const full = `${base}\n\n${twitterTags}`;
    return full.length > 275 ? base.slice(0, 275 - twitterTags.length - 4) + '...\n\n' + twitterTags : full;
  }

  return `${hook}\n\n${tags}`;
}

// Schedule 6 clips at peak teen engagement times (Central time, research-backed)
// 6:30 AM  — early birds scrolling before school
// 11:45 AM — lunch break (peak mid-day scroll)
// 3:30 PM  — right after school, highest energy of the day
// 5:30 PM  — after homework/practice, unwinding
// 7:30 PM  — prime evening slot (consistently highest teen engagement across all platforms)
// 9:30 PM  — before-bed scroll
// If a time slot has already passed today, reschedules to next day
async function postClips(video, clips) {
  if (!clips?.length) { console.warn('[Buffer] No clips'); return []; }

  // Generate content-specific hashtags from Claude once — reused across all clips/platforms
  console.log('[Buffer] Generating video-specific hashtags...');
  const videoTags = await generateVideoHashtags(video);
  console.log('[Buffer] Video-specific tags:', videoTags.join(' '));

  // Peak teen engagement windows — Central time [hour, minute]
  const POST_TIMES_CENTRAL = [[6,30],[11,45],[15,30],[17,30],[19,30],[21,30]];
  const now = new Date();
  const month = now.getUTCMonth() + 1;
  const isCDT = month >= 4 && month <= 10;
  const centralOffsetHours = isCDT ? 5 : 6; // CDT=UTC-5, CST=UTC-6

  // Pre-compute all target slot times so we can clear stale posts first
  const slotTimes = [];
  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const [ch, cm] = POST_TIMES_CENTRAL[i];
    const utcH     = ch + centralOffsetHours;
    const dayOff   = utcH >= 24 ? 1 : 0;
    const [h, m]   = [utcH % 24, cm];
    let t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOff, h, m, 0));
    if (t.getTime() <= Date.now() + 60000) t = new Date(t.getTime() + 24 * 60 * 60 * 1000);
    slotTimes.push(t.toISOString());
  }

  // Clear any leftover posts from previous days in these exact time slots
  const cleared = await clearStaleClipSlots(slotTimes);
  if (cleared > 0) console.log(`[Buffer] Cleared ${cleared} stale posts from previous day(s)`);

  const results = [];

  for (let i = 0; i < Math.min(clips.length, 6); i++) {
    const clip      = clips[i];
    const [ch, cm]  = POST_TIMES_CENTRAL[i];
    const utcH      = ch + centralOffsetHours;
    const dayOff    = utcH >= 24 ? 1 : 0;
    const [h, m]    = [utcH % 24, cm];

    let slotTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOff, h, m, 0));
    if (slotTime.getTime() <= Date.now() + 60000) {
      slotTime = new Date(slotTime.getTime() + 24 * 60 * 60 * 1000);
      console.log(`[Buffer] Slot ${ch}:${cm < 10 ? '0'+cm : cm} Central passed — rescheduled to tomorrow`);
    }
    const dueAt = slotTime.toISOString();

    console.log(`[Buffer] Scheduling clip ${i + 1}/6 at ${slotTime.toISOString()} (${ch}:${cm < 10 ? '0'+cm : cm} Central)`);
    const clipResults = {};
    for (const [platform, channelId] of Object.entries(CHANNELS)) {
      // Build a caption tailored to each platform's algorithm and audience behavior
      const caption = buildPlatformCaption(clip.caption, platform, video, i, videoTags);
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
