# 🐒 小猴桌宠 · Monkey Pet

![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-3DA639)
![Version](https://img.shields.io/badge/version-0.6.0-3B82F6)
![Stars](https://img.shields.io/github/stars/hou13851865503-design/monkey-pet?style=social)

一个常驻 Windows 桌面的透明小猴子：会跟着你的鼠标转头、会睡觉、会生气也会害羞，还能当番茄钟、待办本、剪贴板管理器、系统监视器和 AI 助手。

**纯 Electron + 原生 HTML/CSS/JS**，没有前端框架，也没有打包器 —— 逻辑全在 `main.js` / `preload.js` / `renderer.js` 里。

<p align="center">
  <img src="docs/screenshot.png" width="320" alt="小猴实际运行截图" />
  <br />
  <sub>实际运行时的窗口截图（透明背景，2× 截取）</sub>
</p>

<p align="center">
  <img src="assets/contact_emotions_dark.png" width="440" alt="小猴的八向转头与情绪表情" />
  <br />
  <sub>八向转头 + 9 种情绪（素材预览）</sub>
</p>

## 目录

- [功能](#-功能)
- [快捷键](#-快捷键)
- [快速开始](#-快速开始)
- [配置](#-配置)
- [技术实现](#-技术实现)
- [目录结构](#-目录结构)
- [常见问题](#-常见问题)

## ✨ 功能

### 桌面陪伴

| | |
|---|---|
| 八向转头 | 鼠标在哪个方向就看向哪边，禁用了背面帧，永远不会背对你 |
| 伪 3D 倾斜 | 跟随光标做轻微透视倾斜；切帧用透明度交叉淡入，没有硬切 |
| 情绪系统 | 生气 / 开心 / 喜欢 / 难过 / 害羞 / 困 / 惊讶 / 思考 / 眨眼 |
| 自动睡眠 | 系统闲置 45 秒睡着，键盘鼠标一动就醒 |
| 整点问候 | 早、中、下午、晚、深夜五套台词，启动时也会打招呼 |
| 撸它 | 鼠标在身上左右快速来回划，会害羞或开心 |

### 桌面行为

- **边缘吸附**：拖到屏幕边缘 16px 内松手自动贴边
- **贴边半隐藏**：停靠 4 秒后缩成一条，鼠标移上去自动探出来
- **防打扰**：检测到前台全屏（游戏 / 全屏会议 / 全屏视频）自动隐藏，退出全屏自动回来
- **点击穿透**：一键让鼠标穿过小猴点到后面的窗口
- **记忆**：位置、大小、各项开关全部持久化；单实例运行，重复启动只聚焦已有窗口

### 效率工具

| 工具 | 说明 |
|---|---|
| 🍅 番茄钟 | 25 分钟专注，每分钟播报剩余时间，结束弹系统通知 |
| 📝 今日待办 | 独立编辑窗口，气泡查看；**没做完自动顺延到明天**，完成后不再出现 |
| 🔔 未完成提醒 | 每 10 分钟用气泡列出还没做完的任务，全部完成即停，可当天静音 |
| 📋 剪贴板历史 | 保留最近 50 条，可搜索，回车即复制回剪贴板（仅内存，退出清空） |
| 📊 系统监控 | CPU 占用、内存用量、网络上下行实时速度 |
| 📚 课程 / 日程 | 每周课程 + 一次性日程，提前 N 分钟用气泡提醒 |

### AI

| 能力 | 说明 | 需要 Key |
|---|---|---|
| 💬 对话 | 任意 OpenAI 兼容接口，回答走小猴气泡风格 | ✅ |
| 🪪 名片识别 | 把名片图片拖到小猴身上，抽成结构化字段（姓名/公司/职位/电话/邮箱/地址/网址），可一键复制 JSON | ✅ 视觉模型 |
| 📄 PDF 论文解析 | 拖入 PDF 或 `Ctrl+Shift+D`，抽出**研究问题 / 研究方法 / 主要结论 / 关键贡献**，可看 JSON、复制、导出 Markdown | ❌（配了更准） |
| 🔊 语音朗读 | 用系统 TTS 朗读回复、早报和提醒 | ❌ |
| 🌤 每日早报 | 天气 + 一条热点，可设定每天自动播报 | ❌ |

> 完整用法、常见问题见 **[usage.html](usage.html)**（应用内：右键小猴 →「功能说明 / 快捷键」）。

## ⌨️ 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+P` | 点击穿透开关 |
| `Ctrl+Shift+H` | 显示 / 隐藏小猴 |
| `Ctrl+Shift+T` | 开始 / 停止专注（25 分钟） |
| `Ctrl+Shift+O` | 今日待办 |
| `Ctrl+Shift+V` | 剪贴板历史 |
| `Ctrl+Shift+M` | 系统状态 |
| `Ctrl+Shift+K` | 课程 / 日程 |
| `Ctrl+Shift+A` | AI 对话 |
| `Ctrl+Shift+U` | AI 设置 |
| `Ctrl+Shift+R` | 立即生成每日早报 |
| `Ctrl+Shift+D` | PDF 论文解析 |

## 🚀 快速开始

**环境要求**：Windows 10/11、Node.js 18+

```bash
git clone https://github.com/hou13851865503-design/monkey-pet.git
cd monkey-pet
npm install
npm start
```

打包成安装包（NSIS）：

```bash
npm run dist
```

产物在 `dist/`。首次运行会出现在屏幕右下角，托盘也有图标。

## ⚙️ 配置

右键小猴 →「AI 设置」，接入 **WorkBuddy API**（OpenAI 兼容协议）：

| 字段 | 说明 | 示例 |
|---|---|---|
| Base URL | 填到 `/v1` 为止，程序自己补 `/chat/completions` | `https://<你的接口地址>/v1` |
| API Key | WorkBuddy 后台给的 Key | `sk-...` |
| 模型 | 默认固定 `DeepSeek-V4.1-Flash`，点「改用其他模型」可解锁 | `DeepSeek-V4.1-Flash` |
| 超时 / 重试 | 默认 25000ms / 2 次，只对限流、5xx、网络异常重试 | `25000` / `2` |

- **没配也能用**：对话、名片识别提示去配置，PDF 论文解析自动降级成规则抽取，桌宠本身照常跑。
- **点「测试连接」**会发一条极小请求，失败时直接显示错误码（`auth` / `model-not-found` / `network` / `timeout`…），不用猜。
- 地址末尾多一个 `/` 会被拼成 `//chat/completions`，已经写到 `/chat/completions` 的又会被重复拼——这两种情况 `wb.js` 都兜住了。
- 所有设置（含 Key）保存在 `%APPDATA%\monkey-pet\settings.json`，**不会进入仓库**。
- 出网请求走 Electron `net` 模块，会自动使用系统代理；访问需要代理的接口前请先开启代理。

## 🧠 技术实现

- **主进程 `main.js`**：创建透明无边框置顶窗口；用主进程轮询真实光标位置实现拖拽（不依赖渲染端 pointermove）；`resizable: true` + `min == max` 锁死尺寸，让 `setPosition` 生效又不会改变大小；`powerMonitor.getSystemIdleTime()` 做睡眠检测；番茄钟、课程提醒、早报等定时任务都在主进程。
- **预加载 `preload.js`**：只通过 `contextBridge` 暴露白名单 IPC，渲染进程没有 Node 权限（`contextIsolation: true`）。
- **渲染进程 `renderer.js`**：17 张图叠层，靠 `opacity` 过渡实现切帧连贯；`requestAnimationFrame` 做倾斜缓动；手势状态机区分「点击 / 拖拽 / 长按 / 撸」。
- **多窗口**：气泡、待办、剪贴板、课程、设置、聊天、名片结果、论文解析、使用说明都是独立窗口，按需创建、关闭即销毁。
- **论文解析 `paper.js`**：纯 Node 模块（不依赖 Electron，可单独跑测试）。`pdfjs-dist` 逐页抽文字 → 按标题行切章节 → 拼成压缩后的 digest → 交给 LLM；没配 Key 时走同一套字段结构的启发式规则。两条路径输出**同构**，前端不需要分支。
- **WorkBuddy API `wb.js`**：纯 Node 客户端，只认注入进来的 transport（Electron 里是 `net.request`，测试里是 Node `http`）。负责地址拼接、错误码分类、限流/5xx/网络异常的重试退避、连续失败熔断，以及把各家不同的回复形态（`content` 字符串 / 分段数组 / `reasoning_content`）归一化。**永不抛异常**，所有失败都返回 `{ok:false, code}`，所以接口挂了也不会拖垮桌宠。
- **每日任务 `daily.js`**：任务只存在"创建那一天"下，`onDate()` 计算某天该看到哪些（没完成的自动顺延），跨天不重置勾选。
- **网络**：统一走 `net.request`，这样能继承系统代理和证书设置。

## 📁 目录结构

```
main.js            主进程：窗口 / 托盘 / 拖拽缩放 / 吸附 / 定时任务 / AI
preload.js         contextBridge 暴露的 IPC 白名单
renderer.js        小猴渲染与手势
daily.js           每日任务数据模型（跨天顺延）
paper.js           PDF 论文解析（抽文本 / 切章节 / 规则与 LLM 双路抽取）
wb.js              WorkBuddy API 客户端（地址拼接 / 错误码 / 重试 / 熔断）
index.html         小猴窗口
bubble.html        气泡窗口（提示 / 待办 / 倒计时 / 系统状态）
usage.html         功能速查表
todo.html          今日待办编辑
clip.html          剪贴板历史
schedule.html      课程 / 日程编辑
settings.html      AI 设置
chat.html          AI 对话
card.html          名片识别结果
paper.html         PDF 论文解析窗口
tools/             开发辅助（图标 / 切图 / 前台窗口检测 / 回归测试）
assets/            八向图与情绪图素材
```

## ❓ 常见问题

| 现象 | 解决 |
|---|---|
| 改了代码不生效 | 单实例锁：先右键「退出」再重新打开 |
| AI 请求失败 | 打开「AI 设置」点「测试连接」，按错误码排查：`auth`=Key 不对、`model-not-found`=模型名不对、`network`=没网/没开代理、`timeout`=接口慢 |
| 名片识别无结果 | `DeepSeek-V4.1-Flash` 是纯文本模型，点「改用其他模型」换视觉模型 |
| TTS 没声音 | Windows 设置 → 时间和语言 → 语音，添加中文语音 |
| 论文解析提示「可能是扫描件」 | PDF 里没有可选中文字，需先做 OCR；不配 Key 也能用规则抽取 |
| 网速显示 N/A | PowerShell 的 `Get-NetAdapterStatistics` 不可用，CPU/内存不受影响 |
| 早报获取失败 | 网络或代理问题，天气用 wttr.in、热点用 V2EX |

## 📄 License

[MIT](https://choosealicense.com/licenses/mit/)
