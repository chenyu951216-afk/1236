# Discord CoinGlass Futures Bot

在 Discord 傳 `btc`、`btC`、`BTCUSDT` 這類訊息，Bot 會自動轉成 CoinGlass futures/合約資料查詢，回傳重點摘要，並附上手機端可下載或轉傳的 `raw.json`、`summary.csv`、`report.txt`、`chart.png`。

## 功能

- 大小寫不敏感：`btc`、`btC`、`BTC` 都會當成 `BTC`
- 自動合約化：全部走 CoinGlass `/api/futures/*` endpoints
- 支援裸符號與指令：
  - `btc`
  - `!cg btc`
  - `!cg btc --exchange Bybit --interval 4h --limit 80 --range 24h`
- 可用 Discord user id / channel id 白名單監控
- 回傳 Discord 附件，方便手機下載、轉傳、留檔
- 沒有外部 npm dependencies，部署時只需要 Node.js 22+

## 使用前準備

1. 到 Discord Developer Portal 建立 Application / Bot。
2. Bot 頁面打開 `MESSAGE CONTENT INTENT`。
3. 用 OAuth2 URL 邀請 Bot 到你的伺服器，權限至少要有：
   - View Channels
   - Send Messages
   - Attach Files
   - Read Message History
4. 到 CoinGlass 帳號取得 API key。

CoinGlass V4 文件：

- Authentication: https://docs.coinglass.com/reference/authentication.md
- Futures supported coins: https://docs.coinglass.com/reference/coins.md
- Futures endpoint index: https://docs.coinglass.com/llms.txt

## 本機設定

複製 `.env.example` 成 `.env`，填入：

```env
DISCORD_BOT_TOKEN=你的_discord_bot_token
COINGLASS_API_KEY=你的_coinglass_api_key
ALLOWED_USER_IDS=你的Discord使用者ID
```

`ALLOWED_USER_IDS` 留空代表所有看得到 Bot 的人都能用。建議一開始先填自己的 Discord user id。

啟動：

```bash
npm install
npm start
```

## Zeabur 部署

1. 把整個資料夾 push 到 GitHub。
2. 在 Zeabur 建立新 Project，選 GitHub repo。
3. 環境變數填：
   - `DISCORD_BOT_TOKEN`
   - `COINGLASS_API_KEY`
   - `ALLOWED_USER_IDS`
   - 需要時填 `ALLOWED_CHANNEL_IDS`
4. Zeabur 會使用 `npm start` 啟動。

## 推上 GitHub

如果你的電腦已有 git：

```bash
git init
git add .
git commit -m "Add Discord CoinGlass futures bot"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

## 指令

```text
btc
!cg eth
!cg btc --exchange Binance --interval 4h --limit 60 --range 24h
!cg help
```

可用參數：

- `--exchange` / `-e`: 預設 `Binance`
- `--interval` / `-i`: `1m,3m,5m,15m,30m,1h,4h,6h,8h,12h,1d,1w`
- `--limit` / `-l`: 歷史資料筆數，預設 `60`
- `--range` / `-r`: 清算統計區間，`1h,4h,12h,24h`

CoinGlass 低階方案常限制歷史 interval 需 `4h` 以上，所以預設用 `4h`。

## 重要說明

這個專案使用 Discord Bot API，不會登入或監控真人使用者帳號。若你想限制只有自己可用，請設定 `ALLOWED_USER_IDS`。

部分 CoinGlass endpoints 需要較高 API 方案。Bot 會盡量抓所有 futures 相關資料；如果某些 endpoints 因權限、方案或速率限制失敗，Discord 訊息會顯示成功數量，完整錯誤會放在 `report.txt` 和 `raw.json`。
