# TradePilot Automation Server

Automated options execution engine for SPY and QQQ 0DTE trading.
Connects to your TastyTrade account and executes trades based on
TradingView signals or TradePilot managed strategies.

## Deploy to Heroku

Click the button below to deploy your own private automation server
in under 5 minutes. You will need:

- A free [Heroku account](https://heroku.com)
- Your TradePilot API credentials from [app.tradepilotlabs.com](https://app.tradepilotlabs.com)
- A connected TastyTrade account

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/tradepilotlabs/tradepilot-deploy)

## After deploying

1. Copy your app URL (e.g. `https://my-tradepilot.herokuapp.com`)
2. Go to [app.tradepilotlabs.com](https://app.tradepilotlabs.com)
3. In Settings → paste your Heroku app URL
4. Click Connect TastyTrade and authorize
5. Choose your strategy and enable trading

## What this installs

This repo contains no trading logic — it installs the
`@tradepilot/ats` private package which contains the full
automation engine. Your source code and strategy logic
are never exposed.

## Support

Visit [app.tradepilotlabs.com/support](https://app.tradepilotlabs.com/support)
or email hello@tradepilotlabs.com
