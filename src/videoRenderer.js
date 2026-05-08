require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const VIDEO_DIR = path.join(__dirname, '../data/videos');
const BRAND_BLACK = '#000000';
const BRAND_GOLD = '#e8b84b';

function ensureVideoDir() {
  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      lines.push(line.trim());
      line = word + ' ';
    } else {
      line = test;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

async function createBrandedFrame(title, topicName, framePath) {
  const W = 1080, H = 1920;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BRAND_BLACK;
  ctx.fillRect(0, 0, W, H);

  // Top gold bar
  ctx.fillStyle = BRAND_GOLD;
  ctx.fillRect(0, 0, W, 12);

  // ProTeen Nation name
  ctx.fillStyle = BRAND_GOLD;
  ctx.font = 'bold 88px serif';
  ctx.textAlign = 'center';
  ctx.fillText('ProTeen Nation', W / 2, 200);

  // Tagline
  ctx.fillStyle = '#ffffff';
  ctx.font = '44px sans-serif';
  ctx.fillText('We Are The Future', W / 2, 272);

  // Divider
  ctx.strokeStyle = BRAND_GOLD;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(160, 312);
  ctx.lineTo(W - 160, 312);
  ctx.stroke();

  // Topic label
  ctx.fillStyle = BRAND_GOLD;
  ctx.font = 'bold 48px sans-serif';
  ctx.fillText(topicName.toUpperCase(), W / 2, 920);

  // Title (word-wrapped)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 62px serif';
  const lines = wrapText(ctx, title, 900);
  const lineHeight = 84;
  const startY = 1020;
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, startY + i * lineHeight);
  });

  // Bottom gold bar
  ctx.fillStyle = BRAND_GOLD;
  ctx.fillRect(0, H - 12, W, 12);

  fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
}

// Renders a full branded MP4 from an ElevenLabs MP3 + video metadata.
// Returns the local path to the saved MP4 file.
async function renderVideo(audioPath, videoRecord) {
  ensureVideoDir();
  const framePath = path.join(VIDEO_DIR, videoRecord.id + '_frame.png');
  const videoPath = path.join(VIDEO_DIR, videoRecord.id + '.mp4');

  console.log('[Renderer] Creating branded frame for:', videoRecord.title);
  await createBrandedFrame(videoRecord.title, videoRecord.topicName, framePath);

  console.log('[Renderer] Encoding MP4...');
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath)
      .inputOptions(['-loop 1', '-framerate 1'])
      .input(audioPath)
      .outputOptions([
        '-c:v libx264',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-shortest',
      ])
      .size('1080x1920')
      .output(videoPath)
      .on('end', () => {
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
        resolve();
      })
      .on('error', (err) => reject(err))
      .run();
  });

  console.log('[Renderer] MP4 saved:', videoPath);
  return videoPath;
}

// Trims a clip from an existing MP4 using start/end timestamps.
// Used to produce 30-second clips for Reels/Shorts posting.
async function renderClip(fullVideoPath, startSec, endSec, clipId) {
  ensureVideoDir();
  const clipPath = path.join(VIDEO_DIR, clipId + '_clip.mp4');

  await new Promise((resolve, reject) => {
    ffmpeg(fullVideoPath)
      .setStartTime(startSec)
      .setDuration(endSec - startSec)
      .outputOptions(['-c copy'])
      .output(clipPath)
      .on('end', resolve)
      .on('error', (err) => reject(err))
      .run();
  });

  console.log('[Renderer] Clip saved:', clipPath);
  return clipPath;
}

module.exports = { renderVideo, renderClip };
