# 小屋

一个手机优先的私人 AI 聊天 PWA。

## 现在有什么

- 聊天页：填好 API 后可以聊天。
- 动态页：点“写今天”，让 AI 按人设写一条纯文字日记。
- 设定页：保存 AI 名字、人设、Memory、最近摘要。
- API 页：保存 API 地址、Key、模型、温度、最大输出。
- 支持添加到手机主屏幕。
- 支持 Vercel 部署，带可选代理接口。
- 使用 Node 后端时，手机状态会保存到服务器；服务器每 5 分钟会在页面关闭时判断一次是否要自行使用手机。
- 可选主动消息：长时间未回复时由 AI 判断是否自然追问，并通过手机通知送达。

## Node 后端部署

服务器目录可直接运行：

```bash
npm install
npm start
```

Node 后端会提供网页和 `/api` 接口，并在服务器内定时运行手机自主使用与主动消息检查。手机每天北京时间 09:00–次日 02:00、每 1 小时检查一次；主动消息每天北京时间 09:00–24:00、每 90 分钟检查一次。每次都先交给 AI 判断，不会按间隔固定执行或发送。没有配置 Upstash Redis 时，轻量服务器会把数据保存在项目下的 `.data/` 目录；配置了 Redis 后会自动改用 Redis。手机打开页面时会把手机状态同步到服务器，后台产生的备忘录、待办或浏览记录会在下次打开时取回。

主动消息仍需要 HTTPS 才能让 iPhone PWA 接收系统推送；服务器首次启动会自动生成并保存 VAPID 密钥，不需要手动复制。生产环境请再为服务器配置域名和 HTTPS。

## 本地预览

```bash
python3 -m http.server 4173
```

然后打开：

```text
http://127.0.0.1:4173
```

## 手机使用

部署成功后，用手机浏览器打开网址：

- iPhone Safari：分享按钮 -> 添加到主屏幕
- Android Chrome：菜单 -> 添加到主屏幕

第一次打开后，先去 API 页填写：

- API 地址，例如 `https://api.openai.com/v1`
- API Key
- 模型名，例如 `gpt-4.1-mini`

如果直连失败，可以把连接方式切到“代理”。代理只转发请求，不保存 Key。

## 部署到 Vercel

最简单的路线：

1. 注册或登录 Vercel。
2. 安装并登录 Vercel CLI。
3. 在这个文件夹运行 `vercel`。
4. 按提示确认项目名和部署目录。
5. 部署完成后，Vercel 会给你一个网址。

之后手机打开那个网址并添加到主屏幕即可。

## 开启主动消息

主动消息需要一个很小的云端存储和一个定时检查。它不会按固定文案轰炸：只有最后一条是 AI 发的、你还没回复、等待时间已到且不在免打扰时段，才会让模型判断要不要补一句。你一回复，未发送的追问会立即取消。

### 1. 准备存储

在 Vercel 项目里创建 Upstash Redis，或者直接使用已有的 Upstash Redis。把下面两项加入 Vercel 的 Environment Variables：

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

如果 Vercel 自动提供的是 `KV_REST_API_URL` 和 `KV_REST_API_TOKEN`，小屋也能直接识别。

### 2. 生成通知密钥

在项目目录运行：

```bash
npx web-push generate-vapid-keys --json
```

把结果和两个随机密钥一起填入 Vercel：

```text
VAPID_PUBLIC_KEY=生成结果里的 publicKey
VAPID_PRIVATE_KEY=生成结果里的 privateKey
VAPID_CONTACT=mailto:你的邮箱
PROACTIVE_ENCRYPTION_KEY=一段足够长的随机字符串
CRON_SECRET=另一段足够长的随机字符串
```

随机字符串可以分别运行一次：

```bash
openssl rand -hex 32
```

`VAPID_PRIVATE_KEY`、`PROACTIVE_ENCRYPTION_KEY` 和 `CRON_SECRET` 不要放进网页代码或发给别人。

### 3. 设置定时检查

重新部署后，让一个定时服务每 30 分钟访问一次：

```text
https://你的域名/api/proactive-tick?secret=你的CRON_SECRET
```

推荐使用任意支持 HTTP GET 的定时服务。这个地址只负责检查是否满足发送条件，不代表每次检查都会产生消息或模型费用。

### 4. 在手机开启

1. 用 iPhone Safari 打开小屋并“添加到主屏幕”。
2. 从主屏幕打开小屋。
3. 进入 API 页面，打开“主动消息”。
4. 调整等待时间、每天上限和免打扰时段。
5. 点“开启手机通知”，允许系统通知，再点“保存 API”。

默认规则是等待 6 小时后才考虑第一次联系，最多追问 2 轮、每天最多 2 条，23:00 到 09:00 不打扰。
