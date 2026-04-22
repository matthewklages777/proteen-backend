// ProTeen Nation — Video & Schedule Database
// Stores daily videos, their clip moments, and posting schedule history

const fs = require('fs');
const path = require('path');

const VIDEOS_DB = path.join(__dirname, '../data/videos.json');
const SCHEDULE_DB = path.join(__dirname, '../data/schedule.json');

function initFile(filePath, defaultData) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
}

function readFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const videoDB = {
  // Save today's video
  saveVideo(video) {
    initFile(VIDEOS_DB, { videos: [] });
    const data = readFile(VIDEOS_DB);
    const existing = data.videos.findIndex(v => v.id === video.id);
    if (existing >= 0) {
      data.videos[existing] = video;
    } else {
      data.videos.unshift(video); // newest first
    }
    // Keep last 365 days
    if (data.videos.length > 365) data.videos = data.videos.slice(0, 365);
    writeFile(VIDEOS_DB, data);
    return video;
  },

  // Get today's video
  getToday() {
    initFile(VIDEOS_DB, { videos: [] });
    const data = readFile(VIDEOS_DB);
    const today = new Date().toISOString().split('T')[0];
    return data.videos.find(v => v.date === today) || null;
  },

  // Get recent videos for archive clips (last N days)
  getArchive(days = 30) {
    initFile(VIDEOS_DB, { videos: [] });
    const data = readFile(VIDEOS_DB);
    return data.videos.slice(0, days);
  },

  // Update video with clip moments after analysis
  saveClipMoments(videoId, clips) {
    initFile(VIDEOS_DB, { videos: [] });
    const data = readFile(VIDEOS_DB);
    const idx = data.videos.findIndex(v => v.id === videoId);
    if (idx >= 0) {
      data.videos[idx].clips = clips;
      data.videos[idx].clipsGeneratedAt = new Date().toISOString();
    }
    writeFile(VIDEOS_DB, data);
  },

  // Get all videos (for archive browsing)
  getAllVideos() {
    initFile(VIDEOS_DB, { videos: [] });
    return readFile(VIDEOS_DB).videos;
  },
};

const scheduleDB = {
  // Save today's full schedule
  saveSchedule(schedule) {
    initFile(SCHEDULE_DB, { schedules: [] });
    const data = readFile(SCHEDULE_DB);
    const today = new Date().toISOString().split('T')[0];
    const existing = data.schedules.findIndex(s => s.date === today);
    const entry = { date: today, schedule, createdAt: new Date().toISOString() };
    if (existing >= 0) {
      data.schedules[existing] = entry;
    } else {
      data.schedules.unshift(entry);
    }
    // Keep last 90 days of schedules
    if (data.schedules.length > 90) data.schedules = data.schedules.slice(0, 90);
    writeFile(SCHEDULE_DB, data);
  },

  // Get today's schedule
  getToday() {
    initFile(SCHEDULE_DB, { schedules: [] });
    const data = readFile(SCHEDULE_DB);
    const today = new Date().toISOString().split('T')[0];
    return data.schedules.find(s => s.date === today) || null;
  },

  // Mark a slot as posted
  markPosted(slotId, results) {
    initFile(SCHEDULE_DB, { schedules: [] });
    const data = readFile(SCHEDULE_DB);
    const today = new Date().toISOString().split('T')[0];
    const daySchedule = data.schedules.find(s => s.date === today);
    if (daySchedule) {
      const slot = daySchedule.schedule.find(s => s.id === slotId);
      if (slot) {
        slot.status = 'posted';
        slot.postedAt = new Date().toISOString();
        slot.postResults = results;
      }
    }
    writeFile(SCHEDULE_DB, data);
  },

  // Get posting stats for a date
  getStats(date) {
    initFile(SCHEDULE_DB, { schedules: [] });
    const data = readFile(SCHEDULE_DB);
    const day = data.schedules.find(s => s.date === (date || new Date().toISOString().split('T')[0]));
    if (!day) return null;
    const schedule = day.schedule;
    return {
      date: day.date,
      totalSlots: schedule.length,
      posted: schedule.filter(s => s.status === 'posted').length,
      scheduled: schedule.filter(s => s.status === 'scheduled').length,
      totalPlatformPosts: schedule.reduce((n, s) => n + (s.platforms?.length || 0), 0),
      postedPlatformPosts: schedule.filter(s => s.status === 'posted').reduce((n, s) => n + (s.platforms?.length || 0), 0),
    };
  },
};

module.exports = { videoDB, scheduleDB };
