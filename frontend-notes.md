# Frontend & Brand Design Notes - Binnacle

本文件記錄 Binnacle（合規安全箱）專案的前端 UI 規範、品牌設計資產以及本次 Logo 設計決策。

---

## 1. 品牌 Logo 與視覺資產 (已複製至前端公共目錄)

為展現可愛輕鬆的動漫風格並拒絕 AI 感，我們設計了三款手繪/線條溫暖的卡通 Mascot，最終選定 **方案二：羅經箱小精靈（Mascot Box）** 為專案核心形象，並以此衍生了前端插畫與社群橫幅。

### A. 品牌 Logo 與 Mascot 形象

````carousel
![Logo 方案二（已選定）：羅經箱小精靈](/Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/apps/auditor-ui/public/logo_mascot_box.png)
<!-- slide -->
![Logo 方案一：海象與羅經箱](/Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/apps/auditor-ui/public/logo_mascot_walrus.png)
<!-- slide -->
![Logo 方案三：仰漂小海獺](/Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/apps/auditor-ui/public/logo_mascot_otter.png)
````

### B. 衍生視覺資產 (Mascot Box 模板)

| 資產類型 | 畫面特點 | 用途 / 適用場景 | 檔案路徑 |
| :--- | :--- | :--- | :--- |
| **網頁插圖 (Hero Illustration)** | 羅經箱小精靈在潛水艇艙內用羽毛筆撰寫 Logbook，外景為深藍海洋與氣泡。 | 用於前端 UI 首頁 Hero Section 背景或大版面裝飾。 | [hero_illustration.png](file:///Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/apps/auditor-ui/public/hero_illustration.png) |
| **社群橫幅 (Social Banner)** | Mascot Box 抱著日誌揮手，背景為星盤、羅盤線與發光網格（3:1 寬屏比例）。 | 用於 Twitter/X 等社群 Banner，或更新網頁大橫幅。 | [social_banner.png](file:///Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/apps/auditor-ui/public/social_banner.png) |

---

## 2. 視覺與色彩規範 (Style Guide)

*   **背景色 (Deep Ocean)**: `#0A1128` (深海藍)
*   **黃銅色 (Antique Brass)**: `#D4AF37` / `#C5A059`
*   **霓虹綠 (Teal/Emerald)**: `#00F2FE` (用於合規狀態與 Scan 動畫)
*   **字型**: `Space Grotesk` (標題) / `JetBrains Mono` (日誌)

---

## 3. 已完成工作與更動檔案

*   **Logo 設計**：生成了 3 款手繪動漫風格的品牌 Mascot 設計，並正式選定 **羅經箱小精靈**。
*   **衍生資產設計**：以羅經箱小精靈為核心，生成了前端背景插畫及 3:1 比例社群橫幅。
*   **放置檔案**：將所有圖片資產複製至 Next.js 專案公共目錄 `apps/auditor-ui/public/`：
    *   `logo_mascot_box.png` (核心 Logo)
    *   `logo_mascot_walrus.png` (備選 Logo)
    *   `logo_mascot_otter.png` (備用 Mascot)
    *   `hero_illustration.png` (網頁大背景插畫)
    *   `social_banner.png` (社群 / UI Banner)
*   **建立設計筆記**：新建並更新 [frontend-notes.md](file:///Users/ramonliao/Documents/Code/Project/Web3/Hackathon/2026_Sui_Overflow/Tracks/3-Walrus/01-compliance-vault/frontend-notes.md) 紀錄品牌視覺資產。

---

## 4. 尚未完成之 TODO
- [ ] 將選定的 `logo_mascot_box.png` 實裝入 `apps/auditor-ui` 的導覽列 (Navbar)。
- [ ] 將 `hero_illustration.png` 整合進前端首頁的 Hero section。
- [ ] 在 Next.js 專案中配置全域字型與 CSS 主色變數。

