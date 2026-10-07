# Gemma 多模态搜索

Gemma 多模态搜索是一个本地优先的图片、视频、音频、PDF 和文本语义搜索工具。模型推理、索引和搜索均在本机完成；联网只用于首次下载模型文件。

## 安装

### Linux

下载 `GemmaSearch-*-x86_64.AppImage` 后执行：

```bash
chmod +x GemmaSearch-*.AppImage
./GemmaSearch-*.AppImage
```

Ubuntu/Debian 也可以安装 `GemmaSearch-*.deb`：

```bash
sudo apt install ./GemmaSearch-*.deb
```

### Windows

运行 `GemmaSearch Setup *.exe` 安装版。无需安装的场景可使用同目录下的 portable 版本。

### macOS

发布包提供 Intel（x64）和 Apple Silicon（arm64）zip。解压后将 `GemmaSearch.app` 拖到“应用程序”。

首次打开未签名版本时，如果系统阻止启动，请到“系统设置 → 隐私与安全性”点击“仍要打开”。也可以在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/GemmaSearch.app
```

如果 Apple Silicon 提示“已损坏”，可执行一次临时 ad-hoc 签名：

```bash
codesign --force --deep -s - /Applications/GemmaSearch.app
```

macOS 版本不提供自动更新，请手动下载新 zip 替换旧版本。

## 首次使用

首次启动会下载文本、视觉和音频模型。下载地址可在“设置 → 模型来源”中切换为 Hugging Face 镜像；模型缓存保存在本机浏览器/Electron 用户数据目录。然后点击“添加文件夹”，选择需要建立索引的本地目录。

索引和搜索不上传文件内容。Electron 版本会监听已添加文件夹的新增、修改和删除，并增量更新索引。

## 开发与打包

```bash
npm install
npm run dev             # Web 开发模式
npm run electron:dev    # Electron + Vite 开发模式
npm run typecheck
npm run lint
npm run test:run
npm run dist:linux      # Linux AppImage + deb
npm run dist:win        # Docker 中构建 Windows NSIS + portable
npm run dist:mac        # macOS x64/arm64 zip
```

Windows 打包脚本需要 Docker，并使用 `electronuserland/builder:wine`。macOS zip 在 Linux 上生成未签名包；在 macOS CI 上会执行 ad-hoc `codesign`，不进行 notarization。

## 隐私与限制

本项目默认使用 WebGPU，无法使用时回退到多线程 WASM。不同后端或精度产生的向量不会混用，切换后需要重建索引。浏览器和 Electron 均不提供云端向量数据库或远程推理服务。
