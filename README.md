# Petween Physics

[petween](https://github.com/Traveritas/petween) 的"抛掷物理"附属插件（包名 `petween-physics`，前身为 `dsh-motion-pet-physics`，0.2.0 起随主插件更名）：把宠物**扔出去**，它会受重力下坠、在屏幕内弹跳，落定后停在新位置。

- 拖动宠物快速松手 → 按松手瞬间的手速起飞(采样窗口内估算释放速度)
- 重力下坠 + 四壁反弹(宠物整体始终留在视口内)
- 碰壁时可播放 squash 变形动画和/或切换图片(保持一段时间后恢复)
- 弹跳后期反弹高度过低时不再连珠触发碰壁效果:进入**地面滑动**(贴地滑行、地面摩擦减速,可选播一次滑动动画),速度低于落定值后照常停稳;把「最小反弹高度」调到 0 即恢复旧的连弹行为
- 低速松手 = 停放,不起飞;飞行中用户随时可以半空抓回(人手永远优先)
- 落定后自动持久化位置;页面隐藏时立即落定;不飞行时不占用任何位置控制权

本插件需先安装主插件 `petween`(≥ 1.2.0,提供 `petween` 与 `petween/client` 服务;
1.1.x 及更早的 `dsh-motion-pet` 提供的是旧服务名,不兼容);
自带一张**设置卡片**(设置面板里的 "Petween Physics"),所有参数运行时可调、自动落盘。

## 安装

要求：已安装 DSH（`@deepseek-ai/dsh`，在 0.1.0-rc.7 上实测）、[主插件 petween](https://github.com/Traveritas/petween)（≥ 1.2.0，需先行安装）、Node ≥ 22.18（构建工具链要求）与 pnpm。

```bash
git clone https://github.com/Traveritas/petween-physics.git
cd petween-physics
pnpm install
pnpm run build    # 产出 lib/（仓库不含构建产物，安装前必须构建）

dsh plugin --profile web add link:/path/to/petween-physics    # link: 后指向你克隆的目录
```

重启 `dsh web` 生效。首次加载时，host 半会向主插件的动画库注册默认反弹动画
`user:physics-bounce-pop`（约 260ms 的 squash 变形，`interaction` kind，不换图）；
**仅在库中不存在时注册**——你在主插件编辑器里改过它，升级本插件不会覆盖。

卸载：

```bash
dsh plugin --profile web remove petween-physics
```

卸载后已注册的动画保留在主插件动画库中，由你在其编辑器里管理。

## 配置

**全部参数均可在设置卡片中运行时编辑**:打开 DSH 设置面板,找到 "Petween Physics" 卡片
(紧跟主插件的 "Petween" 卡片之后),按分组调整——物理(重力/弹性/摩擦/甩出倍率/起掷与落定
速度/速度上限/飞行兜底)、碰壁动画(开关/动画下拉/打断开关)、碰壁切图(开关/pose 六选一/保持
时长)、落地滑动(最小反弹高度/地面摩擦/滑动动画下拉)、碰撞箱(忽略透明像素/透明判定阈值),采样/去抖/容差收在"高级"折叠区。
改动停手 300ms 后自动保存(原子写盘),卡片头部显示保存中/已保存/保存失败状态;"恢复默认"一键
写回出厂值。

**落盘位置**:`~/.dsh/petween-physics/config.json`(`$DSH_HOME/petween-physics/config.json`,
重启后生效于新加载)。从 `dsh-motion-pet-physics` 0.1.x 升级时,首次启动自动把
`$DSH_HOME/motion-pet-physics/` 迁移为 `$DSH_HOME/petween-physics/`(目录重命名;跨盘/被占用
导致重命名失败时改为复制并保留旧目录)。**手改 JSON 也行**:host 启动时读取该文件——文件不存在用默认值;JSON 损坏
则告警并自动重写默认值;字段写错(未知字段/越界值)会按字段回落默认,合法字段保留。
HTTP 侧(host 半提供):`GET /api/petween-physics/config` 读取,`PUT` 同路径提交部分或完整
config——服务端按 `CONFIG_NUMERIC_FIELDS` 表**校验并拒绝**未知字段与超范围数值(400
`INVALID_CONFIG`,错误信息带期望范围;不做静默 clamp),跨源写会被 403 拦截。

动画 id 下拉的数据源:主插件 `GET /api/petween/animations` 的自定义动画 + 硬编码的常用
`builtin:` 内置动画 + 本插件默认 `user:physics-bounce-pop`;主插件不可用时回落静态列表,
当前配置里手填的未知 id 也会以"当前值"保留显示。

为什么不用 cordis `Config` schema(对照本机安装的 dsh 0.1.0-rc.7 源码核实):

1. Plugins 设置页的 `settings.plugin.item` 卡片槽按 **host 侧 settings 系统服务的命名空间**
   派发(其 tab controller 只派发 `ctx.settingsScope.describe()` 里出现的 key),
   没有任何表面会为外部插件自动渲染 `Config` schema 表单;
2. 外部插件浏览器半的 entry 由 shell boot 以 `loader.create({ name })` 创建,**不携带 entry config**,
   即浏览器半没有配置通道;
3. 官方 settings 路径要求把配置搬进 DSH settings 文档体系,与"自有 config.json + HTTP 路由"
   的架构不符。因此选用 `settings.section` 槽(order 135,主插件已验证的同款契约)。

可调项(`src/client/config.ts`,含默认值与接受范围):

| 项 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `physics.gravity` | 3000 | 100..100000 | 重力加速度(px/s²) |
| `physics.restitution` | 0.6 | 0..1 | 弹性系数(1 = 完全弹性) |
| `physics.friction` | 0 | 0..1 | 水平空气阻尼(每秒) |
| `physics.throwMultiplier` | 1 | 0..10 | 释放速度倍率 |
| `physics.minThrowSpeed` | 350 | 0..10000 | 低于此释放速度(px/s)视为"停放"不起飞 |
| `physics.settleSpeed` | 120 | 0..10000 | 贴底且速度低于此值(px/s)即落定 |
| `physics.maxSpeed` | 4000 | 100..100000 | 释放速度上限(px/s) |
| `physics.maxFlightMs` | 20000 | 500..600000 | 飞行时长兜底(近弹性配置也不会永久弹跳);兜底落定发生在当前帧位置,该位置可能不在地面(重新拖拽即可修正) |
| `physics.minBounceHeightPx` | 12 | 0..2000 | 预测反弹高度(vy²/2g)低于此值(px)改为地面滑动,不再反弹/不触发碰壁效果;0 = 保持旧的连弹行为 |
| `physics.groundFriction` | 2 | 0..50 | 地面滑动期间的水平衰减(每秒,公式同空气阻尼);越大滑得越短 |
| `bounceAnimation.enabled` | true | — | 碰壁时播放变形动画 |
| `bounceAnimation.id` | `user:physics-bounce-pop` | 非空 ≤200 字符 | 动画库 id |
| `bounceAnimation.interrupt` | true | — | 播放时打断在播动画 |
| `flashPose.enabled` | false | — | 碰壁时切换图片 |
| `flashPose.poseKey` | `success` | 六个 pose 之一 | 切换到的 pose 槽位 |
| `flashPose.holdMs` | 800 | 0..60000 | 图片保持 ms(≤0 保持到下个状态变化) |
| `collision.ignoreTransparentPixels` | false | — | 碰撞箱按当前姿势图的**可见像素**收紧(bodyRect insets 之上再剥掉图片文件自带的透明边缘;逐图扫描缓存,数据缺失/扫描失败静默回退图片盒) |
| `collision.alphaThreshold` | 1 | 1..255(整数) | 像素 alpha ≥ 此值才算可见;1 = 只忽略全透明像素,调大可忽略抗锯齿残影 |
| `slideAnimationId` | `null` | null 或非空 ≤200 字符 | 进入地面滑动时播放一次的动画 id;null = 不播 |
| `slideInterrupt` | true | — | 滑动动画开始播放时打断在播动画(slideAnimationId 为 null 时无意义) |
| `sampleWindowMs` | 120 | 10..2000 | 拖拽测速窗口 |
| `effectDebounceMs` | 150 | 0..5000 | 同壁效果去抖窗口 |
| `applyFalseTolerance` | 2 | 1..60(整数) | 连续 apply 失败容忍次数 |

## 工作原理

- **host 半**(`src/index.ts`):`inject: ['petween', 'webServer']`。`Symbol.for` mount-once
  旗标防止 bundle 双载重复注册路由;注册 `GET/PUT /api/petween-physics/config`
  (校验 + 原子写 `$DSH_HOME/petween-physics/config.json`),并在服务出现时注册默认动画
  (幂等,一次性)。
- **client 半**(`src/client/`):`inject: ['petween/client', 'slots']`。
  - `physics.ts`:纯函数积分器(半隐式欧拉),dt 钳制 ≤40ms,包围盒 = `stageSize × scale`,四壁反弹 ×restitution,贴底低速落定;反弹高度低于 `minBounceHeightPx` 时转地面滑动(vy 归零、贴地、`groundFriction` 衰减、侧壁只夹不弹、不报告碰壁),滑动中速度低于 `settleSpeed` 落定。
  - `throw-controller.ts`:订阅拖拽手势与舞台快照;拖拽期间采样(不持租约),松手时估算释放速度;
    起飞时申请独占位置租约(`requestPositionControl`),rAF 逐帧 `driver.apply`;碰壁触发效果(同壁去抖);
    落定 `commit()` 后立即 `release()`。用户半空抓取、页面隐藏、会话消失、dispose 都会终止飞行。
    配置经 `getConfig()` **逐手势/逐帧读取最新值**——设置卡片保存后立即生效,无需重建控制器。
  - `alpha-bounds.ts` + `pose-collision-bounds.ts`:`collision.ignoreTransparentPixels` 的可见像素
    碰撞箱。纯扫描器求姿势图 alpha 紧致包围盒(归一化分数,一次扫描服务所有缩放);provider 负责
    (petId, poseKey)→宠物记录(逐问取新,在飞去重)→`/petween-assets/<id>`→canvas 扫描(≤512px
    降采样,按 URL+阈值缓存,失败不落缓存);控制器把分数乘进 bodyRect insets,数据缺失/扫描未完成
    静默回退图片盒。快照的 poseKey 已是 fallback 解析后的槽位,故无需复刻主插件 fallback 链。
  - `config-hub.ts`:轻量配置中心(load 记忆化/subscribe/update;加载失败静默回落默认值并暴露错误态)。
  - `settings/PhysicsCard.tsx`:`settings.section` 卡片(order 135),300ms 防抖自动保存 + 恢复默认。
  - `types.ts`:主插件服务契约的本地类型镜像(独立包,不 import 主插件运行时代码)。

## 开发

```bash
pnpm install
pnpm test          # vitest run
pnpm run typecheck # 双工程类型检查
pnpm run build     # lib/index.js (host ESM) + lib/client.js (__ModuleLoader__ 工厂)
```

## License

MIT

## Desktop 宿主形态（Petween Desktop）

本插件是**双宿主**的：除 DSH 插件形态外，`src/desktop/index.ts` 提供桌面伴生入口（`createPhysicsDesktopCompanion()`），由 [Petween Desktop](https://github.com/Traveritas/petween-desktop)（Electron 壳）经 companion 注册表挂载。桌面壳负责：伺服 `/api/petween-physics/config`（host 半注册进它的 local-server，数据根注入到 `userData`）、在设置页托管 `PhysicsCard`、提供 petween host service 供默认撞击动画注册。

**给伴生插件作者的三条纪律**（保证一个插件两种宿主零分叉）：

1. **服务获取收单缝**：不要在行为代码里碰 cordis ctx；服务对象从入口的 init context 拿（DSH 形态经 `petweenClientServiceOf(ctx)`，桌面形态由壳直接传入单例）。
2. **HTTP 全根相对**：两种宿主都同源伺服你的 host 路由与 petween API，根相对 fetch 天然通用。
3. **行为类与入口分离**：运行时行为（如 `ThrowController`）只依赖服务接口 + 注入的环境缝（时钟/视口/rAF/可见性），环境缝在各自入口里接线。

桌面伴生契约（结构镜像，无需依赖桌面壳包）：

```ts
interface DesktopCompanion {
  id: string
  displayName: string
  description?: string
  SettingsCard?: React.ComponentType   // 可选：桌面设置页托管的配置卡
  init(ctx: { petween: PetweenClientService }): (() => void) | void
}
```
