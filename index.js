/**
 * Alert Webhook Receiver
 * -----------------------
 * Single endpoint set that receives alerts from:
 *   - TradingView (native webhook alerts)
 *   - Your Gmail Apps Script (MarketInOut email forwarder)
 *
 * For every alert it:
 *   1. Responds 200 immediately (required so TradingView doesn't mark it failed)
 *   2. Logs it to alerts.json (viewable at /dashboard)
 *   3. Fires SMS and/or a phone call via Twilio, based on payload.priority
 *
 * ENV VARS REQUIRED (set in .env locally, or in Railway/Render's dashboard):
 *   SHARED_SECRET        - must match the secret sent by TradingView/Apps Script
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_FROM_NUMBER    - your Twilio number, e.g. +18005551234
 *   ALERT_TO_NUMBER       - your personal phone number, e.g. +19785551234
 *   PORT                  - optional, defaults to 3000
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'alerts.json');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- Storage helpers (simple JSON file; swap for a real DB later if you outgrow this) ---
function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function loadAlerts() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveAlert(entry) {
  const alerts = loadAlerts();
  alerts.unshift(entry); // newest first
  fs.writeFileSync(DATA_FILE, JSON.stringify(alerts.slice(0, 500), null, 2)); // keep last 500
}

// --- Priority logic ---
// If the payload already specifies a priority (our Apps Script sets this), use it.
// Otherwise fall back to a score threshold (useful for TradingView Pine alerts with a "score" field).
function resolvePriority(payload) {
  if (payload.priority) return payload.priority;
  if (typeof payload.score === 'number') {
    return payload.score >= 75 ? 'call' : 'sms';
  }
  return 'sms'; // safe default — never silently drop a real alert
}

// --- Twilio actions ---
async function sendSms(bodyText) {
  return twilioClient.messages.create({
    body: bodyText.slice(0, 1500), // SMS providers truncate very long bodies anyway
    from: process.env.TWILIO_FROM_NUMBER,
    to: process.env.ALERT_TO_NUMBER
  });
}

async function makeCall(spokenText) {
  const twimlUrl = `https://twimlets.com/message?Message%5B0%5D=${encodeURIComponent(spokenText)}`;
  return twilioClient.calls.create({
    url: twimlUrl,
    from: process.env.TWILIO_FROM_NUMBER,
    to: process.env.ALERT_TO_NUMBER
  });
}

// --- Message formatting ---
function formatMessage(payload) {
  if (payload.format === 'trade_alert') {
    return `Trade Alert: ${payload.symbol || '?'} — ${payload.condition || ''} (${payload.timeframe || ''}). ${payload.comment || ''}`.trim();
  }
  if (payload.format === 'screen_alert') {
    const symbols = (payload.matches || []).map(m => m.symbol).join(', ');
    return `Screen Alert (${payload.screen_name || 'unnamed'}): ${symbols || 'see details'}`;
  }
  // TradingView-style JSON alert
  if (payload.ticker || payload.symbol) {
    return `${payload.action || 'Alert'}: ${payload.ticker || payload.symbol} @ ${payload.price || payload.close || '?'}${payload.strategy ? ' — ' + payload.strategy : ''}`;
  }
  return payload.message || payload.subject || 'New trading alert';
}

// --- Shared handler for both sources ---
async function handleAlert(req, res, sourceLabel) {
  const payload = req.body || {};

  if (payload.secret !== process.env.SHARED_SECRET) {
    console.warn(`Rejected alert from ${sourceLabel}: bad or missing secret`);
    return res.status(401).send('unauthorized');
  }

  // Respond immediately — TradingView times out fast, and Twilio calls take a moment.
  res.status(200).send('ok');

  const priority = resolvePriority(payload);
  const text = formatMessage(payload);
  const timestamp = new Date().toISOString();

  const logEntry = {
    timestamp,
    source: sourceLabel,
    priority,
    text,
    raw: payload,
    sms_sent: false,
    call_sent: false
  };

  try {
    if (priority === 'call' || priority === 'sms') {
      await sendSms(text);
      logEntry.sms_sent = true;
    }
    if (priority === 'call') {
      await makeCall(text);
      logEntry.call_sent = true;
    }
  } catch (err) {
    console.error('Twilio error:', err.message);
    logEntry.error = err.message;
  }

  saveAlert(logEntry);
}

// --- Routes ---
app.post('/webhook/tradingview', (req, res) => handleAlert(req, res, 'TradingView'));
app.post('/webhook/email', (req, res) => handleAlert(req, res, 'MarketInOut/Gmail'));

// Simple dashboard to see everything that's come through
app.get('/dashboard', (req, res) => {
  const alerts = loadAlerts();
  const rows = alerts.map(a => `
    <tr>
      <td>${a.timestamp}</td>
      <td>${a.source}</td>
      <td>${a.priority}</td>
      <td>${a.text}</td>
      <td>${a.sms_sent ? '✅' : '—'}</td>
      <td>${a.call_sent ? '✅' : '—'}</td>
      <td>${a.error ? '⚠️ ' + a.error : ''}</td>
    </tr>`).join('');

  res.send(`
    <html>
      <head>
        <title>Alert Dashboard</title>
        <style>
          body { font-family: monospace; background: #111; color: #eee; padding: 20px; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #444; padding: 6px 10px; text-align: left; font-size: 13px; }
          th { background: #222; }
        </style>
      </head>
      <body>
        <h2>Alert Dashboard (${alerts.length} logged)</h2>
        <table>
          <tr><th>Time</th><th>Source</th><th>Priority</th><th>Message</th><th>SMS</th><th>Call</th><th>Error</th></tr>
          ${rows}
        </table>
      </body>
    </html>
  `);
});

app.get('/', (req, res) => res.send('Alert receiver is running. See /dashboard for logged alerts.'));

app.listen(PORT, () => console.log(`Alert receiver listening on port ${PORT}`));
