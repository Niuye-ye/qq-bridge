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
