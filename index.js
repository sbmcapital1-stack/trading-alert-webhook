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
  alerts.unshift(entry);
  fs.writeFileSync(DATA_FILE, JSON.stringify(alerts.slice(0, 500), null, 2));
}

function resolvePriority(payload) {
  if (payload.priority) return payload.priority;
  if (typeof payload.score === 'number') {
    return payload.score >= 75 ? 'call' : 'sms';
  }
  return 'sms';
}

async function sendSms(bodyText) {
  return twilioClient.messages.create({
    body: bodyText.slice(0, 1500),
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

function formatMessage(payload) {
  if (payload.format === 'trade_alert') {
    return `Trade Alert: ${payload.symbol || '?'} — ${payload.condition || ''} (${payload.timeframe || ''}). ${payload.comment || ''}`.trim();
  }
  if (payload.format === 'screen_alert') {
    const symbols = (payload.matches || []).map(m => m.symbol).join(', ');
    return `Screen Alert (${payload.screen_name || 'unnamed'}): ${symbols || 'see details'}`;
  }
  if (payload.ticker || payload.symbol) {
    return `${payload.action || 'Alert'}: ${payload.ticker || payload.symbol} @ ${payload.price || payload.close || '?'}${payload.strategy ? ' — ' + payload.strategy : ''}`;
  }
  return payload.message || payload.subject || 'New trading alert';
}

async function handleAlert(req, res, sourceLabel) {
  const payload = req.body || {};

  if (payload.secret !== process.env.SHARED_SECRET) {
    console.warn(`Rejected alert from ${sourceLabel}: bad or missing secret`);
    return res.status(401).send('unauthorized');
  }

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

app.post('/webhook/tradingview', (req, res) => handleAlert(req, res, 'TradingView'));
app.post('/webhook/email', (req, res) => handleAlert(req, res, 'MarketInOut/Gmail'));

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

app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Privacy Policy</title>
      <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;}</style>
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p>This application ("the Service") sends automated SMS text messages and phone calls to a single, pre-configured phone number belonging to the account owner, for the sole purpose of delivering personal trading and stock-alert notifications generated by the account owner's own trading tools (TradingView and MarketInOut).</p>
        <p>No mobile phone number or personal data collected through this Service is shared, sold, rented, or otherwise disclosed to any third party, affiliate, or marketing partner, at any time, for any purpose.</p>
        <p>The only phone number that receives messages from this Service is the number configured directly by the account owner. This Service does not collect phone numbers from any other individual, and does not offer public sign-up.</p>
        <p>Message frequency varies based on market activity; up to approximately 20 messages per day during active market hours. Message and data rates may apply.</p>
        <p>To stop receiving messages, the account owner may reply STOP at any time, or disable the alert configuration directly within the Service.</p>
        <p>Contact: the account owner, via the phone number associated with this Service.</p>
      </body>
    </html>
  `);
});

app.get('/terms', (req, res) => {
  res.send(`
    <html>
      <head><title>Terms & Conditions</title>
      <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.6;}</style>
      </head>
      <body>
        <h1>Terms & Conditions</h1>
        <p>This Service is a personal, single-user notification tool. It sends SMS text messages and phone calls only to the phone number the account owner has configured, for the purpose of relaying trading alerts the account owner generated from their own tools (TradingView and MarketInOut).</p>
        <p>This is not a commercial or public messaging service. No other individual can sign up to receive messages through this Service.</p>
        <p>Message frequency varies based on market activity; up to approximately 20 messages per day during active market hours. Message and data rates may apply. Reply STOP to opt out at any time; reply HELP for support.</p>
        <p>By configuring this Service with their own phone number, the account owner consents to receive these automated messages and calls.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, () => console.log(`Alert receiver listening on port ${PORT}`));
