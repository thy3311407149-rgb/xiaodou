# 第二大脑 · 小豆 — 高保真原型

基于 `原型图/底层架构图.html` 完善的移动端 HTML 原型，可直接用于开发对齐。

## 快速预览

用浏览器直接打开：

```
xiaodou-proto/index.html
```

全部 14 个界面以 iPhone 15 Pro 圆角外框 + iframe **平铺**展示，无需构建。

## 目录结构

```
xiaodou-proto/
├── index.html              # 总览入口（iframe 平铺）
├── css/common.css          # 设计系统 / 状态栏 / Tab / 组件
├── assets/                 # 小豆 IP（SVG）
├── docs/PRODUCT.md         # UX 分析 · 信息架构 · 设计规范
└── pages/
    ├── library.html        # 知识库首页
    ├── recording.html      # 录音中
    ├── transcript.html     # 转写预览
    ├── ask.html            # 问小豆空态
    ├── ask-chat.html       # 问小豆对话
    ├── graph.html          # 小豆图谱
    ├── search.html         # 全局搜索
    ├── detail.html         # 文档详情 · AI 拆解
    ├── detail-voice.html   # 录音详情
    ├── detail-note.html    # 笔记详情
    ├── pdf-preview.html    # 原文预览 Sheet
    ├── related.html        # 相关知识 Sheet
    ├── settings.html       # 设置
    └── login.html          # 登录引导
```

## 设计要点

- 设备：393×852（iPhone 15 Pro）
- 风格：暖米白 + 小豆紫（延续底层架构图设计令牌）
- 技术：HTML + Tailwind CDN + Font Awesome 6
- 真实图片：Unsplash（封面 / 头像）
- 含 iOS 状态栏（绿色时间胶囊）+ 底部 3 Tab + FAB

## 开发对齐

详见 [`docs/PRODUCT.md`](docs/PRODUCT.md)。
