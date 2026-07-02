# 柏林公交看板 (BVG Departures PWA)

查看柏林公交、有轨电车、S-Bahn / U-Bahn 的**实时到站倒计时**。
纯前端 PWA,零构建、零依赖,可「添加到主屏幕」当手机 app 用(iPhone / 安卓)。

## 功能

- **📍 附近站点** — 用手机定位,自动列出附近的车站(按距离排序)
- **🔍 搜索** — 按站名搜索任意车站
- **★ 收藏** — 收藏常用站点,并可记住「只看某条线路」
- **只看某条线路** — 进入车站后点顶部线路标签,只看你关心的那条线(如 M4)
- 实时倒计时(每 30 秒刷新数据,每 10 秒刷新倒计时),晚点/准点/取消提示
- 按交通方式配色的线路标签(S-Bahn 绿 / U-Bahn 蓝 / Tram 红 / Bus 紫)

## 数据来源

免费公开 API [`v6.vbb.transport.rest`](https://v6.vbb.transport.rest/)(基于 HAFAS,VBB 官方数据,
覆盖柏林 + 勃兰登堡全域),**无需 API key**,已开启 CORS。注意该免费实例有限流(~100 次/分钟),偶发 `503` 会自动重试。
如需切回仅柏林市区的 BVG,把 `js/api.js` 里的 `API_BASE` 改成 `https://v6.bvg.transport.rest` 即可。

## 本地运行

```bash
node server.js          # 默认 http://localhost:4173
PORT=5050 node server.js # 或指定端口
```

用手机浏览器打开(需与电脑同一 Wi-Fi,把 localhost 换成电脑局域网 IP)。

> 定位功能需要「安全上下文」:`localhost` 或 HTTPS 才可用。在手机上通过局域网 IP(http)访问时定位会被禁用,可改用「搜索」。要在手机上完整体验定位,把这些静态文件部署到任意 HTTPS 托管(如 GitHub Pages / Netlify / Vercel,拖上去即可,无需构建)。

## 装到手机(当 app 用)

1. 把整个文件夹部署到任意 HTTPS 静态托管(Netlify / Vercel / GitHub Pages,直接拖拽上传)
2. 手机浏览器打开该网址
3. iPhone:分享 → 「添加到主屏幕」;安卓 Chrome:菜单 → 「安装应用」

## 文件结构

```
index.html              应用外壳
css/styles.css          样式(移动端深色主题)
js/api.js               BVG API 封装(含重试/退避)
js/store.js             收藏(localStorage)
js/app.js               主逻辑(视图、倒计时、过滤、定位)
manifest.webmanifest    PWA 清单
sw.js                   Service Worker(离线外壳,实时数据始终走网络)
icons/icon.svg          图标
server.js               本地静态服务器(零依赖)
```
