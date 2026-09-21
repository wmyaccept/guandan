# 掼蛋桌

四人两副牌，南北一家、东西一家，从 2 打到 A。打开页面就能开房、加人，空位可以补机器人。

## 本地启动

需要 Node.js 18 或以上。

```bash
npm install
npm test
npm start
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。同一 Wi-Fi 下的朋友用你的电脑 IP 加房间号就能进桌。

## 规则（这版怎么判）

- 两副 54 张，每人 27 张。级牌是当前庄家那队的级数，红桃级牌是逢人配。
- 牌型：单张、对子、三张、三带二、顺子（5 张）、连对（至少 3 对）、钢板（至少 2 组三张）、炸弹、同花顺、天王炸。
- 大小：普通牌型要比同种同张数；炸弹大于普通牌。炸弹链是 4炸 < 5炸 < 同花顺 < 6炸 < … < 天王炸。
- 顺子只走 3 到 A，2 和王不能进顺子。逢人配可以当 3 到 A 里的任何一张。
- 头游 / 二游 / 三游 / 末游：双下升 3 级，头三升 2 级，头末升 1 级。打 A 时只有双下或头三算过 A。
- 双下不进贡。其余由末游（或头末时的二三游）进贡最大牌，双大王可抗贡，然后还贡。
- 有人出完并拿走该墩后，对家接风。

## 部署

这是带 WebSocket 的 Node 服务，不适合只丢静态网页的托管。

### 腾讯云

用轻量应用服务器最省事：装 Node 22，把代码拷上去后 `npm install && npm start`，防火墙放行 3000 端口。也可以装 Docker：

```bash
docker build -t guandan .
docker run -d -p 80:3000 --name guandan guandan
```

域名和 HTTPS 用 Nginx 反代到 3000，并开启 WebSocket 升级。云函数 / 网页托管不适合这套长连接。

新用户轻量机通常比 CVM 便宜，够 4 人小桌。

### 免费或接近免费

- [Render](https://render.com) 和 [Fly.io](https://fly.io) 能跑 Node + WebSocket，免费档会休眠，唤醒要等几秒。
- [Railway](https://railway.app) 有试用额度，适合短时间公开一桌。
- 电脑在家开着时，可用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 或 ngrok 把 `localhost:3000` 映出去，不用买服务器。

四个人同时打，一台 1 核 1G 就够。
