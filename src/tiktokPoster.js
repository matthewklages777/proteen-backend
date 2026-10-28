// ProTeen Nation — TikTok Direct Poster
// Uses TikTok Content Posting API v2 to auto-post clips without Buffer.
//
// SETUP (one-time, done in Railway env vars):
//   TIKTOK_CLIENT_KEY     — from your TikTok app at developers.tiktok.com
//   TIKTOK_CLIENT_SECRET  — from your TikTok app
//   TIKTOK_ACCESS_TOKEN   — obtained via OAuth (see /admin/tiktok-auth to connect)
//   TIKTOK_OPEN_ID        — your TikTok account's open_id (returned during OAuth)
//
// HOW TO CONNECT:
//   1. Go to https://developers.tiktok.com → create a new app
//   2. Enable "Content Posting API" and "Video Upload" scopes
//   3. Hit https://proteen-backend-production.up.railway.app/admin/tiktok-auth
//      to start the OAuth flow and save your tokens.

require('dotenv').config();
const axios = require('axios');

const TIKTOK_API = 'https://open.tiktokapis.com/v2';

// Post a video clip to TikTok via the Content Posting API v2
async function postToTikTok({ videoUrl, caption, title }) {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  const openId      = process.env.TIKTOK_OPEN_ID;

  if (!accessToken || !openId) {
    console.log('[TikTok] Not configured — set TIKTOK_ACCESS_TOKEN + TIKTOK_OPEN_ID in Railway env vars');
    console.log('[TikTok] Visit /admin/tiktok-auth to connect your TikTok account');
    return { success: false, reason: 'Not configured' };
  }

  try {
    // Step 1: Initialize video upload
    const initRes = await axios.post(
      `${TIKTOK_API}/post/publish/video/init/`,
      {
        post_info: {
          title: caption.slice(0, 2200),
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: videoUrl,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        timeout: 30000,
      }
    );

    const publishId = initRes.data?.data?.publish_id;
    if (!publishId) {
      console.error('[TikTok] No publish_id in init response:', JSON.stringify(initRes.data));
      return { success: false, reason: 'No publish_id', data: initRes.data };
    }

    console.log(`[TikTok] ✅ Video queued for publish. publish_id: ${publishId}`);
    return { success: true, publishId };

  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;

    // Token expired — need to reconnect
    if (status === 401 || body?.error?.code === 'access_token_invalid') {
      console.error('[TikTok] ❌ Access token expired — visit /admin/tiktok-auth to reconnect');
      return { success: false, reason: 'Token expired — reconnect at /admin/tiktok-auth' };
    }

    console.error(`[TikTok] ❌ Post failed (${status}):`, body || err.message);
    return { success: false, reason: err.message, data: body };
  }
}

// Check the status of a TikTok publish job
async function checkTikTokStatus(publishId) {
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) return { success: false, reason: 'Not configured' };
  try {
    const res = await axios.post(
      `${TIKTOK_API}/post/publish/status/fetch/`,
      { publish_id: publishId },
      {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      }
    );
    return { success: true, data: res.data?.data };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// Build the OAuth URL for connecting a TikTok account
function getTikTokAuthUrl(redirectUri) {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  if (!clientKey) return null;
  const scope = 'video.upload,video.publish';
  return `https://www.tiktok.com/v2/auth/authorize/?client_key=${clientKey}&scope=${encodeURIComponent(scope)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=proteen`;
}

// Exchange auth code for access token
async function exchangeTikTokCode(code, redirectUri) {
  const clientKey    = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) throw new Error('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not set');

  const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', {
    client_key:    clientKey,
    client_secret: clientSecret,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  redirectUri,
  }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return res.data;
}

module.exports = { postToTikTok, checkTikTokStatus, getTikTokAuthUrl, exchangeTikTokCode };
