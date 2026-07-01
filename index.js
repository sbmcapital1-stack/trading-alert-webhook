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

app.get('/test-call', async (req, res) => {
  if (req.query.secret !== process.env.SHARED_SECRET) {
    return res.status(401).send('unauthorized — check your secret in the URL');
  }
  try {
    await makeCall('This is a test call from your trading alert system. If you are hearing this, your phone call setup is working correctly.');
    res.send('Test call triggered! Your phone should ring in the next few seconds.');
  } catch (err) {
    res.status(500).send('Test call failed: ' + err.message);
  }
});

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
          td, th { border: 1px solid #444; padding: 6px 10px;
