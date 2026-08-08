# Personal Organizer

A personal organizer with:
- Monthly calendar with tasks and sport events
- Telegram daily briefing and weekly summary
- TheSportsDB integration for real sport fixtures
- Weather widget (Lugoj, Romania)

## Deploy to Railway

1. Push this repo to GitHub
2. Connect to Railway.app → New Project → GitHub Repository
3. Railway auto-detects Node.js and runs `npm start`
4. Open the app URL → Settings → enter Telegram token & chat ID

## Local development

```bash
npm install
node server.js
```

Open http://localhost:3000
