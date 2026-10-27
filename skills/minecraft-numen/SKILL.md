---
name: minecraft-numen
description: 在 Minecraft 里当主人的同伴：看她在哪、走过去、跟着走、说句话、看周围、挖东西、打怪。走 mcp__numen__* 工具（Numen 模组内置 MCP 服务端，127.0.0.1:8766）。
whenToUse: 主人说在玩 MC / 让你进游戏陪他 / 让你走过去 / 游戏里有人对你说话（get_events 出 <query>）时。
---

# 陪主人玩 Minecraft

身体是 Numen 模组的实体（默认同伴名 `xiaojingyu`），不是你在电脑上点鼠标。你只能通过它的 API 动，
拿不到游戏窗口，也看不见画面——所有信息都来自 `numen.status` / `numen.scan`。

## 0. 先确认身体在不在

```
mcp__numen__list_companions          # 空 = 主人没进游戏 / 没召唤
```

没有就让主人：进游戏 → 设置 → 聊天里喊你，或让他用 `create_companion`（**只有主人能召唤**，别自己造人）。

## 1. 一轮的标准动作

```
mcp__numen__get_events  companion=xiaojingyu  wait_seconds=60
```

- 返回 `<query>…</query>` = 主人在游戏里对你说话 → 这轮必须应他。
- 返回 `owner_hurt` / `reflex` 等 → 是他被打、她自己逃跑等自动事件，看一眼就行。
- 超时返回空 = 没人理你，别硬找话说。

看完 → 需要动手就 `lua`，需要说话就 `say`。**一次 lua = 一个程序，跑完才返回回执**（含 `N calls · X s` 和 stdout）。

## 2. 说话

```
mcp__numen__say  companion=xiaojingyu  text=我在呢，往你那边走
```

会同时出聊天栏 + 头顶气泡（绑了语音还会念）。话短、口语，别一次三句。

## 3. lua 里能调什么

组：`api build creative fight gear gui inv locate mc module move route scan status task time use work`

已验证的配方（照抄改数字）：

```lua
-- 我是谁
local me = numen.status.self()
print(me.pos.x, me.pos.y, me.pos.z, me.hp, me.hunger, me.dimension, me.biome)

-- 主人在哪（distance = 直线距离）
local o = numen.status.owner()
print(o.name, o.pos.x, o.pos.y, o.pos.z, o.hp, o.distance)

-- 走到主人身边 3 格内
local o = numen.status.owner()
local moved = numen.move.go(numen.route.plan({ to = o.pos, arrive = "near", range = 3 }))
print("到了", moved.pos.x, moved.pos.y, moved.pos.z, "剩", moved.distance_left)

-- 从某只怪身边跑开 12 格
numen.move.go(numen.route.plan({ to = creeper_entity, arrive = "away", range = 12 }))
```

其它组（签名用 `numen.<组>.<函数>`，报错会自带 usage 和 e.g.，照它写的改）：
`scan.entities` / `scan.blocks("iron_ore")` / `scan.sight` / `scan.map`、
`inv.items` / `inv.count` / `inv.eat` / `inv.craft`、`fight.attack(id)`、`work.dig`、`work.fish`、`time.wait`、
`route.plan` 的 `stops`（多段路）`avoid`（避开水/岩浆）`costs`（允许挖/搭）。

模组自带 11 个专题技能，动手前用工具加载，别凭记忆编 API：

```
mcp__numen__skill  companion=xiaojingyu  skill=combat_basics
```
可选：`building_design containers tier_progression nether_entry ender_pearls stronghold_finding
dragon_combat end_game_overview blaze_rods world_atlas`

## 4. 五个会翻车的地方（都踩过）

1. **`range` 必须配 `arrive`** —— `route.plan({to=.., range=3})` 直接报 `bad_argument`；
   要么 `arrive="near"`（停在范围内），要么 `arrive="away"`（至少离开这么远）。
2. **必须 `pcall` 包住** —— 路不通会抛 `no_path` 之类，抛出来整段就停，后面的动作全不执行：
   ```lua
   local ok, res = pcall(function() return numen.move.go(plan) end)
   if not ok then print("走不过去: " .. tostring(res)) end
   ```
3. **`owner_hurt` 会抢占正在跑的脚本**（回执里写 `an urgent owner_hurt event arrived; t1 keeps running`）。
   这是设计如此：主人受伤优先。任务本身继续跑，别以为失败了就重开。
4. **世界暂停时 lua 会永远卡住** —— 单人世界 `pauseOnLostFocus` 开着时，主人一切出游戏窗口世界就冻住，
   `lua` 就挂在那里、还会占着身体不放（之后每次调都报 `a program is already running`）。
   让主人**按 Esc → 对局域网开放**（开了局域网就不暂停）。`say` / `get_events` 不吃 tick，所以它们照常能用。
5. **别调 `numen.api.help(…)` 当探路** —— 实测它会卡住整个身体。要看签名就直接调用，报错信息里带 usage。

另外：单个同伴**同时只能跑一个 lua 程序**；一次调用最长 300 秒（`call_timeout_seconds`），别写死循环。

### 4.1 别开「长任务」，否则你就永远站那儿不动了（2026-10-27 实测）

这一晚她卡了两次，都是同一个原因：起了**跑不完的程序**，之后每次 `lua` 都被拒
（`a program is already running for this companion`）——人看着就是「她站在那儿一动不动」，话也不回。
`numen.move.follow(...)`、长距离 `route.plan`、`numen.time.wait(很久)` 都属于这一类。

**硬规矩**

- 走路用**一次一段**的 `numen.move.to(...)`（或短 `route.plan` + `move.go`），每段 ≤ 5 秒能走完的距离；
  一段没走到就再发一段，**不要**用 `follow` 常驻跟随。
- 一次 `lua` 里的动作 ≤ 3 个，别在程序里写 `while true` / 递归等待。
- 每隔几步就返回一次状态（`return {dist=..., pos=...}`），让宿主能看到你在动。
- 万一还是卡住了：主人可以在游戏内的 MCP 提示条上点**「停止」**（`numen.task.stop`），
  或者你让主人删掉同伴重召一次 —— 后者会清空背包。

### 4.2 活着优先：饿了自己吃，血低了自己撤（2026-10-27 补）

翻过的最傻的一次：血 9.8 挂了一整晚没人管，饿着也没找吃的。每轮开工前先看这三样，
**低于阈值就先处理，别急着挖矿盖房**：

```lua
local s = numen.status.self()
if s.hunger < 16 then
  local ok = pcall(numen.inv.eat)            -- 手上有吃的就吃
  return { ate = ok, food = s.hunger }
end
if s.hp < 8 then
  return { retreat = true, hp = s.hp }       -- 先往主人那边跑，别硬打
end
```

- **饱食 < 16** 就 `numen.inv.eat()`；背包没吃的就先 `numen.inv.items()` 看有没有食物，
  没有就喊主人给（`say`），别硬撑。
- **血 < 8** 别再打怪/挖矿，先 `numen.move.to` 回主人身边（他那边相对安全）。
- **主人血也低**（`status.owner().hp` 明显下降）→ 先 `say` 提醒他，别自己跑远。
- **跟主人时保持 2~4 格**：不要贴脸（挡路、容易被他的剑打到），也不要超过 8 格（会跟丢）。
  每段走完 `status.owner().distance` 看一眼，超了就补一段 `move.to`，**不要**用 `follow`。


## 5. 记住这个世界的几件事

```
mcp__numen__memory  companion=xiaojingyu  command=add  name=base  type=fact  content="主人的家在 x=0 z=45，石头剑"
mcp__numen__todo    companion=xiaojingyu  items=["走到主人身边", "帮他挖铁"]
```

`memory` 的索引每轮自动带给你，`todo` 主人能在游戏里看到清单——多阶段活儿（挖矿、下矿洞）就写下来。

## 6. 干活节奏

- 说话 → 等事件 → 动一小步 → 再说一句。别一上来连发 5 个 lua。
- 主人喊你，**这一轮必须动**（至少一次 `lua` 或 `say`），不能只看一眼就当回应了。
- 距离远（>30 格）先 `say` 一句「我过来」，再走；走不动就报实话，别假装到了。
- 她在游戏里会自己逃跑、自己打怪（reflex），那是模组的内置反应，不用你去纠正。

## 3.5 用手碰方块：熔炉、床、箱子（`numen.use.*` + `numen.gui.*`）

`numen.use.block(cell)` 就是**真人拿准星对准那一格右键**：它会真的打开界面（返回 Window），
但它**不会走路**——你必须先站在 4.5 格以内，否则报错并提示你先 `numen.move.to(..., {arrive = "use"})`。

### 熔炉（烧矿、烧东西）

```lua
local f = numen.scan.blocks("minecraft:furnace", {radius = 16})
if #f == 0 then print("附近没有熔炉，得先做一个") return end
local pos = f[1].nearest.pos
numen.move.to(f[1], {arrive = "use"})          -- 站到能点到它的位置
local w = numen.use.block(pos)                  -- 右键：返回 Window（界面上每个格子）
w:put("minecraft:raw_iron", 3)                  -- 原料
w:put("minecraft:coal", 2)                      -- 燃料（没有煤就用 oak_planks / charcoal）
for _, s in ipairs(w.slots) do
  if s.item then print(s.index, s.side, s.item, s.count) end
end
print("烧制进度", w.data[3], "/", w.data[4])     -- 熔炉的 data = 燃烧时间/总时长/进度/总进度
w:close()
```

- 只看不拿：`w:take("minecraft:iron_ingot")` 把成品取回背包。
- 格子不清楚就先 `numen.gui.view()` 看一遍（`index / side / item / count`）。
- 界面没打开（`w.slots` 是空的、没有 `block` 字段）＝右键点歪了或被别的东西挡住（高草、树叶），
  结果里会点名下一格该点哪儿——照着重新点，别原地连点。

### 床（睡觉过夜）

```lua
local beds = numen.scan.blocks("#minecraft:beds", {radius = 32})   -- 这个 tag 覆盖所有颜色
if #beds == 0 then print("附近没有床") return end
numen.move.to(beds[1], {arrive = "use"})
local r = numen.use.sleep({at = beds[1].nearest.pos})
print(r.sleeping, r.bed)
```

- 返回 `sleeping=false` 且理由是 **"Only at night"** → 不是失败，等天黑（`numen.task.timer`），别重试。
- **"too far away"** → 先 `numen.move.to`。
- 有床但没放下：先 `numen.inv.count("minecraft:white_bed")`（0 就先 `numen.inv.craft`），
  再用 `numen.build.place` 铺在自己脚边。

### 箱子 / 工作台 / 别的容器

跟熔炉同一套：`numen.use.block(pos)` 拿到 Window → `put / take / move / quick / close`。
潜行放东西：`numen.use.block(pos, {item = "minecraft:oak_planks", sneak = true})`（Shift+右键，不会打开界面）。

## 3.6 吃东西 / 喝药水

```lua
numen.inv.eat("minecraft:cooked_beef")        -- 吃东西（真的嚼完才回血）
numen.inv.eat("minecraft:potion")             -- 喝药水（身上带着的那瓶）
```

它是**身体动作**：程序会等到吃完才返回。背包里没有 / 不是食物 / 已经饱了都会直接拒绝并说明。

## 3.7 手持与穿戴

```lua
numen.gear.hold("minecraft:iron_pickaxe")                 -- 拿到主手（不会用掉、不会倒出来）
numen.gear.hold("minecraft:torch", {hand = "off"})        -- 副手
numen.gear.wear("minecraft:iron_helmet")                  -- 穿装备（槽位自动选）
numen.gear.wear("minecraft:elytra", {slot = "chest"})     -- 指定槽位
numen.gear.remove("minecraft:diamond_boots")              -- 脱下来放回背包
```

`gear.hold` 只换手，不触发使用 —— 水桶拿在手上还是满的。要**真用**：`numen.use.item({item = "..."})`。

## 3.8 合成（工作台 / 配方书）

**最省事的是一条 `inv.make`**：它自己挑配方、自己找/放工作台、做完把台子收回去。

```lua
numen.inv.make("minecraft:wooden_pickaxe")          -- 做 1 个（材料不够会报 no_material 并说你缺什么）
numen.inv.make("minecraft:torch", 16)               -- 做 16 个
for _, s in ipairs(numen.inv.items()) do print(s.item, s.count) end   -- 背包里有什么
```

要精细控制才手动来：

```lua
for _, r in ipairs(numen.inv.craftable()) do print(r.id, r.item, r.grid) end   -- 现在能做什么
numen.inv.craft("minecraft:stick", {count = 8})            -- 在自己身上那个 2x2 里做
```

- **3x3 配方**：`numen.move.to(台子, {arrive="use"})` → `numen.use.block(台子.pos)` → 再 `inv.craft` → `w:close()`。
- 熔炉类（smelting/blasting/smoking/campfire）不是 `craft`，是往炉子里塞料烧（见 3.5）。
- 丢东西：`numen.inv.drop("minecraft:cobblestone", {count = 32})`（会先问主人；丢在地上 5 分钟就没了）。

## 3.9 挖、敲、打

```lua
local ores = numen.scan.blocks({"iron_ore", "deepslate_iron_ore"}, {radius = 32})
numen.work.dig(ores[1])                       -- 走过去挖掉（自己换最好的工具）
numen.use.hit({x = 120, y = 64, z = -35})     -- 只敲一下（开箱子敲一下没用，用 use.block）
local foe = numen.scan.entities("hostile", {radius = 16})[1]
if foe then numen.fight.attack(foe) end       -- 打到死/跑掉/够不着为止
```

## 3.10 上船 / 上马 / 下车

`scan.entities` 的第一个参数**只认五个**：`hostile` / `passive` / `player` / `item` / `all`
（写 `"boat"`、`"sheep"`、`"villager"` 会直接 `bad_argument`）。挑具体种类要按 `e.type` 过滤：

```lua
local function find(kind, radius)
  for _, e in ipairs(numen.scan.entities("all", {radius = radius or 24})) do
    if e.type == kind then return e end
  end
end
local boat = find("minecraft:oak_boat") or find("minecraft:boat")
if boat then
  numen.move.to(boat, {arrive = "use"})
  numen.use.entity(boat)                      -- 右键上去
end
numen.move.dismount()                         -- 下来
```

实体字段只有这些：`id / type（满名，如 minecraft:sheep）/ name / category（player|passive|hostile…）/ pos / hp / max_hp / distance`。

船在水里走、马要鞍；骑着的时候 `move.go` 照样能用。

## 3.11 钓鱼

```lua
numen.work.fish()                             -- 抛一次、等鱼咬、收杆，返回钓到的东西
for i = 1, 5 do numen.work.fish() end         -- 连着钓五杆
```

要求：手里有鱼竿、站在岸上、面前有开阔水面。它**不会走路**，先自己站好。

## 3.12 剪羊毛 / 挤奶 / 喂动物 / 拴绳

这些都是「拿着东西右键实体」：

```lua
local function find(kind, radius)
  for _, e in ipairs(numen.scan.entities("all", {radius = radius or 24})) do
    if e.type == kind then return e end
  end
end
local sheep = find("minecraft:sheep")
if sheep then
  numen.move.to(sheep, {arrive = "use"})
  numen.use.entity(sheep, {item = "minecraft:shears"})      -- 剪羊毛
  numen.use.entity(sheep, {item = "minecraft:lead"})        -- 拴上
end
local cow = find("minecraft:cow")
if cow then
  numen.use.entity(cow, {item = "minecraft:bucket"})        -- 挤奶
  numen.use.entity(cow, {item = "minecraft:wheat"})         -- 喂（繁殖/催熟）
end
```

## 3.13 按钮 / 拉杆 / 门 / 活板门 / 唱片机

全部是 `numen.use.block(pos)`（右键那一格），空气格也行：

```lua
numen.use.block({x = 120, y = 64, z = -35})                  -- 按按钮 / 拉杆 / 开门 / 翻活板门
numen.use.block({x = 120, y = 63, z = -35}, {item = "minecraft:flint_and_steel"})  -- 点火
numen.use.block(pos, {item = "minecraft:oak_planks", sneak = true})  -- Shift+右键：放东西到箱子上而不是打开它
```

## 3.14 村民交易

```lua
local function find(kind, radius)
  for _, e in ipairs(numen.scan.entities("all", {radius = radius or 24})) do
    if e.type == kind then return e end
  end
end
local v = find("minecraft:villager")
if v then
  numen.move.to(v, {arrive = "use"})
  local w = numen.use.entity(v)               -- 打开交易界面
  for _, s in ipairs(w.slots) do if s.item then print(s.index, s.item, s.count) end end
  w:close()
end
```

交易窗口和容器是同一套 `slots / put / take / move / quick / close`；先看清楚哪个 index 是什么再动，
**别乱花主人的绿宝石**。

## 3.15 附魔台 / 铁砧 / 砂轮 / 织布机 / 切石机 / 锻造台 / 讲台 / 信标

同一个套路：走过去 → `use.block` 打开 → 看 `w.slots` 决定往哪格放（`w:move(from, to)` 或 `w:put`）→ `w:close()`。

```lua
numen.move.to(station, {arrive = "use"})
local w = numen.use.block(station.pos)
for _, s in ipairs(w.slots) do
  if s.item then print(s.index, s.side, s.item, s.count) end
end
-- 例：附魔台把剑放进 0 号格、青金石放 1 号格，再点附魔按钮（需要等级，看 w.data）
```

界面里 `side` 只有四种：`container`（机器那边）/ `you`（自己背包）/ `grid`（合成格）/ `result`（只能取的成品）。

## 3.16 种地 / 骨粉

```lua
numen.use.block(soil_pos, {item = "minecraft:iron_hoe"})       -- 锄地
numen.use.block(soil_pos, {item = "minecraft:wheat_seeds"})    -- 播种
numen.use.block(crop_pos, {item = "minecraft:bone_meal"})      -- 催熟
```

## 3.17 等时间 / 定提醒（别原地空转）

```lua
numen.time.wait(30)                                            -- 等 30 秒世界时间
numen.task.timer("去把熔炉里的铁取出来", {after = 300})          -- 5 分钟后提醒自己（主人也看得到）
```

`task.timer` 立刻返回、不占身体，比 `time.wait` 长时间硬等好 —— 一轮里要等就排个提醒然后先干别的。

## 3.18 通用四条（所有交互都适用）

1. **先站好再动手**：所有 `use.*` / `work.*` / `fight.*` 都不走路，够不着会直接报错并告诉你该调哪个 `move.to` —— 复制它给的那句就行。
2. **右键看结果**：返回里的 `Clicked` 会说清点到的是什么；点歪了（前面有高草、树叶、别的方块）它会点名，照着换一格。
3. **别连点**：同一位置点两次没反应 = 方法不对（该用 `work.dig` 而不是 `use.hit`，该先开门再走），换法子，别原地磨。
4. **主人的东西别乱动**：动他的箱子、宠物、命名生物、村民会先问他；被拒绝就换事做。
