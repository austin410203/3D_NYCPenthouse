# The Aster · 紐約頂樓豪宅 3D 導覽

在瀏覽器裡走進紐約中城 57 街（億萬富翁街）上的虛構豪宅「The Aster」：黃昏藍調的街景、雙層挑高大廳、搭電梯上 171 公尺的全層頂樓，窗外是中央公園夜景。

- 場景在 Blender 5.2 全程序化建模（沒有外部模型或貼圖），用 Cycles 把光照烘焙進 WebP 光照貼圖，輸出 Draco 壓縮的 GLB。
- 城市約 1.2 萬棟建築、大樓窗內的假室內、窗簾都用 GLSL 移植原本的 Blender 程序材質，即時算出燈光窗格。
- three.js 0.170 + three-mesh-bvh 做第一人稱碰撞；AgX 色調映射＋Bloom。

## 操作
| 裝置 | 操作 |
|---|---|
| 電腦 | 點畫面鎖定滑鼠，WASD／方向鍵走路，Shift 快走，E 搭電梯，F 切換飛行模式（Space／C 升降） |
| 手機 | 左下搖桿移動，右側拖曳轉頭，「電梯」按鈕上下樓 |

## 部署
Cloudflare Workers（靜態資產），設定在 `wrangler.jsonc`。原始 Blender 腳本在 `NYC_Penthouse/scripts`（不在這個 repo）：`build.py` 建場景，`export_web.py` 烘焙並輸出 `assets/`。
