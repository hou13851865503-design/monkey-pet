# 小猴桌宠 · Monkey Pet

一个 Windows 桌面的透明置顶小猴子。八向转头、情绪表情、边缘吸附、番茄钟、待办、剪贴板历史、系统监控、课程提醒，还能接 LLM 聊天、识别名片、每天播报早报。

基于 **Electron + 原生 HTML/CSS/JS**，没有前端框架，逻辑都在 `main.js` / `renderer.js` 里。

## 功能一览

| 分类 | 功能 |
|---|---|
| 基础交互 | 拖动移动、单击随机表情、双击情绪菜单（9 种）、撸它、等比缩放（0.5×–2.5×）、点击穿透 |
| 桌面行为 | 系统闲置 45 秒自动睡、键鼠一动就醒、整点/早晚问候、拖到边缘自动吸附、贴边 4 秒后缩成一条、鼠标靠近探出 |
| 防打扰 | 检测前台全屏（游戏/全屏会议/视频）自动隐藏，退出全屏自动回来 |
| 效率 | 番茄钟 25 分钟（结束系统通知）、今日待办气泡、剪贴板历史（最近 50 条）、CPU/内存/网速监控、课程表与一次性日程提醒 |
| AI | 对话（任意 OpenAI 兼容接口）、名片图片结构化抽取（需视觉模型）、系统语音朗读、每日早报（天气 + 热帖，无需 Key） |

完整用法与常见问题见 **[usage.html](usage.html)**（应用内：右键小猴 →「功能说明 / 快捷键」）。

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+Shift+P` | 点击穿透 |
| `Ctrl+Shift+H` | 显示 / 隐藏 |
| `Ctrl+Shift+T` | 专注 25 分钟 |
| `Ctrl+Shift+O` | 今日待办 |
| `Ctrl+Shift+V` | 剪贴板历史 |
| `Ctrl+Shift+M` | 系统状态 |
| `Ctrl+Shift+K` | 课程 / 日程 |
| `Ctrl+Shift+A` | AI 对话 |
| `Ctrl+Shift+U` | AI 设置 |
| `Ctrl+Shift+R` | 每日早报 |

## 运行

```bash
npm install
npm start
```

打包成安装包（NSIS）：

```bash
npm run dist
```

## 配置

- **AI**：右键小猴 →「AI 设置」，填写 Base URL / API Key / 模型名，点「测试连接」验证。名片识别需要选择**支持图片输入的视觉模型**（如 `gpt-4o-mini`）。
- 所有设置（含 API Key）保存在 `%APPDATA%\monkey-pet\settings.json`，**不会进入仓库**。
- 出网请求使用 Electron `net` 模块，会自动走系统代理；需要代理才能访问的接口请先开启代理。

## 目录结构

```
main.js            主进程：窗口、托盘、拖拽/缩放、吸附、番茄钟、待办、剪贴板、系统监控、课程提醒、AI
preload.js         contextBridge 暴露的 IPC 接口
renderer.js        小猴渲染：八向图、情绪、倾斜、撸它、拖拽手势、语音朗读
index.html         小猴窗口
bubble.html        气泡窗口（提示 / 待办 / 倒数 / 系统状态）
usage.html         功能速查表
todo.html          待办编辑
clip.html          剪贴板历史
schedule.html      课程表 / 日程编辑
settings.html      AI 设置
chat.html          AI 对话
card.html          名片识别结果
tools/             开发辅助脚本（.lnk 生成、前台窗口全屏检测）
assets/            八向图与情绪图素材
```

## 说明

- 单实例运行；重复启动会聚焦已有小猴。
- 「防打扰」依赖 PowerShell 读取前台窗口位置，电源策略受限时会自动降级为不启用。
- 剪贴板历史只保存在内存中，退出即清空。

## License

MIT
