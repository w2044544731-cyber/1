# 商品流：妙手 ERP → Temu 全托管自动工作台

网页软件，用于读取妙手已采集商品，按分类更换主图背景，保留原始商品与 SKU，保存到采集箱并提交 Temu 全托管发布任务。包含可运行的独立演示模式。

**本地功能和模拟服务工作流已经验证；尚未验证用户真实妙手账号、图片服务或 Temu 上架。** 真实店铺商品保存接口路径未在现有附件中提供，应用不会猜测路径。发布成功响应只表示任务接受，不表示最终上架。

## 启动与验证

需要 Node.js >=24.5；当前验证版本为 24.19.0。使用原生 Node.js，无第三方生产依赖、数据库、npm install 或构建步骤。

```sh
npm start
```

真实模式默认监听 127.0.0.1:3000。独立演示模式：

```sh
npm run start:demo
```

演示默认使用 127.0.0.1:3001，与真实模式分开保存数据。演示的妙手/Temu请求全部由进程内模拟服务处理，不使用真实 ERP 凭证，不访问真实店铺；演示文本 AI 也被关闭。图像 AI 如未配置仍不可调用。

```sh
npm run check
npm test
curl --fail --silent http://127.0.0.1:3000/health
```

健康响应为 `{"status":"ok","app":"listing-workbench"}`。测试覆盖商品持久化、原子并发写入、版本冲突、图片分离、CSV、签名、认领映射、保存后核对、发布去重、未知结果处理、重启恢复与图像编辑契约。模拟测试不证明真实平台授权。

默认仅供本机单用户运行，没有登录和团队权限。公网图片可通过反向代理单独开放 `/media/`；商品数据和管理 API 应继续限制访问。`PORT`、`HOST` 可覆盖监听位置；HTTPS 管理入口使用 `APP_ORIGIN` 配置允许的精确来源。

## 从采集箱到发布

1. 点击“读取妙手采集箱”，分页查看公共采集箱，按来源商品 ID 搜索，选择最多 20 件并导入。来源链接与完整 SKU、属性、图片数据一并保留。
2. 按商品标题/分类选择厨房、家居、办公、户外场景；可上传商品原图、上传真实场景背景或生成白底图。也可使用独立的 AI 图像编辑功能。
3. 选择所需商品，点击“批量自动上架”。可按分类自动生成尚缺的场景图。逐件查看结果，核对商品外观后勾选图片确认，填写妙手店铺 ID 并预览配置。
4. 配置齐全时提交自动任务。公共采集箱商品依次经历：托管图片并验证公网读取 → 读取最新详情 → 保存主图与 ossMd5 → 重新读取核对 → 认领到 pddkj → 保存平台商品 ID 映射。
5. 已有 Temu 店铺副本可按店铺 ID、详情 ID 读取导入；跳过公共采集箱保存与认领。两种来源都继续：读取店铺详情 → 基础字段/类目规则检查 → 提交前再次读版本 → 保存店铺主图 → 读回核对 → 提交发布任务。
6. “自动上架任务”展示每件商品、当前阶段与写入记录，可停止剩余商品。当前商品继续完成，停止操作不能撤销已经发送的远端请求。

自动队列只替换**第一张主图**，保留其余图片、颜色变体、价格、库存、包装和 SKU。编辑器的标题/价格/库存等本地编辑可导出，但不在自动队列的远端写回范围内。多 SKU 商品不合并为一个价格或库存；本地图片审核不要求虚构汇总价格，平台资料仍由后续校验与远端保存检查。

本地模板算法去除与边缘连通的近白背景，保留封闭的白色区域，输出 1000×1000 PNG。它适合透明或浅色纯底商品，不能替代复杂背景抠图；内置背景为插画模板。真实背景可自行上传。所有处理结果保留原图，任何编辑都使图片审核失效。

仍支持 CSV/JSON 商品资料、包含 Product JSON-LD 的 HTML、手工创建、批量字段编辑、JSON/CSV 导出。仅填写来源链接不会自动抓取网页；离线商品与响应快照不能进入真实自动发布队列。

## 妙手签名配置

用户附件给出的开放平台基础域名为 `https://openapi-erp.91miaoshou.com`，请求使用 HMAC-SHA256。环境中必须提供真正参与签名计算的 App Secret，不能用仅在 HTTPS 代理处替换的占位值计算 HMAC。

| 变量 | 用途 / 默认值 |
| --- | --- |
| MIAOSHOU_AUTH_MODE | 设置为 signed；存在 AppKey/Secret 时也优先选择签名模式 |
| MIAOSHOU_APP_KEY | 当前应用 AppKey；安全环境配置 |
| MIAOSHOU_APP_SECRET | App Secret；通过部署运行时的安全环境注入，不放到仓库或聊天 |
| MIAOSHOU_BASE_URL | HTTPS 根域名，默认上述开放平台域名 |
| MIAOSHOU_SUCCESS_CODE | 严格匹配成功码；依据附件样例默认 200，需实际授权接口确认 |
| MIAOSHOU_WRITE_ENABLED | true 才允许公共保存、认领和店铺保存 |
| MIAOSHOU_SHOP_SAVE_PATH | 经过官方文档核实的店铺保存路径；**没有猜测默认值** |
| ERP_PUBLISH_ENABLED | true 才允许发布任务提交 |

签名消息为 `appSecret + path + timestamp + appKey + body_json + appSecret`，用 appSecret 作 HMAC-SHA256 key，输出小写 hex。timestamp 是 Unix 秒。请求头为 x-app-key、x-timestamp、x-sign。请求体先进行紧凑 UTF-8 JSON 序列化，对同一字节串签名并发送，禁止重定向，不自动重试写请求。

现有店铺保存构造契约是 `{detailId, shopId, shopCollectItemInfo}`，但实际写接口和其他并发字段仍需对应官方文档核实。如果真实保存接口契约不同，必须调整适配器再联调，不能只填入类似的路径。

旧版 Cookie/timerToken 店铺详情与直接发布接口仍保留兼容，配置为 ERP_API_BASE_URL、ERP_COOKIE、ERP_TIMER_TOKEN、ERP_READ_SUCCESS_CODE、ERP_PUBLISH_SUCCESS_CODE 和发布开关。它们不用于新的公共采集箱签名队列。直接发布界面明确只发布妙手现有内容，不写回本地图片。

## 图片托管与 AI 图像编辑

| 变量 | 用途 |
| --- | --- |
| IMAGE_PUBLIC_BASE_URL | 应用 `/media/` 的公开 HTTPS 基础地址，例如 `https://实际图片域名`；不要填示例域名 |
| IMAGE_SOURCE_HOSTS | 原图允许读取的域名，用逗号分隔；按实际图片 URL 配置，可使用 `*.实际图片域名` |
| SCENE_IMAGE_BASE_URL | OpenAI-compatible 基础地址，默认 https://api.openai.com/v1 |
| SCENE_IMAGE_MODEL | 图像编辑模型，默认 gpt-image-1；中转站必须明确支持该模型与契约 |
| SCENE_IMAGE_API_KEY | 图像服务安全密钥；浏览器不接收密钥 |

托管以 PNG 内容 SHA-256 命名，保存在数据目录的 media 子目录，提供 `/media/<hash>.png`。**真实流程在任何 ERP 写入前，从配置的公网 URL 下载并核对内容哈希**；不可读或内容不同立即停止。此模式需要实际部署和 HTTPS 反向代理，不能把本地 data URL 或 loopback 地址作为 ERP 商品图。图片地址是否被妙手/Temu允许仍需真实验证；如必须使用指定图床，需按其上传文档添加适配器。

原图下载只使用已保存的商品 URL，受 IMAGE_SOURCE_HOSTS 限制，拒绝本机/内网常见地址、带账号 URL、重定向、超大数据与无效图片。未配置域名时，可尝试浏览器允许的跨域读取或手动上传原图。

AI 图片功能向 `<SCENE_IMAGE_BASE_URL>/images/edits` 发送 multipart/form-data，包括 model、prompt、image、n=1、size=1024x1024、output_format=png。当前适配器要求响应 `data[0].b64_json` 是 PNG；不自动追随任意输出 URL，不把对话接口当作图像接口。保留商品外观的提示词不能保证模型不改变商品，生成后仍须检查和确认。

DeepSeek 兼容文字场景方案保留为可选功能：SCENE_TEXT_API_KEY、SCENE_TEXT_BASE_URL（默认 https://api.deepseek.com）、SCENE_TEXT_MODEL（默认按用户文档为 deepseek-flash）。它只发送标题、分类与描述，生成场景建议和提示词，不生成或修改图片。标题/分类/描述变更会清除旧文字方案。

## 任务与数据保护

数据默认保存在 Git 忽略的 `.local-data/products.json`，`DATA_DIR` 可指定独立目录；演示脚本固定使用 `.local-data/demo/`。原始采集箱快照不会被场景处理覆写；同步快照、ossMd5、认领 ID 映射及发布记录另存。不要删除损坏文件或历史任务来假装恢复正常。

所有写操作发送前先持久化阶段记录；相同 requestId 重复请求返回原任务。相同主图对同一来源商品/店铺已有提交记录时阻止再次发布。超时、无效响应或中断可能造成远端结果未知，该商品不自动重试，新任务也会被阻止，需在妙手核对。明确失败且没有未知写结果时，可以在修复字段后重新预览；成功的认领映射可复用。

服务重启后，旧排队任务标记停止；已开始且存在远端写入的任务标记需核对，不自动续跑或重放。任务中的商品不允许编辑、删除、重新审核或导出。提交预览绑定本地版本、图片、来源快照和店铺；执行时重新读远端快照，不覆盖检测到的其他修改。店铺保存 API 是否提供真正的服务端并发控制仍需文档核实；本地再次读取不能完全消除并发窗口。

限制：本地商品 500 件、每次普通导入/导出 100 件、每个自动任务 20 件、自动任务记录 100 条、旧直接发布记录 200 条。单次 JSON 请求 12 MB，原图 6 MB，详情响应 2 MB。当前单进程队列，JSON 持久化不支持多进程同时写同一目录。

## 服务端接口

| 路径 | 用途 |
| --- | --- |
| GET /health、GET /api/state | 健康、商品与任务记录 |
| GET /api/integrations | 配置完整性与缺少的变量名；不返回密钥，不表示已连通 |
| POST /api/collect-box/list | pageNo、pageSize、keyword；读取公共采集箱 |
| POST /api/collect-box/import | detailId；读取完整详情并导入 |
| POST /api/erp/details/read | detailId、shopId；读取 Temu 店铺副本 |
| POST /api/erp/details/import | 离线店铺响应导入，不能用于真实自动队列 |
| POST /api/workflows/preview | shopId、products[{id,revision}]；不调用外部写接口 |
| POST /api/workflows | 相同参数、previewHash、requestId、confirmed=true；任务排队 |
| POST /api/workflows/:id/stop | 停止剩余商品 |
| GET /api/products/:id/source-image | 读取已保存且允许访问的原图 |
| POST /api/products/:id/ai-image | revision、prompt；编辑原图并另存草稿 |
| GET /media/:hash.png | 公开、不可变的 PNG 图片 |
| POST /api/scene/plan | 文本场景建议 |
| POST /api/publish/preview、POST /api/publish | 高级直接发布：只提交 ERP 现有商品 |
| POST /api/import、PATCH /api/products/:id、POST /api/products/:id/review、DELETE /api/products/:id、POST /api/export | 本地资料操作 |

队列使用用户资料中这些固定路径：公共采集箱前缀 `/open/v1/product/common_collect_box/common_collect_box/` 下的 get_common_collect_box_list、get_common_collect_box_detail、edit_common_collect_box_detail、claimed；Temu 前缀 `/open/v1/product/collect_box/pddkj/collect_box/` 下的 get_shop_collect_item_info、get_category_attribute_rules、get_item_options；发布为 `/open/v1/product/collect_box/pddkj/move_collect/save_move_collect_task`。

## 真实联调剩余条件

需要安全注入已更新的妙手授权、核实店铺保存契约、部署可读的 HTTPS 图片托管，配置实际图像中转地址/模型（若采用 AI）。完整类目条件、尺码、模特、适配车型和原产地等复杂资料由原始商品保留；当前本地校验是基础检查，不能替代最新平台规则或远端保存验证。资料缺失会停止发布，程序不会编造价格、产地、包装和尺码。

现有发布文档未给出最终任务状态查询接口。因此只有“任务已接受/被拒绝/结果未知”状态，不显示已上架。上线联调应先只读测试、核对变体和图片；接口资料与配置齐全后才能验证真实保存和发布。

云环境快照保留文件而不保留进程。新任务使用现有检出重新运行启动命令；除非用户要求，不创建 Git worktree。不要将聊天中公开过的密钥复制到代码、示例、日志或环境说明。
