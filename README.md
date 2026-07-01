# Trading Alert Webhook Receiver

Receives alerts from TradingView and your Gmail/MarketInOut Apps Script, logs
them, and fires SMS + phone calls via Twilio.

## Endpoints

- `POST /webhook/tradingview` — point your TradingView alert's Webhook URL here
- `POST /webhook/email` — this is the `WEBHOOK_URL` value in your Apps Script
- `GET /dashboard` — view every alert that's come through, with SMS/call status

## Local setup

```bash
npm install
cp .env.example .env
# edit .env with your real Twilio credentials and secret
npm start
```

Server runs on `http://localhost:3000` by default.

## Deploying so TradingView can reach it

TradingView needs a real public HTTPS URL — localhost won't work. Easiest options:

### Railway (recommended)
1. Create a new project at railway.app, deploy from this folder (or connect a GitHub repo containing it).
2. In the service's Variables tab, add the same variables from `.env.example`.
3. In Settings → Networking, add your custom domain (e.g. `alerts.yourdomain.com`) and add the CNAME record it gives you at your domain registrar. Railway issues SSL automatically once it verifies.
4. Your live webhook URLs become:
   - `https://alerts.yourdomain.com/webhook/tradingview`
   - `https://alerts.yourdomain.com/webhook/email`

### Render (alternative)
Same idea — new Web Service, connect the repo, add environment variables, add a custom domain under Settings.

## Wiring it up

1. **TradingView**: In each alert, enable "Webhook URL", paste `https://alerts.yourdomain.com/webhook/tradingview`. Set the alert Message field to JSON including your `SHARED_SECRET`, e.g.:
   ```json
   {
     "secret": "your_shared_secret",
     "ticker": "{{ticker}}",
     "action": "{{strategy.order.action}}",
     "price": "{{close}}",
     "score": 80,
     "strategy": "VWAP_EMA_PULLBACK"
   }
   ```
   Set alert Expiration to **Open-ended** so it doesn't quietly stop working after 2 months.

2. **Gmail Apps Script**: set `WEBHOOK_URL` to `https://alerts.yourdomain.com/webhook/email` and `SHARED_SECRET` to match, exactly as in `.env`.

3. Visit `/dashboard` any time to see everything that's fired, whether SMS/call went out, and any errors.

## Notes

- Alerts are logged to a local `data/alerts.json` file. This is fine to start, but on most hosts this resets on redeploy — if you want alerts to persist long-term, swap this for a small database later (Railway/Render both offer managed Postgres).
- The server responds `200 OK` immediately on receiving an alert, before Twilio finishes sending — this matters because TradingView times out fast and will mark an alert as failed if your server doesn't respond quickly.
- Priority logic: if the payload includes `"priority": "call"` or `"sms"` (our Apps Script sets this), that's used directly. If not (e.g. a raw TradingView alert), it falls back to your `score` field — 75+ triggers a call, otherwise SMS only.
