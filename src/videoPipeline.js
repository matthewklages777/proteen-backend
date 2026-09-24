const { CLAUDE_SONNET, CLAUDE_HAIKU } = require('./aiModels');
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { videoDB } = require('./videoDatabase');
const { renderVideo } = require('./videoRenderer');
// Adam — deep, confident, natural American male. Best for motivational content.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
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

  const avoidSection = recentTitles.length > 0
    ? `\n\nIMPORTANT: These speeches have already been given recently — do NOT repeat these angles, themes, or opening lines:\n${recentTitles.map((t, i) => `${i + 1}. "${t}"`).join('\n')}\n\nChoose a completely fresh angle, specific story, or unexpected entry point into this topic.`
    : '';

  const prompt = `Write a motivational speech for American teenagers about ${topic.name}. STRICT LIMIT: 280-320 words maximum — this must be exactly 2 minutes when spoken aloud. Open with a bold, unexpected attention-grabbing line. Speak directly using "you". Build emotional momentum — grounded start, rise to passion, quiet truth, finish with fire. One concrete action they can take today. Short punchy sentences at peak moments. Unforgettable closing line. Return only the speech text, no titles or labels.${avoidSection}`;

  let rawScript = null;

  // Try Claude first
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      console.log('[Pipeline] Generating script with Claude...');
      const anthropic = new Anthropic({ apiKey: anthropicKey });
      const message = await anthropic.messages.create({
        model: CLAUDE_SONNET,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      rawScript = message.content[0].text.trim();
      console.log('[Pipeline] Script generated with Claude');
    } catch (err) {
      const msg = (err.message || '') + JSON.stringify(err.error || '');
      const isCredits = msg.includes('credit balance') || msg.includes('insufficient_quota') || (err.status === 400 && msg.includes('billing'));
      console.warn('[Pipeline] Claude script generation failed:', err.message);
      if (!isCredits) throw err; // only fall through on credits/billing errors
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
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    rawScript = completion.choices[0].message.content.trim();
    console.log('[Pipeline] Script generated with GPT-4o (fallback)');
  }

  // Hard enforce word limit — truncate at sentence boundary if over 350 words
  const words = rawScript.split(/\s+/);
  let script = rawScript;
  if (words.length > 350) {
    const sentences = rawScript.match(/[^.!?]+[.!?]+/g) || [rawScript];
    let trimmed = '';
    for (const s of sentences) {
      if ((trimmed + s).split(/\s+/).length > 340) break;
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
      console.log('[Pipeline] Generating audio with ElevenLabs Frank...');
      const response = await axios.post(
        'https://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID,
        { text: script, model_id: 'eleven_turbo_v2_5', voice_settings: { stability: 0.55, similarity_boost: 0.80, style: 0.45, use_speaker_boost: true } },
        { headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 60000 }
      );
      fs.writeFileSync(audioPath, response.data);
      console.log('[Pipeline] Audio saved via ElevenLabs:', audioPath);
      return audioPath;
    } catch (err) {
      const body = err.response?.data ? Buffer.from(err.response.data).toString('utf8') : '';
      console.warn('[Pipeline] ElevenLabs failed:', err.response?.status, body || err.message);
      console.log('[Pipeline] Falling back to OpenAI TTS...');
    }
  }

  // Fallback: OpenAI TTS
  const openaiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!openaiKey) throw new Error('ElevenLabs is out of credits and OPENAI_API_KEY is not set. Add it to Railway variables.');
  const { OpenAI } = require('openai');
  const openai = new OpenAI({ apiKey: openaiKey });
  console.log('[Pipeline] Generating audio with OpenAI TTS (onyx voice)...');

  // OpenAI TTS has a 4096-character limit — chunk long scripts and concatenate
  const MAX_CHARS = 4000;
  const chunks = [];
  if (script.length <= MAX_CHARS) {
    chunks.push(script);
  } else {
    // Split on sentence boundaries to avoid cutting mid-sentence
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
      model: 'tts-1',
      voice: 'onyx',
      input: chunks[i],
      speed: 1.0,
    });
    buffers.push(Buffer.from(await mp3.arrayBuffer()));
  }

  // Concatenate all MP3 buffers (MP3 frames are self-contained — simple concat works)
  const finalBuffer = Buffer.concat(buffers);
  fs.writeFileSync(audioPath, finalBuffer);
  console.log('[Pipeline] Audio saved via OpenAI TTS:', audioPath);
  return audioPath;
}
async function runDailyVideoPipeline(topicOverride) {
  console.log('[Pipeline] Starting daily video pipeline at', new Date().toLocaleString());

  // Use day-of-year (0-364) so the same topic never falls on the same weekday every week
  const now = new Date();
  const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);

  // Pull recent video history to avoid repeating topics or speech angles
  const recentVideos = videoDB.getArchive(14);
  const recentTopicIds = recentVideos.map(v => v.topic);
  const recentTitles = recentVideos.map(v => v.title).filter(Boolean);

  let topic;
  if (topicOverride) {
    topic = TOPIC_ROTATION.find(t => t.id === topicOverride) || TOPIC_ROTATION[dayOfYear % TOPIC_ROTATION.length];
  } else {
    // Pick next topic in rotation, skipping any used in the last 3 days
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
  const videoPath = await renderVideo(audioPath, { id: videoId, title, topic: topic.id, topicName: topic.name });
  const videoUrl = `${BACKEND_URL}/videos/${videoId}.mp4`;
  const videoRecord = { id: videoId, date: new Date().toISOString().split('T')[0], topic: topic.id, topicName: topic.name, title, script, audioPath, videoPath, videoUrl, status: 'ready', durationSecs: Math.ceil(script.split(' ').length / 2.5), generatedAt: new Date().toISOString(), voiceName: 'Frank', voiceId: ELEVENLABS_VOICE_ID };
  videoDB.saveVideo(videoRecord);
  console.log('[Pipeline] Video pipeline complete:', videoRecord.title);
  return videoRecord;
}
async function testPipeline() {
  console.log('[Pipeline] Running test...');
  try {
    const script = await generateSpeech(TOPIC_ROTATION[0]);
    console.log('[Pipeline] Claude speech generation working');
    console.log('[Pipeline] First line:', script.split('\n')[0]);
    if (!ELEVENLABS_API_KEY || ELEVENLABS_API_KEY === 'YOUR_KEY_HERE') {
      console.log('[Pipeline] ElevenLabs key not set');
    } else {
      const testId = 'test-' + Date.now();
      const audioPath = await generateAudio('ProTeen Nation. We are the future. This is a voice test.', testId);
      console.log('[Pipeline] ElevenLabs audio generation working');
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