// ProTeen Nation — Social Media Poster
// Triggers Zapier/Make webhooks to post content to each platform.
// Each platform has its own webhook URL set in .env.
// Zapier/Make handles the actual API calls to TikTok, Instagram, etc.

require('dotenv').config();
const axios = require('axios');

// ── Webhook URLs (set these in .env after setting up Zapier/Make) ──────────
const WEBHOOKS = {
  tiktok:    process.env.WEBHOOK_TIKTOK,
  instagram: process.env.WEBHOOK_INSTAGRAM,
  youtube:   process.env.WEBHOOK_YOUTUBE,
  facebook:  process.env.WEBHOOK_FACEBOOK,
  x:         process.env.WEBHOOK_X,
};

// ── Post a single platform slot ────────────────────────────────────────────
async function postToplatform(platformPost, content) {
  const webhookUrl = WEBHOOKS[platformPost.platform];

  if (!webhookUrl) {
    console.log(`[Poster] No webhook set for ${platformPost.platform} — skipping. Add WEBHOOK_${platformPost.platform.toUpperCase()} to .env`);
    return { success: false, reason: 'No webhook configured' };
  }

  // Build the payload Zapier/Make will receive
  const payload = {
    platform: platformPost.platform,
    platformName: platformPost.platformName,
    scheduledFor: platformPost.scheduledFor,
    // Content details
    contentType: content.type,
    isFullVideo: content.isFullVideo || false,
    isReshare: content.isReshare || false,
    isThirdParty: content.type === 'third_party',
    isOriginal: content.isOriginal || false,
    videoId: content.videoId || content.id,
    // For clip posts: timestamp range to extract
    clipStartSec: content.estimatedStartSec,
    clipEndSec: content.estimatedEndSec,
    clipDurationSec: 30,
    // Caption ready to paste
    caption: platformPost.caption,
    // Watermark instructions for HeyGen or video processor
    watermark: platformPost.watermark,
    // Format spec
    format: platformPost.format, // '9:16' or '16:9'
    // Credit info for third-party
    creditSource: content.creditFormat || null,
    creditUrl: content.url || null,
    // Metadata
    contentTitle: content.title || content.cleanTitle,
    postedBy: 'ProTeen Nation Automated System',
    timestamp: new Date().toISOString(),
  };

  try {
    const response = await axios.post(webhookUrl, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`[Poster] ✓ Triggered ${platformPost.platformName}: ${content.title?.slice(0, 50)}`);
    return { success: true, status: response.status };
  } catch (err) {
    console.error(`[Poster] ✗ Failed ${platformPost.platformName}:`, err.message);
    return { success: false, reason: err.message };
  }
}

// ── Post all platforms for a scheduled slot ────────────────────────────────
async function postScheduledSlot(slot) {
  console.log(`\n[Poster] Posting slot: ${slot.label} (${slot.scheduledTime})`);
  const results = [];

  for (const platformPost of slot.platforms) {
    const result = await postToplatform(platformPost, slot.content);
    results.push({ platform: platformPost.platform, ...result });
    // Stagger posts by 3 seconds to avoid rate limiting
    await new Promise(r => setTimeout(r, 3000));
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`[Poster] Slot complete: ${succeeded} posted, ${failed} failed`);
  return results;
}

// ── Check which webhooks are configured ───────────────────────────────────
function getWebhookStatus() {
  return Object.entries(WEBHOOKS).map(([platform, url]) => ({
    platform,
    configured: !!url,
    hint: url ? '✓ Ready' : `Add WEBHOOK_${platform.toUpperCase()} to your .env file`,
  }));
}

module.exports = { postToplatform, postScheduledSlot, getWebhookStatus };
