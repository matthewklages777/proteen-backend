404: Not Foundrequire('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { videoDB } = require('./videoDatabase');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'V2bPluzT7MuirpucVAKH';
const AUDIO_DIR = path.join(__dirname, '../data/audio');

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
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: `Write a powerful 2-3 minute motivational speech for teenagers about ${topic.name}. Open with a bold attention-grabbing line. Speak directly to the teen using "you". Be specific and honest. Include one concrete action they can take today. End with a memorable closing line. Return only the speech text, no titles or labels.` }],
  });
  const script = message.content[0].text.trim();
  console.log('[Pipeline] Speech generated —', script.split(' ').length, 'words');
  return script;
}

async function generateAudio(script, videoId) {
  console.log('[Pipeline] Generating audio with ElevenLabs (Frank)...');
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const audioPath = path.join(AUDIO_DIR, `${videoId}.mp3`);
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text: script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.65, similarity_boost: 0.85, style: 0.45, use_speaker_boost: true }
    },
    {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      responseType: 'arraybuffer',
      timeout: 60000
    }
  );
  fs.writeFileSync(audioPath, response.data);
  console.log('[Pipeline] Audio saved:', audioPath);
  return audioPath;
}

async function runDailyVideoPipeline() {
  console.log('[Pipeline] Starting daily video pipeline at', new Date().toLocaleString());
  const existing = videoDB.getToday();
  if (existing) { console.log('[Pipeline] Today video already exists:', existing.title); return existing; }
  const dayIndex = new Date().getDay();
  const topic = TOPIC_ROTATION[dayIndex % TOPIC_ROTATION.length];
  const videoId = uuidv4();
  const script = await generateSpeech(topic);
  const audioPath = await generateAudio(script, videoId);
  const videoRecord = {
    id: videoId,
    date: new Date().toISOString().split('T')[0],
    topic: topic.id,
    topicName: topic.name,
    title: script.split('.')[0].slice(0, 60),
    script,
    audioPath,
    status: 'ready',
    durationSecs: Math.ceil(script.split(' ').length / 2.5),
    generatedAt: new Date().toISOString(),
    voiceName: 'Frank',
    voiceId: ELEVENLABS_VOICE_ID
  };
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
      console.log('[Pipeline] ElevenLabs key not set — skipping audio test');
    } else {
      const testId = 'test-' + Date.now();
      const audioPath = await generateAudio('ProTeen Nation. We are the future. This is a voice test.', testId);
      console.log('[Pipeline] ElevenLabs audio generation working');
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }
    console.log('[Pipeline] All systems go! Ready for automated daily vid