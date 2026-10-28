const { CLAUDE_SONNET } = require('./aiModels');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { videoDB } = require('./videoDatabase');
const { renderVideo } = require('./videoRenderer');

// Charlie — natural young adult male, conversational, highly expressive
// Best ElevenLabs voice for teen motivational content
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'IKne3meq5aSn9XLyUdCD';
const ELEVENLABS_VOICE_NAME = 'Charlie';

const AUDIO_DIR = path.join(__dirname, '../data/audio');
const BACKEND_URL = process.env.BACKEND_URL || 'https://proteen-backend-production.up.railway.app';
const TOPIC_ROTATION = [
  { id: 'resilience', name: 'Resilience & Mindset' },
  { id: 'school', name: 'School & Academics' },
  { id: 'relationships', name: 'Relationships' },
  { id: 'faith', name: 'Faith & Spirituality' },
  { id: 'sports', name: 'Sports & Competition' },
  { id: 'health', name: 'Health & Fitness' },
  { id: 'careers', name: 'Careers & Ambition' },
];

async function generateSpeech(topic, recentTitles = []) {
  console.log('[Pipeline] Generating speech for topic:', topic.name);

  // Pull recent titles for this topic so AI avoids repeating them
  const recentForTopic = videoDB.getArchive(60)
    .filter(v => v.topic === topic.id)
    .slice(0, 4)
    .map(v => `"${v.title}" (${v.date})`);
  const avoidBlock = recentForTopic.length
    ? `\n\nDo NOT repeat these recent ${topic.name} speeches — choose a completely different angle, story, or opening hook:\n${recentForTopic.join('\n')}`
    : '';

  const avoidSection = recentTitles.length > 0
    ? `\n\nIMPORTANT: These speeches have already been given recently — do NOT repeat these angles, themes, or opening lines:\n${recentTitles.map((t, i) => `${i + 1}. "${t}"`).join('\n')}\n\nChoose a completely fresh angle, specific story, or unexpected entry point into this topic.`
    : '';

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  const prompt = `Today is ${today}. Write a powerful 2-minute motivational speech for teenagers about ${topic.name}.${avoidBlock}${avoidSection}

This speech will be read aloud by a voice AI — write for the EAR, not the eye. Use natural spoken language: contractions, short punchy sentences mixed with longer flowing thoughts. No essay phrasing. Speak directly to the teen using "you."

STRUCTURE (maximize watch-time retention in the 2-minute window):
1. HOOK (30-40 words): One explosive line — a bold question, a raw truth, or a specific challenge. Not generic. Stop them cold.
2. THE STORY (80-100 words): One brief, vivid scenario a teen could live. Use details. Create tension.
3. THE LESSON (80-100 words): The insight. Give it a name. Use an analogy. Be concrete.
4. THE CHALLENGE (30-40 words): One specific action they can take TODAY. Not vague — concrete.
5. THE CLOSE (20-30 words): Quiet, real, unforgettable. End with fire. Then: "New message tomorrow. ProTeen Nation."

STRICT LIMIT: 280-320 words. Every word must earn its place.

Return only the speech text, no section labels or headers.`;

  let rawScript = null;

  // Try Claude first
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      console.log('[Pipeline] Generating script with Claude...');
      const anthropic = new Anthropic({ apiKey: anthropicKey });
      const message = await anthropic.messages.create({
        model: CLAUDE_SONNET,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      rawScript = message.content[0].text.trim();
      console.log('[Pipeline] Script generated with Claude');
    } catch (err) {
      const msg = (err.message || '') + JSON.stringify(err.error || '');
      const isCredits = msg.includes('credit balance') || msg.includes('insufficient_quota') || msg.includes('too low');
      console.warn('[Pipeline] Claude script generation failed:', err.message);
      if (!isCredits) throw err;
      console.log('[Pipeline] Claude credits exhausted — falling back to GPT-4o...');
    }
  }

  // Fallback: OpenAI GPT-4o
  if (!rawScript) {
    const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!openaiKey) throw new Error('Claude credits exhausted and OPENAI_API_KEY is not set. Add it to Railway variables.');
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: openaiKey });
    console.log('[Pipeline] Generating script with GPT-4o...');
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    rawScript = completion.choices[0].message.content.trim();
    console.log('[Pipeline] Script generated with GPT-4o (fallback)');
  }

  // Hard enforce word limit — truncate at sentence boundary if over 340 words
  const words = rawScript.split(/\s+/);
  let script = rawScript;
  if (words.length > 340) {
    const sentences = rawScript.match(/[^.!?]+[.!?]+/g) || [rawScript];
    let trimmed = '';
    for (const s of sentences) {
      if ((trimmed + s).split(/\s+/).length > 330) break;
      trimmed += s;
    }
    script = trimmed.trim() || rawScript.slice(0, 1800);
    console.log(`[Pipeline] Script trimmed from ${words.length} to ${script.split(/\s+/).length} words`);
  }

  console.log('[Pipeline] Speech generated', script.split(/\s+/).length, 'words');
  return script;
}

async function generateAudio(script, videoId) {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const audioPath = path.join(AUDIO_DIR, videoId + '.mp3');

  // Try ElevenLabs first
  const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (elevenKey) {
    try {
      console.log(`[Pipeline] Generating audio with ElevenLabs ${ELEVENLABS_VOICE_NAME} (${ELEVENLABS_VOICE_ID})...`);
      const response = await axios.post(
        'https://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID,
        {
          text: script,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.28,        // lower = more expressive natural variation
            similarity_boost: 0.78, // higher = stays true to Charlie's voice character
            style: 0.68,            // higher = more dramatic/emotional delivery
            use_speaker_boost: true,
          },
        },
        { headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 60000 }
      );
      fs.writeFileSync(audioPath, response.data);
      console.log(`[Pipeline] Audio saved via ElevenLabs ${ELEVENLABS_VOICE_NAME}:`, audioPath);
      return audioPath;
    } catch (err) {
      const body = err.response?.data ? Buffer.from(err.response.data).toString('utf8') : '';
      console.warn('[Pipeline] ElevenLabs failed:', err.response?.status, body || err.message);
      console.log('[Pipeline] Falling back to OpenAI TTS...');
    }
  } else {
    console.warn('[Pipeline] ELEVENLABS_API_KEY not set — using OpenAI TTS fallback');
  }

  // Fallback: OpenAI TTS
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!openaiKey) throw new Error('ElevenLabs is unavailable and OPENAI_API_KEY is not set. Add it to Railway variables.');
  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: openaiKey });
  console.log('[Pipeline] Generating audio with OpenAI TTS (echo voice, tts-1-hd)...');

  const MAX_CHARS = 4000;
  const chunks = [];
  if (script.length <= MAX_CHARS) {
    chunks.push(script);
  } else {
    const sentences = script.match(/[^.!?]+[.!?]+/g) || [script];
    let current = '';
    for (const sentence of sentences) {
      if ((current + sentence).length > MAX_CHARS) {
        if (current) chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  console.log(`[Pipeline] Script split into ${chunks.length} TTS chunk(s)`);

  const buffers = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[Pipeline] Synthesizing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: 'echo',
      input: chunks[i],
      speed: 1.0,
    });
    buffers.push(Buffer.from(await mp3.arrayBuffer()));
  }

  const finalBuffer = Buffer.concat(buffers);
  fs.writeFileSync(audioPath, finalBuffer);
  console.log('[Pipeline] Audio saved via OpenAI TTS (echo/hd):', audioPath);
  return audioPath;
}

// Generate SEO-optimized YouTube title + description after script is written
async function generateYouTubeMeta(script, topic, year = new Date().getFullYear()) {
  const topicKeywords = {
    resilience:    'teen resilience, mental toughness teenager, growth mindset teens, how to be strong teenager, overcome failure teen',
    school:        'study tips high school, how to get good grades, teen academic success, high school motivation, student motivation',
    relationships: 'teen friendships advice, healthy relationships teenagers, peer pressure teens, how to make friends teen, teenage relationships',
    faith:         'teen spirituality, finding purpose teenager, faith and teens, meaning of life teenager, teen mindset purpose',
    sports:        'teen athlete motivation, high school sports mindset, sports leadership teens, youth athlete inspiration, teen sports psychology',
    health:        'teen mental health tips, healthy habits teenagers, teen wellness motivation, mental health teenager, teen self care',
    careers:       'teen career advice, future career teenager, teen entrepreneurship, high school success career, Gen Z career motivation',
    civics:        'teen community service, youth leadership, teens making a difference, high school leadership, Gen Z change makers',
  };
  const seeds = topicKeywords[topic.id] || `teen motivation, teenagers, ${topic.name.toLowerCase()}`;

  const prompt = `You are a YouTube SEO expert for "ProTeen Nation," a daily motivational channel for teenagers aged 13–19.

SPEECH (about ${topic.name}):
---
${script.slice(0, 1400)}
---

Generate the following. Study the speech carefully — the title and description must match what it's actually about.

1. YOUTUBE TITLE (50–65 characters):
   - Lead with the specific angle of THIS speech, not a generic topic name
   - Use question format OR "How to..." OR "Why..." — these get highest CTR
   - Include one high-traffic keyword: teen, teenager, teens, high school, or youth
   - End with " | ProTeen Nation" if it fits in 65 chars; otherwise omit
   - Example good titles: "Why Failing in High School Makes You Stronger | ProTeen Nation"
     "How to Build Real Confidence as a Teenager"
     "The One Mindset Every Teen Needs to Succeed"

2. YOUTUBE DESCRIPTION (280–320 words total):
   Line 1-2 (CRUCIAL — shows in search): Start with the most powerful sentence from the speech verbatim, then one sentence of what this video is really about. These lines decide clicks.

   Paragraph 2: 2-3 sentences on what this specific message teaches — use natural keyword phrases like "how to [topic] as a teenager" and "for teens who [situation from speech]."

   Section "📌 In This Video:": 3 bullet points — specific takeaways from THIS speech, not generic.

   Section "🔥 Subscribe": "Subscribe for a new motivational message every single day → ProTeen Nation"

   Section "📲 Connect":
   Website: https://proteennation.com
   Instagram: @proteennation
   TikTok: @proteennation

   Final hashtags (10, mix broad + niche): #ProTeenNation #TeenMotivation #Teens #${topic.name.replace(/[\s&]+/g,'')} #WeAreTheFuture #HighSchool #YoungPeople #GrowthMindset #${year} #TeenLife

3. YOUTUBE TAGS (500 chars max, comma-separated, no # symbols):
   Start with these proven seeds: ${seeds}
   Then add 8–12 more specific long-tail tags based on the speech content.
   Include: exact match (teen motivation), broad match (teenagers), related (youth inspiration), long-tail (how to be confident as a teenager).

Return ONLY valid JSON (no markdown):
{
  "youtubeTitle": "...",
  "youtubeDescription": "...",
  "youtubeTags": "tag1, tag2, tag3, ..."
}`;

  let text = null;
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const c = await openai.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    text = c.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
  } catch (err) {
    console.warn('[Pipeline] YouTube meta generation failed:', err.message);
  }

  try {
    if (text) return JSON.parse(text);
  } catch (e) {
    console.warn('[Pipeline] YouTube meta JSON parse failed:', e.message);
  }
  return null;
}

// Generate Facebook-optimized post caption for the daily video
async function generateFacebookCaption(script, topic) {
  const prompt = `You are a Facebook content strategist for ProTeen Nation, a daily motivational channel for teenagers.

Write a Facebook post caption for this motivational speech about "${topic.name}". Facebook's algorithm rewards posts that generate comments and shares in the first hour.

SPEECH:
---
${script.slice(0, 1000)}
---

Rules:
- Line 1: One powerful sentence pulled directly from the speech — the one that hits hardest. Make it the kind of line a parent would share to their teen's wall.
- Line 2: blank line
- Line 3-4: 1-2 sentences that set up WHY this message matters right now. Speak to PARENTS and TEENS both — they're both on Facebook.
- Line 5: blank line
- Line 6: Engagement hook — one of: "Tag a teen who needs to hear this 👇" OR "What's one thing from this message you're taking with you today?" OR "Share this with someone who's been struggling lately."
- Line 7: blank line
- Line 8: "Watch the full message 👆 | New video every day — ProTeen Nation"
- Line 9: blank line
- Line 10: 4-5 hashtags only (Facebook penalizes hashtag stuffing): #ProTeenNation #TeenMotivation #${topic.name.replace(/[\s&]+/g, '')} #Teens #Motivation

Return ONLY the caption text, nothing else.`;

  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const c = await openai.chat.completions.create({
      model: 'gpt-4o-mini', max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    return c.choices[0].message.content.trim();
  } catch (err) {
    console.warn('[Pipeline] Facebook caption generation failed:', err.message);
    return null;
  }
}

async function runDailyVideoPipeline(topicOverride) {
  console.log('[Pipeline] Starting daily video pipeline at', new Date().toLocaleString());

  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  const recentVideos = videoDB.getArchive(14);
  const recentTopicIds = recentVideos.map(v => v.topic);
  const recentTitles = recentVideos.map(v => v.title).filter(Boolean);

  let topic;
  if (topicOverride) {
    topic = TOPIC_ROTATION.find(t => t.id === topicOverride) || TOPIC_ROTATION[dayOfYear % TOPIC_ROTATION.length];
  } else {
    const recentThree = recentTopicIds.slice(0, 3);
    let idx = dayOfYear % TOPIC_ROTATION.length;
    for (let attempt = 0; attempt < TOPIC_ROTATION.length; attempt++) {
      const candidate = TOPIC_ROTATION[(idx + attempt) % TOPIC_ROTATION.length];
      if (!recentThree.includes(candidate.id)) { topic = candidate; break; }
    }
    topic = topic || TOPIC_ROTATION[dayOfYear % TOPIC_ROTATION.length];
  }

  if (!topicOverride) {
    const existing = videoDB.getTodayStrict();
    if (existing) { console.log('[Pipeline] Today video already exists:', existing.title); return existing; }
  }

  console.log('[Pipeline] Topic selected:', topic.name, '| Avoiding recent titles:', recentTitles.length);
  const videoId = uuidv4();
  const script = await generateSpeech(topic, recentTitles);
  const audioPath = await generateAudio(script, videoId);
  const rawTitle = script.split('.')[0].trim();
  const title = rawTitle.length <= 60 ? rawTitle : rawTitle.slice(0, 60).replace(/\s+\S*$/, '').trim();

  // Generate platform-optimized metadata (YouTube SEO + Facebook hook)
  const ytMeta = await generateYouTubeMeta(script, topic);
  if (ytMeta) console.log('[Pipeline] YouTube SEO title:', ytMeta.youtubeTitle);

  const fbCaption = await generateFacebookCaption(script, topic);

  const videoPath = await renderVideo(audioPath, { id: videoId, title, youtubeTitle: ytMeta?.youtubeTitle, topic: topic.id, topicName: topic.name });
  const videoUrl    = `${BACKEND_URL}/videos/${videoId}.mp4`;
  const thumbUrl    = `${BACKEND_URL}/videos/${videoId}_thumb.jpg`;
  const videoRecord = {
    id: videoId,
    date: new Date().toISOString().split('T')[0],
    topic: topic.id,
    topicName: topic.name,
    title,
    youtubeTitle: ytMeta?.youtubeTitle || null,
    youtubeDescription: ytMeta?.youtubeDescription || null,
    youtubeTags: ytMeta?.youtubeTags || null,
    facebookCaption: fbCaption || null,
    thumbnailUrl: thumbUrl,
    script,
    audioPath,
    videoPath,
    videoUrl,
    status: 'ready',
    durationSecs: Math.ceil(script.split(' ').length / 2.5),
    generatedAt: new Date().toISOString(),
    voiceName: ELEVENLABS_VOICE_NAME,
    voiceId: ELEVENLABS_VOICE_ID,
  };
  videoDB.saveVideo(videoRecord);
  console.log('[Pipeline] Video pipeline complete:', videoRecord.title);
  return videoRecord;
}

async function testPipeline() {
  console.log('[Pipeline] Running test...');
  try {
    const script = await generateSpeech(TOPIC_ROTATION[0]);
    console.log('[Pipeline] Speech generation working');
    console.log('[Pipeline] First line:', script.split('\n')[0]);
    const elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
    if (!elevenKey) {
      console.log('[Pipeline] ElevenLabs key not set');
    } else {
      const testId = 'test-' + Date.now();
      const audioPath = await generateAudio('ProTeen Nation. You are the future. This is a voice test.', testId);
      console.log('[Pipeline] Audio generation working');
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
    console.log('[Pipeline] All systems go! Ready for automated daily videos.');
  } catch (err) {
    console.error('[Pipeline] Test failed:', err.message);
  }
}

module.exports = { runDailyVideoPipeline, testPipeline, generateSpeech, generateAudio };
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === 'test') {
    testPipeline().then(() => process.exit(0)).catch(() => process.exit(1));
  } else {
    runDailyVideoPipeline().then(function(v) { console.log('Done:', v.title); process.exit(0); }).catch(function(err) { console.error(err); process.exit(1); });
  }
}
