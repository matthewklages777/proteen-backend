// ProTeen Nation — Review Email Mailer
// Sends the team a digest of pending articles with one-click approve/reject links

require('dotenv').config();
const nodemailer = require('nodemailer');

function getTransporter() {
  if (!process.env.EMAIL_FROM || process.env.EMAIL_FROM === 'your-email@gmail.com') {
    return null; // Email not configured yet
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
}

async function sendReviewEmail(articles) {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[Mailer] Email not configured — skipping notification. Check .env EMAIL settings.');
    return;
  }

  const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;

  const articleRows = articles
    .map(
      a => `
      <tr style="border-bottom:1px solid #eee;">
        <td style="padding:16px 12px; vertical-align:top;">
          <div style="font-size:11px;color:#e8b84b;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">${a.topicIcon} ${a.topicName}</div>
          <div style="font-size:15px;font-weight:600;color:#111;margin-bottom:4px;">${a.title}</div>
          <div style="font-size:13px;color:#555;margin-bottom:8px;">${a.excerpt}</div>
          <div style="font-size:12px;color:#999;">Source: ${a.source} · Score: ${a.score}/100</div>
          <div style="font-size:12px;color:#999;margin-top:2px;">
            <a href="${a.url}" style="color:#e8b84b;">View original article →</a>
          </div>
        </td>
        <td style="padding:16px 12px;vertical-align:middle;white-space:nowrap;width:180px;">
          <a href="${BASE_URL}/admin/approve/${a.id}" style="display:inline-block;background:#1D9E75;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin-bottom:8px;">✓ Approve</a>
          <br>
          <a href="${BASE_URL}/admin/reject/${a.id}" style="display:inline-block;background:#E24B4A;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">✗ Reject</a>
        </td>
      </tr>`
    )
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:'DM Sans',Arial,sans-serif;background:#f5f5f5;margin:0;padding:24px;">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    
    <div style="background:#000;padding:28px 32px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:#fff;">ProTeen Nation</div>
      <div style="font-size:13px;color:#e8b84b;margin-top:4px;letter-spacing:0.1em;text-transform:uppercase;">Content Review Queue</div>
    </div>

    <div style="padding:24px 32px;">
      <p style="font-size:15px;color:#333;margin:0 0 8px;">
        <strong>${articles.length} new article${articles.length !== 1 ? 's' : ''}</strong> are waiting for your review.
      </p>
      <p style="font-size:13px;color:#777;margin:0 0 24px;">
        Click Approve to post immediately to the website, or Reject to remove from the queue.
        You can also review everything in the <a href="${BASE_URL}/admin" style="color:#e8b84b;">Admin Dashboard</a>.
      </p>

      <table style="width:100%;border-collapse:collapse;">
        ${articleRows}
      </table>

      <div style="margin-top:24px;padding:16px;background:#f9f9f9;border-radius:8px;text-align:center;">
        <a href="${BASE_URL}/admin" style="display:inline-block;background:#000;color:#e8b84b;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Open Admin Dashboard</a>
      </div>
    </div>

    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;">
      <p style="font-size:12px;color:#aaa;margin:0;">ProTeen Nation · We Are The Future</p>
    </div>
  </div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"ProTeen Nation" <${process.env.EMAIL_FROM}>`,
      to: process.env.EMAIL_TO,
      subject: `📬 ${articles.length} new article${articles.length !== 1 ? 's' : ''} ready for review — ProTeen Nation`,
      html,
    });
    console.log(`[Mailer] Review email sent to ${process.env.EMAIL_TO}`);
  } catch (err) {
    console.error('[Mailer] Failed to send email:', err.message);
  }
}

module.exports = { sendReviewEmail };
