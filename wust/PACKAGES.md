# 未入库的大体积发布包

下面两个包体积较大（34.6 MB / 67.7 MB），**不放进 git**，只保留在本机：

- `Desktop\Course Copilot 武科大版\wust-review-site-windows-v1.1\outputs\`
- 或 `Downloads\`

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `课里有话-武科大网站测试包-2026-10-11.zip` | 34.6 MB | `DAA0986667D53AB1CDC781B75C42A63B7573693023DA14CB9996B86E251F8164` |
| `课里有话-Windows免安装体验包-2026-10-11.zip` | 67.7 MB | `978CC69E62484D5BEBDF7E440108FFA642D5C75D139A50B6ABBE139106501E6A` |

两者区别：

- **网站测试包**：需要自己装 Node.js 24，解压后双击 `启动网站.cmd`。
- **Windows 免安装体验包**：内置 `node.exe` v24.19.0 x64，双击 `双击启动网站.cmd` 即可，不需要安装 Node。

## 已入库的小版本包

`plugin/` 与 `reader/` 下的 zip 全部入库，合计约 0.5 MB：

| 文件 | SHA-256（前 16 位） |
|---|---|
| `plugin/course-copilot-wust-v0.3.0.zip` | `468FDD391097BA66` |
| `plugin/course-copilot-wust-v0.4.0.zip` | `84ACEE6E35062035` |
| `plugin/course-copilot-wust-v0.4.1.zip` | `66DF801A6018E2A1` |
| `plugin/course-copilot-wust-v0.4.2.zip` | `BFC2A157D13BCF86` |
| `plugin/course-copilot-wust-v0.5.0.zip` | `AFBFE8C0F9B85E81` |
| `plugin/course-copilot-wust-v0.5.1.zip` | `8A9B78257348064A` |
| `reader/wust-course-reader-v0.1.0.zip` | `D6A890811FFAC328` |
| `reader/wust-course-reader-v0.2.0.zip` | `0E8E60E89429F01F` |
| `reader/wust-course-reader-v0.2.1.zip` | `AFC90140FABAF267` |
| `reader/wust-course-reader-v0.2.2.zip` | `2531FDC7657586B0` |
