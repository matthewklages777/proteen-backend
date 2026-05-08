require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const VIDEO_DIR = path.join(__dirname, '../data/videos');

function ensureVideoDir() {
  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

// Word-wrap a string into lines that fit within maxChars characters.
function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line !== '') {
      lines.push(line.trim());
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Builds a branded SVG frame as a string — no native dependencies.
function buildSvg(title, topicName) {
  const W = 1080, H = 1920;
  const titleLines = wrapText(title, 28);

  const titleBlocks = titleLines.map((line, i) =>
    `<text x="540" y="${1040 + i * 90}" font-family="Georgia, serif" font-size="68" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="#000000"/>

  <!-- Top gold bar -->
  <rect x="0" y="0" width="${W}" height="12" fill="#e8b84b"/>

  <!-- ProTeen Nation -->
  <text x="540" y="210" font-family="Georgia, serif" font-size="96" font-weight="bold" fill="#e8b84b" text-anchor="middle">ProTeen Nation</text>

  <!-- Tagline -->
  <text x="540" y="285" font-family="Arial, sans-serif" font-size="48" fill="#ffffff" text-anchor="middle">We Are The Future</text>

  <!-- Divider -->
  <line x1="160" y1="320" x2="920" y2="320" stroke="#e8b84b" stroke-width="2"/>

  <!-- Topic label -->
  <text x="540" y="940" font-family="Arial, sans-serif" font-size="52" font-weight="bold" fill="#e8b84b" text-anchor="middle">${escapeXml(topicName.toUpperCase())}</text>

  <!-- Speech title -->
  ${titleBlocks}

  <!-- Bottom gold bar -->
  <rect x="0" y="${H - 12}" width="${W}" height="12" fill="#e8b84b"/>
</svg>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Renders a full branded MP4 from an ElevenLabs MP3 + video metadata.
// Uses SVG → FFmpeg (no canvas/native deps). Returns local MP4 path.
async function renderVideo(audioPath, videoRecord) {
  ensureVideoDir();
  const svgPath = path.join(VIDEO_DIR, videoRecord.id + '_frame.svg');
  const videoPath = path.join(VIDEO_DIR, videoRecord.id + '.mp4');

  console.log('[Renderer] Creating branded SVG frame for:', videoRecord.title);
  fs.writeFileSync(svgPath, buildSvg(videoRecord.title, videoRecord.topicName));

  console.log('[Renderer] Encoding MP4...');
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(svgPath)
      .inputOptions(['-loop 1', '-framerate 1'])
      .input(audioPath)
      .outputOptions([
        '-c:v libx264',
        '-tune stillimage',
        '-c:a aac',
        '-b:a 192k',
        '-pix_fmt yuv420p',
        '-shortest',
        '-vf scale=1080:1920',
      ])
      .output(videoPath)
      .on('end', () => {
        if (fs.existsSync(svgPath)) fs.unlinkSync(svgPath);
        resolve();
      })
      .on('error', (err) => reject(err))
      .run();
  });

  console.log('[Renderer] MP4 saved:', videoPath);
  return videoPath;
}

// Trims a 30-second clip from an existing MP4 using start/end timestamps.
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
