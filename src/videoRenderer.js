require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const VIDEO_DIR  = path.join(__dirname, '../data/videos');
const TMP_DIR    = path.join(__dirname, '../data/tmp');
const ASSETS_DIR = path.join(__dirname, '../assets');
const LOGO_PATH  = path.join(ASSETS_DIR, 'logo.png');

const SECS_PER_IMAGE = 3; // fast montage pacing

// Topic-specific image queries — all scoped to teens and youth
const TOPIC_QUERIES = {
  resilience:    'teenager determination resilience young person strength',
  school:        'high school students studying graduation teen success',
  relationships: 'teen friends laughing together youth friendship bonds',
  faith:         'young person hope peaceful spiritual teen light',
  sports:        'teen athlete training competition young champion',
  health:        'teenager fitness running active healthy youth',
  careers:       'young person ambition success teen goal dreaming',
  civics:        'youth community leadership teen volunteer together',
};

// Inspirational scenery + youth energy mixed into every video
const INSPIRATIONAL_QUERIES = [
  'teenager silhouette sunset horizon',
  'young people laughing city',
  'teen walking mountain trail',
  'youth sports team celebrate',
  'young person ocean beach freedom',
  'high school friends together night',
  'teenager jumping city rooftop energy',
  'young student graduation cap success',
  'teen musician performer stage',
  'youth group diverse friends smiling',
];

function ensureDirs() {
  [VIDEO_DIR, TMP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

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

// Load fonts once at startup
let _fredokaB64  = null;
let _playfairB64 = null;
let _dmSansB64   = null;

function loadFont(filename) {
  const p = path.join(ASSETS_DIR, filename);
  return fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : null;
}
function fredokaB64()  { if (!_fredokaB64)  _fredokaB64  = loadFont('fredoka-bold.woff');    return _fredokaB64; }
function playfairB64() { if (!_playfairB64) _playfairB64 = loadFont('playfair-bold.woff');   return _playfairB64; }
function dmSansB64()   { if (!_dmSansB64)   _dmSansB64   = loadFont('dm-sans-regular.woff'); return _dmSansB64; }

function fontStyles() {
  let s = '';
  const fk = fredokaB64();
  const pf = playfairB64();
  const dm = dmSansB64();
  if (fk) s += `@font-face{font-family:'Fredoka';font-weight:700;src:url('data:font/woff;base64,${fk}') format('woff');}`;
  if (pf) s += `@font-face{font-family:'Playfair Display';font-weight:700;src:url('data:font/woff;base64,${pf}') format('woff');}`;
  if (dm) s += `@font-face{font-family:'DM Sans';font-weight:400;src:url('data:font/woff;base64,${dm}') format('woff');}`;
  return s ? `<defs><style>${s}</style></defs>` : '';
}

// Fredoka matches the logo font — use for brand name + tagline
function logoFont()  { return fredokaB64()  ? "'Fredoka', Arial Rounded MT Bold, sans-serif" : 'Arial, sans-serif'; }
// Playfair for speech title (editorial, elegant)
function pfFont()    { return playfairB64() ? "'Playfair Display', Georgia, serif"           : 'Georgia, serif'; }
// DM Sans for topic label (clean, readable)
function dmFont()    { return dmSansB64()   ? "'DM Sans', Arial, sans-serif"                 : 'Arial, sans-serif'; }

// Transparent SVG overlay: gradients + text only. Logo added separately via sharp.
function buildOverlaySvg(title, topicName) {
  const W = 1080, H = 1920;
  const titleLines = wrapText(title, 30);
  const bottomY    = H - 220 - (titleLines.length - 1) * 74;

  const titleTexts = titleLines.map((line, i) =>
    `<text x="540" y="${bottomY + i * 74}" font-family="${pfFont()}" font-size="58" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  ${fontStyles()}
  <defs>
    <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#000" stop-opacity="0.80"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="botFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.85"/>
    </linearGradient>
  </defs>

  <!-- Gradient fades top and bottom -->
  <rect width="${W}" height="320" fill="url(#topFade)"/>
  <rect y="${H - 380}" width="${W}" height="380" fill="url(#botFade)"/>

  <!-- Gold accent bars -->
  <rect x="0" y="0"       width="${W}" height="10" fill="#e8b84b"/>
  <rect x="0" y="${H-10}" width="${W}" height="10" fill="#e8b84b"/>

  <!-- Brand name top-center — Fredoka matches logo font -->
  <text x="540" y="82" font-family="${logoFont()}" font-size="58" font-weight="700"
        fill="#e8b84b" text-anchor="middle" letter-spacing="1">PROTEEN NATION</text>

  <!-- Tagline — Fredoka, lighter weight -->
  <text x="540" y="128" font-family="${logoFont()}" font-size="30"
        fill="#ffffff" text-anchor="middle" opacity="0.9" letter-spacing="3">WE ARE THE FUTURE</text>

  <!-- Topic label — DM Sans, spaced out -->
  <text x="540" y="178" font-family="${dmFont()}" font-size="24" font-weight="700"
        fill="#e8b84b" text-anchor="middle" letter-spacing="4" opacity="0.85">${escapeXml(topicName.toUpperCase())}</text>

  <!-- Speech title at bottom -->
  ${titleTexts}
</svg>`;
}

// Builds the final overlay PNG: SVG + logo watermark in bottom-right corner.
async function buildOverlayPng(title, topicName, outputPath) {
  const W = 1080, H = 1920;
  const svgBuf = Buffer.from(buildOverlaySvg(title, topicName));
  const composites = [];

  if (fs.existsSync(LOGO_PATH)) {
    // Resize logo to 160px wide for corner watermark
    const logoBuf = await sharp(LOGO_PATH)
      .resize(160, null, { fit: 'inside' })
      .toBuffer();
    const { width: lw, height: lh } = await sharp(logoBuf).metadata();

    composites.push({
      input: logoBuf,
      left: W - lw - 24,     // 24px from right edge
      top:  H - lh - 80,     // 80px from bottom (above gold bar)
      blend: 'screen',        // makes dark navy background invisible
    });
  }

  await sharp(svgBuf)
    .composite(composites)
    .png()
    .toFile(outputPath);
}

// Fetch images from Pixabay for a given search query
async function fetchImages(query, count) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) throw new Error('PIXABAY_API_KEY not set');
  const res = await axios.get('https://pixabay.com/api/', {
    params: { key: apiKey, q: query, image_type: 'photo', orientation: 'vertical',
              per_page: count, safesearch: true, min_width: 720 },
    timeout: 15000,
  });
  return res.data.hits.map(p => p.largeImageURL);
}

// Fetch a rich mix: topic-specific + rotating inspirational imagery
async function fetchTopicImages(topicId) {
  const topicQuery = TOPIC_QUERIES[topicId] || 'motivation inspiration success';
  // Pick 2 random inspirational queries for variety
  const shuffled = INSPIRATIONAL_QUERIES.sort(() => Math.random() - 0.5);
  const inspQueries = shuffled.slice(0, 2);

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const topicUrls = await fetchImages(topicQuery, 15).catch(() => []);
  await delay(1000);
  const insp1Urls = await fetchImages(inspQueries[0], 10).catch(() => []);
  await delay(1000);
  const insp2Urls = await fetchImages(inspQueries[1], 10).catch(() => []);

  // Interleave: 2 topic images, 1 inspirational, repeat
  const mixed = [];
  const maxLen = Math.max(topicUrls.length, insp1Urls.length + insp2Urls.length);
  const inspAll = [...insp1Urls, ...insp2Urls];
  for (let i = 0; i < maxLen; i++) {
    if (topicUrls[i])   mixed.push(topicUrls[i]);
    if (topicUrls[i+1]) mixed.push(topicUrls[i+1]);
    if (inspAll[i])     mixed.push(inspAll[i]);
  }

  // Deduplicate
  return [...new Set(mixed)];
}

async function downloadImages(imageUrls, tmpDir) {
  const paths = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const imgPath = path.join(tmpDir, `img_${i}.jpg`);
    const res = await axios.get(imageUrls[i], { responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(imgPath, res.data);
    paths.push(imgPath);
  }
  return paths;
}

function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) reject(err); else resolve(meta.format.duration);
    });
  });
}

// Build concat file — repeat images to fill the full audio duration
function buildConcatFile(imagePaths, totalDuration, concatFile) {
  const totalImgDuration = imagePaths.length * SECS_PER_IMAGE;
  let lines = [];

  if (totalImgDuration >= totalDuration) {
    // Enough images, use them once
    lines = imagePaths.map(p => `file '${p}'\nduration ${SECS_PER_IMAGE}`);
  } else {
    // Not enough — repeat the list until we cover the audio
    const needed = Math.ceil(totalDuration / SECS_PER_IMAGE);
    for (let i = 0; i < needed; i++) {
      const img = imagePaths[i % imagePaths.length];
      lines.push(`file '${img}'\nduration ${SECS_PER_IMAGE}`);
    }
  }

  fs.writeFileSync(concatFile, lines.join('\n'));
  console.log(`[Renderer] ${lines.length} image slots for ${totalDuration.toFixed(0)}s audio`);
}

// Main render: fast image montage + branding overlay + audio
async function renderVideo(audioPath, videoRecord) {
  ensureDirs();
  const tmpDir    = path.join(TMP_DIR, videoRecord.id);
  const videoPath = path.join(VIDEO_DIR, videoRecord.id + '.mp4');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log('[Renderer] Fetching mixed imagery for topic:', videoRecord.topic);
    const imageUrls  = await fetchTopicImages(videoRecord.topic);
    console.log('[Renderer] Downloading', imageUrls.length, 'images...');
    const imagePaths = await downloadImages(imageUrls, tmpDir);

    const totalDuration = await getAudioDuration(audioPath);
    const overlayPath   = path.join(tmpDir, 'overlay.png');
    const concatFile    = path.join(tmpDir, 'concat.txt');

    console.log('[Renderer] Building branding overlay...');
    await buildOverlayPng(videoRecord.title, videoRecord.topicName, overlayPath);
    buildConcatFile(imagePaths, totalDuration, concatFile);

    console.log('[Renderer] Encoding fast-montage MP4...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFile).inputOptions(['-f concat', '-safe 0'])
        .input(audioPath)
        .input(overlayPath)
        .complexFilter([
          '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[slides]',
          '[slides][2:v]overlay=0:0[final]',
        ])
        .outputOptions(['-map [final]', '-map 1:a', '-c:v libx264', '-c:a aac',
                        '-b:a 192k', '-pix_fmt yuv420p', '-r 25', '-shortest',
                        '-movflags +faststart'])
        .output(videoPath)
        .on('end', () => { fs.rmSync(tmpDir, { recursive: true, force: true }); resolve(); })
        .on('error', (err) => { fs.rmSync(tmpDir, { recursive: true, force: true }); reject(err); })
        .run();
    });

  } catch (err) {
    console.warn('[Renderer] Falling back to static frame:', err.message);
    await renderStaticFallback(audioPath, videoRecord, videoPath, tmpDir);
  }

  console.log('[Renderer] Video saved:', videoPath);
  return videoPath;
}

async function renderStaticFallback(audioPath, videoRecord, videoPath, tmpDir) {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const W = 1080, H = 1920;
  const titleLines  = wrapText(videoRecord.title, 28);
  const titleBlocks = titleLines.map((line, i) =>
    `<text x="540" y="${1060 + i * 80}" font-family="${pfFont()}" font-size="62" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('\n  ');

  const bgSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  ${fontStyles()}
  <rect width="${W}" height="${H}" fill="#000000"/>
  <rect x="0" y="0"       width="${W}" height="10" fill="#e8b84b"/>
  <rect x="0" y="${H-10}" width="${W}" height="10" fill="#e8b84b"/>
  <text x="540" y="80" font-family="${pfFont()}" font-size="52" font-weight="700" fill="#e8b84b" text-anchor="middle">PROTEEN NATION</text>
  <text x="540" y="128" font-family="${dmFont()}" font-size="28" fill="#ffffff" text-anchor="middle" opacity="0.9">WE ARE THE FUTURE</text>
  <text x="540" y="178" font-family="${dmFont()}" font-size="26" font-weight="700" fill="#e8b84b" text-anchor="middle" letter-spacing="3">${escapeXml(videoRecord.topicName.toUpperCase())}</text>
  ${titleBlocks}
</svg>`;

  const framePath   = path.join(tmpDir, 'frame.png');
  const overlayPath = path.join(tmpDir, 'overlay.png');
  await buildOverlayPng(videoRecord.title, videoRecord.topicName, overlayPath);
  await sharp(Buffer.from(bgSvg))
    .composite([{ input: overlayPath, blend: 'over' }])
    .png().toFile(framePath);

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(framePath).inputOptions(['-loop 1', '-framerate 1'])
      .input(audioPath)
      .outputOptions(['-c:v libx264', '-tune stillimage', '-c:a aac',
                      '-b:a 192k', '-pix_fmt yuv420p', '-shortest', '-vf scale=1080:1920',
                      '-movflags +faststart'])
      .output(videoPath)
      .on('end', () => { fs.rmSync(tmpDir, { recursive: true, force: true }); resolve(); })
      .on('error', (err) => { fs.rmSync(tmpDir, { recursive: true, force: true }); reject(err); })
      .run();
  });
}

async function renderClip(fullVideoPath, startSec, endSec, clipId) {
  const clipPath = path.join(VIDEO_DIR, clipId + '_clip.mp4');
  await new Promise((resolve, reject) => {
    ffmpeg(fullVideoPath)
      .setStartTime(startSec).setDuration(endSec - startSec)
      .outputOptions(['-c copy']).output(clipPath)
      .on('end', resolve).on('error', (err) => reject(err)).run();
  });
  console.log('[Renderer] Clip saved:', clipPath);
  return clipPath;
}

module.exports = { renderVideo, renderClip };
