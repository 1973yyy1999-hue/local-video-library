# 拾影 · Local Video Library

一个面向 **Windows 10 / 11（64 位 Intel / AMD 电脑）** 的中文本地视频整理器。选择文件夹，用视频网站一样的封面墙浏览硬盘里的视频。

**当前版本：0.1.0 初版。** 开发环境为 macOS；仓库配有 Windows 自动测试与打包。GitHub Windows runner 并非 Windows 10 实机，最终兼容性仍需在你的 Win10 电脑上试用确认。

## 功能

- 添加一个或多个文件夹，递归扫描常见视频扩展名，支持中文路径。
- 按文件夹、格式、收藏和最近播放筛选；按名称、修改时间和大小排序。
- 文件名、文件夹名、标签模糊搜索，支持部分关键词、英文拼写容错；多个词用空格分隔。
- 封面在进入可视区域时生成并缓存；每页 60 条，最多两个媒体处理任务同时执行。
- 鼠标悬停 0.5 秒后播放静音循环预览，移开停止。首次预览需等待生成，之后读取缓存。
- 内置播放器支持进度拖动、全屏、继续播放；不兼容的格式可用系统默认播放器打开。
- 收藏、自定义标签和播放进度保存在本机。
- 扫描可取消；移动硬盘离线时保留已有索引和收藏，重连后点“重新扫描”。

这版搜索针对文件名、相对文件夹路径和手动标签，不识别视频画面、语音或字幕。中文支持关键词匹配，暂不提供拼音搜索。预览取视频约 20% 位置（最长跳过 120 秒）开始的 6 秒，短视频可能不足 6 秒。

## 在 Windows 上下载和使用

1. 打开仓库上方 **Actions → Windows build**，选择最近一个绿色成功的运行。
2. 在底部 **Artifacts** 下载 `LocalVideoLibrary-Windows-x64`（通常需要登录 GitHub）。
3. 解压下载文件；其中 `LocalVideoLibrary-0.1.0-win-x64.zip` 是免安装版。**再将这个 ZIP 完整解压**，双击其中的 `Local Video Library.exe`，不要只复制 EXE。
4. 也可以使用同目录下的 `.exe` 安装包进行安装。
5. 点击“添加视频文件夹”，选择本机或已连接磁盘上的视频目录。

如果有正式版本标签，也可以直接在仓库 **Releases** 下载。此初版没有商业代码签名，Windows 可能显示“未知发布者”；只运行你从本仓库获取并确认来源的构建。

播放器的兼容性取决于文件内的视频与音频编码，扩展名相同不代表编码相同。部分 MKV、HEVC、AVI 或特殊音频文件可能需要系统播放器。封面和预览使用独立的 FFmpeg 处理，因此与完整播放的兼容范围可能不同。无需单独安装 FFmpeg。

## 数据与文件

- 原始视频只读取。移除文件夹是移除索引，不删除视频。
- 索引和缓存位于 `%APPDATA%\local-video-library\`（实际以 Electron 的 userData 目录为准）。
- `library.json` 保存来源路径、收藏、标签及观看进度。迁移前退出程序，备份整个数据目录。
- `cache` 保存 JPG 封面和 MP4 静音预览；如需释放空间，退出程序后删除 `cache`，之后会按需重建。初版尚未提供自动缓存配额。
- 不上传视频、不连接云服务；扫描由用户主动触发，不监控文件夹变动。
- 文件移动或重命名会视作新视频，初版不会自动迁移旧收藏及进度。
- 为防止目录循环，扫描跳过符号链接、隐藏目录及系统回收站。

## 开发

需要 Node.js 22 或更新的受支持版本，以及 npm。

```sh
npm ci
npm start
```

```sh
npm test          # 索引、离线恢复、搜索、视频 Range 请求等测试
npm run test:e2e  # 启动真实 Electron，验证导入、预览、播放、收藏、标签及重启恢复
npm run dist:win  # 在 Windows 上生成 x64 ZIP 和 NSIS 安装包
```

开发依赖第一次安装会下载 Electron 和 FFmpeg，需要访问 npm 与 GitHub。仓库已提交 Windows 构建实际生成的 `package-lock.json`，CI 使用 `npm ci` 按锁定版本安装。

## 自动构建与发布

推送 `main` 后自动执行单元测试、桌面集成测试并生成 Windows 下载文件。只有测试成功后才打包。Artifacts 保留 30 天；仓库管理员可以在 Actions 手动触发新构建。

推送形如 `v0.1.0` 的标签会在测试及打包成功后发布 GitHub Release。发布前确保 `package.json` 的版本与标签一致。

## 技术说明

Electron + 原生 HTML/CSS/JavaScript；Fuse.js 提供模糊搜索；FFmpeg / FFprobe 生成封面、静音预览与视频信息。视频通过本地自定义协议按需流式读取，支持字节范围请求；没有对外监听的 HTTP 服务。渲染进程开启沙箱与上下文隔离，不开放 Node.js；操作文件必须通过主进程中的已登记视频编号。

本项目代码为独立实现。调研参考：[Video Hub App](https://github.com/whyboris/Video-Hub-App)、[LocVid](https://github.com/hoolulu/LocVid)、[Meguri](https://github.com/zabuton-app/meguri)，没有复制这些项目的源代码。

应用源代码采用 [MIT](LICENSE) 许可。第三方组件保留各自许可；FFmpeg 二进制的许可、构建与源码信息见 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 及 [FFmpeg](https://ffmpeg.org/legal.html)。
