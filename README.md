# 公文笔正 · 先判对文种，再动笔

面向中文公文与机关材料的写作技能包：把**起草 / 修改 / 审核 / 片段补写**做成 S0–S6 七阶段，用 **G1–G7 七道取证门禁**拦住「文种错、事实无来源、政策无原文、格式不合 GB/T 9704」——不是先把话说漂亮。

覆盖法定 15 文种（决议、决定、命令、公报、公告、通告、意见、通知、通报、报告、请示、批复、议案、函、纪要），以及领导讲话、工作总结、述职报告、方案规划、调研报告、经验材料、工作汇报、会议材料、工作小结。

`v0.8.2` · `GPL-3.0-only` · `Node ≥ 18` · `Windows / Linux / macOS` · `119 项回归`

- **要「判得对」用本包**：文种、行文关系、政策依据、格式合规
- **要「写得像」用风格类技能**：本包不替代语料统计与去 AI 腔
- **不适合**：学术论文、PPT、新闻稿、文学创作、doc↔pdf 互转、扫描件 OCR

## 目录

- [30 秒上手](#30-秒上手) · [看一眼输出](#看一眼输出) · [它做什么](#它做什么)
- [七道门禁](#七道门禁) · [术语速查](#术语速查) · [占位语法](#占位语法)
- [版式能力（DOCX）](#版式能力docx) · [跨平台](#跨平台) · [记忆梦境](#记忆梦境)
- [已知边界](#已知边界) · [与同类技能的边界](#与同类技能的边界)
- [命令速查](#命令速查) · [目录结构](#目录结构) · [开发、回归与发布](#开发回归与发布)

## 30 秒上手

**1｜把整个目录放到技能路径**

| 场景 | 路径 |
|---|---|
| Windows | `%USERPROFILE%\.workbuddy\skills\gongwen-bizheng\` |
| Linux / macOS | `~/.workbuddy/skills/gongwen-bizheng/` |
| 其它 agent 框架 | 放进该框架的 skills 目录即可（如 QwenPaw：`<WORKING_DIR>/workspaces/<agent_id>/skills/gongwen-bizheng/`） |

只拷工作树，**不要带 `.git`**——技能目录属安装路径，仓库放开发目录。包内无第三方依赖，跑脚本只需 Node ≥ 18。

**2｜说一句话触发**

> 用公文笔正起草一份关于开展安全生产大检查的通知
> 用公文笔正改一下这份请示（附来文）
> 把这个 docx 排规范

**3｜拿到三部分交付物**

- **正文**：只含公文本身与受控占位（`【待补：…】`／`【待核：…】`），没有过程说明、没有门禁记录、没有内部标注；
- **已排版 DOCX**：v0.8.0 起默认产出——导出后自动走 `format_docx.js smart`（版式 + 元数据清理）并复检，不需要你再说"排版"；
- **注意事项**：待核清单、假设清单、版式未核项、风险提示、修改说明／审核意见，逐条编号，与正文占位一一对应。

## 看一眼输出

以下是真实运行输出（Linux + Node 22.23.4；为便于阅读做了截短与缩进，未改动 `code` 与结论），输入是一份故意出错的初稿：

```bash
$ node scripts/check_format.js 初稿.md --json
{
  "passed": false,
  "issues": [
    { "code": "STRUCT_DATE",        "severity": "error", "message": "未找到成文日期（应形如 2026年11月15日）；未提供时应用【待补：成文日期】占位" },
    { "code": "SERIAL_DUNHAO",      "severity": "error", "message": "层级序数应为“1.”（下脚点），不是“1、”" },
    { "code": "SERIAL_PAREN_PUNCT", "severity": "error", "message": "“（一）”后不应加顿号或点" },
    { "code": "STRUCT_CLOSING",     "severity": "warn",  "message": "未找到结语（如“特此通知”“妥否，请批示”“特此报告”），请确认与文种匹配" },
    { "code": "PLACEHOLDER",        "severity": "warn",  "message": "存在占位符或未处理标注：【待补" }
  ]
}
```

同一份稿子导出后，只读诊断（版式层）再报 2 项阻断 + 6 项提醒，每条都带原文锚点：

```bash
$ node scripts/format_docx.js analyze 出.docx --json
  [错误] SERIAL_COMMA   第6段：「1、危险化学品…」应为「1.」
  [错误] SERIAL_PAREN   第7段：「（一）」之后不应加顿号
  [提醒] PUNCT_COMMA_HALF 第3段：中文语境使用半角逗号  锚点：各区县应急管理局,各有关单位:
  ... 合计：错误 2 / 提醒 6 / 信息 0
```

对应交付的《注意事项》形如（按 `SKILL.md` 输出契约整理的示意，非脚本原样输出）：

```
1. 【待补：成文日期】 未识别到成文日期，按 GB/T 9704 补；日期不得自拟
2. 第 6 段「1、」→「1.」（G4a｜层级序数｜第 6 段）
3. 第 7 段「（一）、」→ 删顿号（G4a｜层级序数｜第 7 段）
4. 缺结语：通知应以「特此通知。」收束（G6｜结语与文种匹配）
5. 半角标点 4 处（第 3、4、10 段）：机检只报不改，需确认是否随文保留
6. 版式：G4b 已机检通过，页码／印章／版头仍须人工核对
```

## 它做什么

| 任务类型 | 你要给的 | 它产出 | 关键约束 |
|---|---|---|---|
| 起草 | 事由、受文对象、口径 | 骨架 → 蓝图 → 净稿 + 已排版 DOCX | 两次确认点：骨架、蓝图 |
| 修改 | 来文 + 改动范围 | 改稿 + 已排版 DOCX + 修改说明 | **只改点名处**，不顺手重写 |
| 审核 | 来文 + 依据 | 意见清单（必须改／建议改） | 不产出净稿 |
| 片段补写 | 位置 + 前后文 | 片段 + 衔接说明 | 只写片段，不重排全文 |

流程固定 S0–S6，**短公文只压缩产物长度，不跳过确认点、门禁与复盘**：

```
S0 识别与路由 → S1 采集与锁定 →【确认点① 骨架/方向】
→ S2 蓝图 →【确认点② 蓝图】→ S3 起草
→ S4 分层修订（G1 文种 → G2 事实 → G3 政策 → G5 结构 → G6 语言 → G4 格式 → G7 交付）
→ S5 交付 → S6 记忆沉淀
```

## 七道门禁

| 门禁 | 检查什么 | 阻断性 | 证据要求 |
|---|---|---|---|
| **G1** 文种与行文关系 | 文种合法、方向匹配、主送抄送合规 | 阻断 | 判定链 + 关系说明 |
| **G2** 事实与数据 | 三态完整、来源可追、无推定词 | 阻断 | 每条事实的状态与来源锚点 |
| **G3** 政策依据 | 原文、出处、三段论 | 阻断（无原文降级为占位） | 条款摘录 + 出处 + 成稿位置 |
| **G4a** 格式内容 | 序数、日期、文号、要素齐全、标点 | 阻断 | 逐项勾选／脚本输出 |
| **G4b** 版式 | 字体字号、页边距、印章、页码 | 可降级 | DOCX 或人工核对 |
| **G5** 结构 | 成稿 = 骨架 = 蓝图 | 阻断 | 章节-蓝图映射表 |
| **G6** 语言 | 禁用项、去 AI 味、称谓、标点 | 阻断 | 命中清单 + 锚点 |
| **G7** 交付一致 | 原话、确认点、禁区、占位符、净稿 | 阻断 | 对照表 ≤5 行 |

**结论只有四态**：通过 / 不通过 / **无法判定**（仅 G4b 与无原文的 G3 可记，须写明降级理由与待办）/ **带风险交付**（仅限无提问环境下阻断门禁二次失败，须整包标「待核版」并逐条列出未闭项）。

**证据格式固定**：`G×｜位置｜原文锚点｜问题｜依据｜动作`，例如 `G4a｜第3节｜"现将有关事项通知如"｜序号缺第二层｜GB/T 9704 7.3.3｜补全层级`。

纪律三条：**没查就说没查**；缺席判「不通过」或「无法判定」，**不得默认通过**；机械检查只判可定位性，不替代质量判断。

## 术语速查

| 术语 | 一句话 |
|---|---|
| S0–S6 | 七个阶段，顺序固定；短公文压缩产物、不压缩流程 |
| G1–G7 | 七道门禁；G4 拆成 G4a（文本层）与 G4b（版式层） |
| 净稿 | 占位清零、可直接排版送审的正文 |
| 待核版 | 占位未清零、已标风险的稿子，**不能直接发文** |
| 降级 | 能力缺失（没 DOCX、没原文、没脚本）时的替代动作，必须记账 |
| 记忆梦境 | 每次交付后把可复用的判断提炼成经验条目（见下） |

## 占位语法

全库只用这一套，禁止并存：

| 类型 | 写法 | 用途 |
|---|---|---|
| 已核事实 | `[已核·来源：文件/数据/访谈]` | 起草期标注，交付前迁入取证表 |
| 假设事实 | `[假设·待确认：依据与推测]` | 起草期标注，交付前入假设清单 |
| 未知事实 | `[未知：缺什么]` | 起草期标注，交付前转交付占位 |
| 交付占位 | `【待补：…】`、`【待核：…】`、`【待核对原文：…】`、`【版式未核：…】` | 净稿保留，正式导出前必须清零或改「待核版」 |

**必须整行**：占位单独成段（`【待补：成文日期】`）。**日期／署名／主送**三类整行占位视为「位置已声明、内容待补」，不判缺项，并按归属要素套版；标题与结语的占位、以及一切与正文混排的占位，仍判要素缺项。

`check_format.js` 会扫描以上全部标识与 `TODO`/`TBD`。

## 版式能力（DOCX）

既能**看**到一份已有 docx 的真实版式，也能**改**它（v0.4.0 起；v0.4.1 起与 `export_docx.js` 同源，导出产物与 `smart` 产物版式一致）。

**S5 固定工序（v0.8.0）**：起草／修改完成 → 占位盘点 → `export_docx.js` → `format_docx.js smart` → `analyze` 复检 → 交付。**不再询问"要不要排版"**；`smart` 幂等，重复执行不会二次破坏版式。例外见 `SKILL.md`「排版工序」一节。

| 模式 | 作用 | 是否写文件 |
|---|---|---|
| `analyze` | 只读诊断：页边距、字体字号、行距、缩进对齐、要素齐全、文字层序数与日期、元数据痕迹 | 否 |
| `format` | 只修版式：页面几何、段落识别与套版、结构空行、页码、日期写法、媒体段保护 | 是（新文件） |
| `meta` | 只清元数据 | 是（新文件） |
| `smart` | `format` + `meta`（推荐） | 是（新文件） |

**只改版式，不改文字**：标点全角化、`1、`→`1.`、措辞调整一律不做；诊断模式只报不改。这保证与硬约束「只改点名处」一致。

**元数据清理口径**（只清「暴露由程序或 AI 生成」的痕迹）：

| 清除 | 保留 |
|---|---|
| `creator` / `lastModifiedBy` 中的生成器签名（python-docx、LibreOffice、Pandoc 等） | `Template=Normal.dotm`、空的 `Company`/`Manager` |
| `description` 含 `generated by` 或 AI 工具自述 | 真实作者名（不在签名库内） |
| 模板假时间（如 `2013-12-23T23:15:00Z`）、创建与修改时间完全相同 | 批注、修订、域代码（属内容非元数据） |
| `Application` 与运行平台矛盾的取值（规则见「跨平台」）、`TotalTime=0`、字数统计全 0 | 文档样式、主题、字体表 |
| `docProps/thumbnail.jpeg` 模板缩略图、`rsid` 编辑会话标记 | 文档正文与结构 |

作者字段默认**清空而非代填**；需署名时用 `--author 姓名` 显式指定。源文件缺 `docProps`（部分自研导出脚本如此）时自动补齐合理的 `core.xml` + `app.xml`。

**读取侧防护**：逐条目校验 CRC-32（不匹配即报错）、单条目解压上限 256 MB、ZIP64 显式拒绝并提示另存；输出路径与输入文件相同时一律拒绝（含 `--force`），不做原地覆盖。

**OOXML 覆盖度**：按片段正则处理，不做完整 DOM 解析。支持正文段落、表格、图片与媒体部件、分节符、自动编号、样式引用、制表位、域代码；**不支持**嵌套同名 `<w:p>`（部分表格特殊结构）、文本框内段落重排、修订痕迹合并、CDATA 内文本识别。不支持的构造以「不崩溃且输出良构」为底线，语义保真须人工核对。

**与同类项目的关系**：版式参数取自 GB/T 9704-2012 与公文排版通例。实现参考了 `KaguraNanaga/docformat-gui` 的功能取舍，但**未复制其 v1.8.8.3+（PolyForm Noncommercial）代码、注释或常量表**，为独立重写。该项目的 MIT 版本（`document-format-skills`）思路相近，一并致谢。

## 跨平台

脚本层在 **Windows / Linux / macOS** 上同一套代码、同一套判据，不依赖宿主平台分支（v0.7.2 起）。

| 事项 | 处理 |
|---|---|
| 文本编码 | 统一由 `docformat/textio.js` 解码：UTF-8（含 BOM）、UTF-16LE、UTF-16BE（记事本「Unicode」），以及**无 BOM 的 GBK/GB18030**（v0.8.2，严格 UTF-8 失败后回落；两者都不成立则 exit 2）；`--custom-settings` 的 JSON 同样走这一层 |
| 换行 | CRLF、LF、单独的 CR 一律归一为 `\n` 后再逐行检查，行号与字数口径稳定 |
| `Application` 平台判定 | 规则表 `PLATFORM_APP_RULES` 集中一处，`analyze` 与 `smart` 共用，避免「诊断报的不修、修了的不报」 |
| 路径比较 | Windows 与 macOS 按大小写不敏感折叠（`A.DOCX` = `a.docx`），Linux 保持敏感；任一路径相同即拒绝覆盖 |
| 测试入口 | `tests/run_all.js` 逐套 spawn 后汇总；不用 `&&` 串联（前一环失败会让后续套件根本不跑，且 `&` 在 cmd.exe 下语义不同） |

`Application` 规则表（`DEFAULT_OPTIONS.application` 即目标基线 `Microsoft Office Word`）：

| 宿主 `process.platform` | 判定 | 原因 |
|---|---|---|
| `win32` | Macintosh 签名 → 矛盾，归一为 Windows Word | 该平台的 Word 是 Windows 版 |
| `linux` | Macintosh 签名 → 矛盾，同 Windows 口径归一 | 该平台没有 Word，Mac 签名只可能来自模板 |
| `darwin` | Mac 签名 → **不判矛盾**，保持原值 | Mac Word 签名在该平台合理，不抹掉真实作者平台 |
| 其他 | 按 `linux` 口径 | 同样产不出 Mac Word |

需要强制某个口径时用 `--platform win32|darwin|linux`（仅影响 `Application` 判定）。该参数同时用于回归：`tests/crossplatform_test.js` 在**任意宿主**上注入三个平台，三条分支都能确定性复现，因此 Linux 上也能验证 Windows 分支。

## 记忆梦境

写完之后不立刻收工：回看「草稿 → 终稿」的全部改动，把可复用的判断提炼成经验条目，长期抬高这个技能的水平（v0.6.0 起）。

```
每次交付完成（S6 之前，固定动作，v0.8.0 强化）
  → 回看改动：这次哪里改得最多、为什么
  → 入库四问：可脱离本篇？可判定？有出处？非抄书？
  → 四问全过 → 直接写入 experience/E-NNN-主题.md + INDEX.md 加索引（不等用户确认）
  → 任一不过 → 写明哪一问未过、缺什么、补什么可入库（只写「无可沉淀」= 没做）
```

**门槛与拒收**：四问全「是」才入库；**首次出现即可入库**（复现次数记 1，置信度按来源定），不再要求「先复现两次」——旧版那条「非孤例」等于禁止新经验入库。具体数据、单位名、人名、一次性偏好、涉密信息、无判据的「感觉」、以及 `references/` 已有的规则（抄书）一律不收（见 `references/13-experience.md` 三、四节）。

**晋升**：复现 2 次升「高」并合并；复现 3 次以上且与国标一致，**提请用户同意**后才写入 `references/`；12 个月未复现标「待复核」。经验库不得覆盖硬规则，冲突时以 `07-review.md` 为准。

> ⚠️ **`experience/` 是你个人的本地资产，不属于技能包**：经验条目（`E-*.md`）不进 git、不随技能分发，`README.md`／`INDEX.md` 仅作目录骨架随包提供（改它们会进 git）。**重装或覆盖升级前请先备份该目录**，否则升级会连同技能目录一起替换。

## 已知边界

- 不处理 `.doc` / `.wps`（需 Office/WPS 的 COM）；不做版头、版记、印章；不做修订痕迹与表格智能对齐。
- 机检覆盖页边距、字体字号、行距、缩进对齐、结构空行、文字层序数与日期、文档属性痕迹；**不覆盖页码、印章、版头与版记**——这几项须人工核对或记「无法判定·降级」。
- **要素检查按文种分流（v0.8.1）**：公布性文种（公告/通告/公报）、决议、命令、纪要不要求主送，纪要与 8 类事务材料不要求成文日期，事务材料不要求标题含法定文种名。文种用 `--type` 显式传入最稳；不传则按标题后缀推断（事务材料先判，避免「…的调研报告」被「报告」截胡）。
- **流程规则是文档级约束，不是运行时钩子**：排版固定工序、梦境入库由 `SKILL.md` 与文档一致性测试锁住，能防规则回滚，不能证明每次执行都发生。
- **编码**：三个文本入口按 BOM → 严格 UTF-8 → GB18030 判定。非 UTF-8 文件会被正确解码并报 `ENCODING_NON_UTF8`（warn），建议转存 UTF-8；两种都不成立时 exit 2，不静默当文本。
- **自定义属性不自动删**：`docProps/custom.xml` 常带客户编号、系统流水号，属文档数据而非生成器痕迹，`smart` 按设计保留；`analyze` 以 `META_CUSTOM`（info）提示人工确认。
- **机检码有速查表**：`05-format.md` 第十一节按"会不会改变修订动作"筛选列出高频码（同族合并），给"含义 → 动作"，其余码按 `message` 处理。
- 纯文本环境下不要宣称「版式已通过」，只能记降级。
- 输出字体需系统存在：Linux 上缺「方正小标宋简体」「仿宋_GB2312」时 Word 会回退字体，须在目标机复核。
- 表格：Markdown 表格导出 DOCX 会退化为带竖线的正文（脚本明确告警，不静默降级）；要保表格请用 `format_docx.js` 处理已有 docx。

## 与同类技能的边界

同类技能各管一段，本包只保证**「判得对」**这一层；三者可叠加，但同一轮只点名一个主控技能。

| 技能 | 管什么 | 与本包关系 |
|---|---|---|
| `official-document-writing`（MIT） | GB/T 9704-2012 规范与 6 文种模板知识库 | 知识库式参考；其 635 行主文件与 100+ 检查项会破坏本包「单 agent、按需读取」，故不合并 |
| `gongwen-deai` | 语言风格层（务实简练、去 AI 腔） | 与本包规则卡第 7 条「偏好不越底线」配套；未复制正文 |
| `lieflat-gongwen`（PolyForm NC 1.0.0） | 语料统计的量化风格能力（7 类文体参数、22 篇范文） | **未吸收**其参数卡／语料／数值／范文；该许可与 GPL-3.0-only 不兼容，禁止复制原文或数值 |

触发词天然重叠（「写一份通知」会同时命中本包与知识库类技能）：需要文种判定与门禁时**点名「用公文笔正」**；需要去 AI 腔时点名风格类技能。判断口径一句话——**要「判得对」用本包，要「写得像」用其它两包**。

## 命令速查

四个脚本全部只使用 Node 内置模块，无网络访问、无删除操作；`export_docx.js` 与 `format_docx.js` 默认拒绝覆盖已有输出，`--dry-run` 只解析不写文件。

```bash
# 文本层机检：退出码 0 通过 / 1 有待处理项 / 2 参数或读取错误
node scripts/check_format.js <正文.md|txt|docx> --json [--type 文体] [--max-chars N]

# 句式节奏：只检测不改写（句长 CV、同构并列、等长并列）
node scripts/check_rhythm.js <正文.md|txt> --json

# 净稿导出 DOCX（先出骨架，再走 docformat 管线，与 smart 同源）
node scripts/export_docx.js <净稿.md|txt> <输出.docx> [--force] [--dry-run]

# 版式：只读诊断 / 修版式 / 清元数据 / 两者合一
node scripts/format_docx.js analyze <来文.docx> --json
node scripts/format_docx.js smart   <来文.docx> <出.docx> [--author 姓名] [--force]
node scripts/format_docx.js format|meta <输入.docx> <输出.docx> [--force]

# 全量回归（5 套 119 项，任一失败即整体失败）
npm test
```

`format_docx.js` 另有 `--preset`、`--custom-settings <json>`、`--type <文体>`、`--author <姓名>`、`--application <名称>`、`--deep-clean`、`--no-structure`、`--no-dates`、`--no-media`、`--no-page-number`、`--no-metadata`、`--keep-thumbnail`、`--split-headings`、`--platform`、`--page-number-style <dash|plain>`、`--page-number-position <outside|center|left|right>`，`--help` 查看全文；两个页码参数取值非法时直接 exit 2（v0.8.2）。

## 目录结构

```
SKILL.md                        常驻决策层：规则卡 / 检查清单 / 易错项 / 流程 / 门禁 / 占位 / 索引 / 输出契约
LICENSE                         GPLv3 全文
README.md                       本文件
CHANGELOG.md                    版本与迁移对照
references/                     按需读取，禁止预加载（触发条件见 SKILL.md 资源索引）
  00-stages.md                  S0–S6 逐步动作 + 交互完整判据
  01-routing.md                 文种判定链与场景表
  02-intake.md                  首轮 5 问、默认值、事实分级
  03-patterns.md                各文种骨架与惯用语
  04-rules.md                   行文规则、主送抄送、称谓、政策引用
  05-format.md                  GB/T 9704 格式与自检（第十节：输出模板）
  06-language.md                语言禁用项与去 AI 味
  07-review.md                  审核清单与错误库（权威）
  08-memory.md                  记忆协议（第十二节：主文件记忆协议）
  09-cases.md                   好差对照与边界案例
  10-degradation.md             11 种能力缺失的降级行为
  11-vocab.md                   机关动宾搭配与六字对（v0.4.3）
  12-redlines.md                政治与合规红线（v0.5.0）
  13-experience.md              记忆梦境：经验提炼协议（v0.6.0）
scripts/
  check_format.js               文本层格式／占位符机检（--type 按文体分流要素要求）
  check_rhythm.js               句式节奏检测（只检测不改写）
  export_docx.js                净稿导出 DOCX
  format_docx.js                版式修复／元数据清理／只读诊断入口
  docformat/                    版式能力实现，14 个模块（zip、docpkg、xml、detect、genre、ppr、format、structure、clean、meta、diagnose、preset、index、textio）
tests/
  run_all.js                    全量入口：逐套 spawn 后汇总（v0.7.2）
  docformat_test.js             版式能力回归（38 项）
  gate_test.js                  门禁有效性回归（44 项）
  robustness_test.js            畸形输入与健壮性回归（15 项，含编码判定）
  rhythm_test.js                句式节奏回归（9 项）
  crossplatform_test.js         跨平台回归（11 项）
package.json                    脚本层入口：npm test；engines node>=18
.gitignore                      排除 experience/E-*.md，防止本地经验条目误提交
experience/                     本地经验库（个人资产，不入库、不分发）
  README.md / INDEX.md          使用说明与索引
  E-NNN-*.md                    经验条目（运行时生成；须平铺一层且含七项字段）
```

## 开发、回归与发布

> 本节面向维护者。普通使用者读完「30 秒上手」即可。

**测试**：`npm test` 跑 `tests/run_all.js`，五套共 **119 项**（40 + 44 + 15 + 9 + 11），逐套 spawn、失败不短路。

**验收脚本（开发目录自用，未随包分发）**：`tools/verify.py` 当前 116 项，含 4 个影子任务走查、导出产物自检回归、两条路径页脚一致性回归、五套 Node 回归的项数一致性（README 声明的项数与实际 PASS 数必须相等）、README 测试清单／脚本数／基线列表／验收项数覆盖、安装目录无版本控制元数据、资源索引覆盖全部 14 个 reference 子文件；另有断言校验 pPr 子元素顺序符合 CT_PPrBase、`package.json` 版本与 frontmatter 一致、CHANGELOG 版本段唯一、`experience/` 无越界文件且条目含七项字段。缺陷与观察项闭合核验见 `tools/verify_issues.py`（22 条）。

**功能回归（开发目录自用，未随包分发）**：一份 Python 端到端脚本用真实公文样例验证三个脚本；随包的 `tests/docformat_test.js` 则覆盖 zip 往返、版式属性、元数据清理、幂等、诊断、边界、表格与媒体部件保真、CRC 校验、ZIP64 拒绝、同路径拒绝、多节分节符、自动编号与样式引用、属性含 `>` 的 pPr 幂等、2000 段性能基线、多节页码引用、PAGE 域精确删除、三脚本退出码一致。

**发布基线**（`baseline-*.json` 与 `release-*` 快照均在开发目录，不入库；逐条列全，便于验收脚本比对）：

- v0.2.1：`baseline-v0.2.1.json`（13 文件；SHA-256、`node --check`、基线扫描、影子任务覆盖矩阵）
- v0.3.0：`baseline-v0.3.0.json`（17 文件） · v0.4.0：`baseline-v0.4.0.json`（31 文件）
- v0.4.1：`baseline-v0.4.1.json`（31 文件） · v0.4.2：`baseline-v0.4.2.json`（31 文件）
- v0.4.3：`baseline-v0.4.3.json`（32 文件，+`references/11-vocab.md`）
- v0.5.0：`baseline-v0.5.0.json`（35 文件，+`12-redlines.md`、`package.json`、`robustness_test.js`）
- v0.6.0：`baseline-v0.6.0.json`（38 文件，+`13-experience.md`、`experience/`）
- v0.6.1：`baseline-v0.6.1.json`（38 文件，修 4 项新引入缺陷）
- v0.6.2：`baseline-v0.6.2.json`（39 文件，+`.gitignore`）
- v0.6.3：`baseline-v0.6.3.json`（40 文件，+`tests/gate_test.js`）
- v0.6.4：`baseline-v0.6.4.json`（40 文件，清 5 项遗留）
- v0.7.0：`baseline-v0.7.0.json`（42 文件，+`check_rhythm.js`、`rhythm_test.js`）
- v0.7.1：`baseline-v0.7.1.json`（42 文件，文档陈欠修复）
- v0.7.2：`baseline-v0.7.2.json`（45 文件，+`textio.js`、`crossplatform_test.js`、`run_all.js`）——**待用 `tools/verify.py` 在开发机重生成**
- v0.7.3：仅 README／CHANGELOG 调整，**代码与文件数不变（45）**，不新增基线
- v0.8.0：`baseline-v0.8.0.json`（45 文件，占位符判据 + 排版固定工序 + 梦境门槛；`gate_test.js` 23 → 37 项）
- v0.8.1：`baseline-v0.8.1.json`（46 文件，+`docformat/genre.js`；文种分流、结语判据合并、主送半角冒号；`gate_test.js` 37 → 44 项）——**待用 `tools/verify.py` 在开发机重生成**
- v0.8.2：`baseline-v0.8.2.json`（46 文件；编码判定 GB18030 回落、页码参数枚举校验、`META_CUSTOM`；回归 113 → 119 项）——**待用 `tools/verify.py` 在开发机重生成**

**回滚**：以对应快照整包覆盖安装目录，并按相应 `baseline-*.json` 校验文件数与 SHA-256；跨多个版本回滚时按 CHANGELOG 逐版执行增删文件（例如回滚到 v0.4.2 需删 `references/11-vocab.md` 并还原三个文件的索引行；回滚到 v0.3.0 需移除 `scripts/format_docx.js` 与 `scripts/docformat/`）。触发条件：影子任务任一阶段缺失、脚本退出码异常、路径引用断链，或判定证据／确认点／降级纪律被削弱。

**版本字段**：内建规范要求 frontmatter 只含 `name` 与 `description`；平台对 `metadata.version` 的识别规则未统一，因此本包保留该字段并逐版推进（当前 0.8.2），同时在 `package.json` 与本文写明版本，不臆造顶层 `version` 字段。已实测含 `license`／`metadata` 的技能可正常加载。

**上游**：`github.com/SuiJQ/gongwen-bizheng`（GPL-3.0-only）。逐版文件清单与 SHA-256、git blob 校验记录见 CHANGELOG。

> 说明：`check_format.js` 的验收基线是**对技能文档自身**扫描的结果，命中项全部是规则示例文本（`DOC_TYPE_MIX`、`PLACEHOLDER`、`THEME_WORD` 等），不代表文档缺陷；该脚本的正常用途是检查公文正文。