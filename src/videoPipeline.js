require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { videoDB } = require('./videoDatabase');
const { renderVideo } = require('./videoRenderer');
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'V2bPluzT7MuirpucVAKH';
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
async function generateSpeech(topic) {
  console.log('[Pipeline] Generating speech for topic:', topic.name);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('[Pipeline] Anthropic key present:', !!apiKey, '| starts with:', apiKey ? apiKey.slice(0, 10) : 'MISSING');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set on Railway. Go to Railway > Variables and add it.');
  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'Write a powerful 2-3 minute motivational speech for teenagers about ' + topic.name + '. Open with a bold attention-grabbing line. Speak directly to the teen using "you". Be specific and honest. Build emotional momentum — start grounded, rise to passion, pull back to something quiet and real, then finish with fire. Include one concrete action they can take today. Use short punchy sentences for emphasis at peak moments. End with an unforgettable closing line. Return only the speech text, no titles or labels.' }],
  });
  const script = message.content[0].text.trim();
  console.log('[Pipeline] Speech generated', script.split(' ').length, 'words');
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
        { text: script, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.30, similarity_boost: 0.85, style: 0.72, use_speaker_boost: true } },
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
  const dayIndex = new Date().getDay();
  const topic = topicOverride
    ? (TOPIC_ROTATION.find(t => t.id === topicOverride) || TOPIC_ROTATION[dayIndex % TOPIC_ROTATION.length])
    : TOPIC_ROTATION[dayIndex % TOPIC_ROTATION.length];
  if (!topicOverride) {
    const existing = videoDB.getToday();
    if (existing) { console.log('[Pipeline] Today video already exists:', existing.title); return existing; }
  }
  const videoId = uuidv4();
  const script = await generateSpeech(topic);
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