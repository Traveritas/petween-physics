# dsh-motion-pet-physics

[dsh-motion-pet](../dsh-motion-pet) 的"抛掷物理"附属插件：把宠物**扔出去**，它会受重力下坠、在屏幕内弹跳，落定后停在新位置。

- 拖动宠物快速松手 → 按松手瞬间的手速起飞（120ms 采样窗口估算释放速度）
- 重力下坠 + 四壁反弹（宠物整体始终留在视口内）
- 碰壁时可播放 squash 变形动画和/或切换图片（保持一段时间后恢复）
- 低速松手 = 停放，不起飞；飞行中用户随时可以半空抓回（人手永远优先）
- 落定后自动持久化位置；页面隐藏时立即落定；不飞行时不占用任何位置控制权

本插件不注册任何设置页/Slot/UI——纯行为附属，需先安装主插件 `dsh-motion-pet`（≥ 1.0.0，提供 `motion-pet` 与 `motion-pet/client` 服务）。

## 安装

要求：已安装 DSH（`@deepseek-ai/dsh`，在 0.1.0-rc.7 上实测）与主插件 `dsh-motion-pet`。

```bash
dsh plugin --profile web add link:/path/to/dsh-motion-pet-physics
```

重启 `dsh web` 生效。首次加载时，host 半会向主插件的动画库注册默认反弹动画
`user:physics-bounce-pop`（约 260ms 的 squash 变形，`interaction` kind，不换图）；
**仅在库中不存在时注册**——你在主插件编辑器里改过它，升级本插件不会覆盖。

卸载：

```bash
dsh plugin --profile web remove dsh-motion-pet-physics
```

卸载后已注册的动画保留在主插件动画库中，由你在其编辑器里管理。

## 配置

**当前版本通过编辑 `src/client/config.ts` 并重新构建来调整参数**（`pnpm run build` 后重启 `dsh web`）。
我们没有使用 cordis `Config` schema，原因（对照本机安装的 dsh 0.1.0-rc.7 源码核实）：

1. DSH 的 Plugins 设置页只渲染插件**自带浏览器卡片的设置命名空间**
   （`dsh-client-ui-settings-plugins/README.md`："A served namespace no card claims renders nothing"），
   没有任何表面会为外部插件自动渲染 `Config` schema 表单；
2. 外部插件浏览器半的 entry 由 shell boot 以 `loader.create({ name })` 创建，**不携带 entry config**，
   即浏览器半没有配置通道；
3. 官方 settings 路径（`ctx.settings.register` + 手写卡片）需要自建一套 React 编辑 UI
   （staging、revision fencing），对一个纯行为附属来说不成比例。

若未来 DSH 提供外部插件配置表单，将迁移到该路径。

可调项（`src/client/config.ts`，含默认值）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `physics.gravity` | 3000 | 重力加速度（px/s²） |
| `physics.restitution` | 0.6 | 弹性系数 0..1（1 = 完全弹性） |
| `physics.friction` | 0 | 水平空气阻尼 0..1/s |
| `physics.throwMultiplier` | 1 | 释放速度倍率 |
| `physics.minThrowSpeed` | 350 | 低于此释放速度（px/s）视为"停放"不起飞 |
| `physics.settleSpeed` | 120 | 贴底且速度低于此值（px/s）即落定 |
| `physics.maxSpeed` | 4000 | 释放速度上限（px/s） |
| `physics.maxFlightMs` | 20000 | 飞行时长兜底（近弹性配置也不会永久弹跳） |
| `bounceAnimation.enabled` | true | 碰壁时播放变形动画 |
| `bounceAnimation.id` | `user:physics-bounce-pop` | 动画库 id |
| `bounceAnimation.interrupt` | true | 播放时打断在播动画 |
| `flashPose.enabled` | false | 碰壁时切换图片 |
| `flashPose.poseKey` | `success` | 切换到的 pose 槽位 |
| `flashPose.holdMs` | 800 | 图片保持 ms（≤0 保持到下个状态变化） |
| `sampleWindowMs` | 120 | 拖拽测速窗口 |
| `effectDebounceMs` | 150 | 同壁效果去抖窗口 |

## 工作原理

- **host 半**（`src/index.ts`）：`inject: ['motion-pet']`，仅在服务出现时注册默认动画（幂等，一次性）。
- **client 半**（`src/client/`）：`inject: ['motion-pet/client']`。
  - `physics.ts`：纯函数积分器（半隐式欧拉），dt 钳制 ≤40ms，包围盒 = `stageSize × scale`，四壁反弹 ×restitution，贴底低速落定。
  - `throw-controller.ts`：订阅拖拽手势与舞台快照；拖拽期间采样（不持租约），松手时估算释放速度；
    起飞时申请独占位置租约（`requestPositionControl`），rAF 逐帧 `driver.apply`；碰壁触发效果（同壁 150ms 去抖）；
    落定 `commit()` 后立即 `release()`。用户半空抓取、页面隐藏、会话消失、dispose 都会终止飞行。
  - `types.ts`：主插件服务契约的本地类型镜像（独立包，不 import 主插件运行时代码）。

## 开发

```bash
pnpm install
pnpm test          # vitest run
pnpm run typecheck # 双工程类型检查
pnpm run build     # lib/index.js (host ESM) + lib/client.js (__ModuleLoader__ 工厂)
```

## License

MIT
