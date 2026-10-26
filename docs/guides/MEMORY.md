# 长期记忆与遗忘（facts）

小鲸鱼的长期记忆放在 `state/facts.json`（gitignore，不进仓库）。它不只是一个列表 ——
每条记忆都有「强度」，会随时间变淡，也会被重新提起而变清晰。

## 1. 数据结构

```json
{
  "facts": [
    {
      "id": "fmvmh1yxx792",
      "text": "2026-10-24 晚 第一支视频已过审",
      "kind": "event",            // fact / pref / event / promise
      "tier": "normal",           // long / normal
      "at": "2026-10-24T14:06:03.813Z",
      "hits": 2,                 // 被想起过几次
      "str": 0.36,               // 上次被想起时的强度（0~1）
      "touched": "2026-10-26T09:48:22.449Z"  // 上次被想起的时间，衰减从这里起算
    }
  ]
}
```

老数据没有 `str` / `touched` 也能读：第一次衰减扫描时按 `kind`/`tier` 现算一个现值钉下来，之后正常衰减。

## 2. 半衰期（天）

| kind | normal | long |
|---|---|---|
| event 见闻 | 12 | 365 |
| fact 事实 | 45 | 365 |
| pref 喜好 | 90 | 365 |
| promise 约定 | 120 | 365 |

初始强度 `str`：`promise 0.9 / pref 0.85 / fact 0.55 / event 0.4`，long 一律 1。

当前强度 = `str × 0.5^(天数 / 半衰期)`，天数是 `touched` 到现在的间隔。
- **long 有下限 0.3 且永不归档** —— 画像和约定不会忘，只是越久越「说不太清」。
- 每次都从 `str` 起算而不是逐次连乘，所以重复调用不会越算越淡。

## 3. 忘掉与想起来

- **忘掉**：非 long 且强度 < `0.12` → 挪进 `state/facts-forgotten.json`（**不是删除**）。
  这一步由 `archiveFactsV2()` 做，有 20 分钟频率闸（`state/facts.tick` 记上次时间），
  每轮拼 prompt 前、`qq_recall` 前都会顺手调一次。
- **想起来**：`qq_recall` 带关键词去搜时，会把遗忘池一起翻；翻到就复原（强度拉回 0.25，移回活跃池）。
  空查询**不翻**遗忘池 —— 免得把「想不起来的事」一股脑倒出来。
- **加强**：
  - `qq_remember` 记了同一句话（原文完全相同）→ +0.4（`hits` 也会 +1）；
  - 收到的消息里命中某条记忆的连续 6 字片段 → +0.12，一轮最多 3 条；
  - `qq_recall` 翻到已淡忘的 → 直接复原到 0.25。
- **真删**：`qq_forget` 会同时清理活跃池和遗忘池。

## 4. 注入 prompt 的样子

`formatFactsLineV2()` 每轮拼进 wake prompt 的【你记得的事】：long 取最近 4 条、normal 取强度最高 2 条，
强度低会带口气标签 ——

| 强度 | 标签 |
|---|---|
| ≥ 0.65 | 无 |
| 0.35 ~ 0.65 | 「，记不太清了」 |
| < 0.35 | 「，只记得个大概」 |

遗忘池非空时末尾补一句「还有些事已经想不太起来了（大概 N 件），真去翻可能翻得到：qq_recall」。

## 5. 排查手法

```bash
# 看现在记得什么、强度多少（要控制台令牌；中文查询别用 curl，走 node fetch）
node -e "const t=require('fs').readFileSync('F:/qq-bridge/state/console-token','utf8').trim();
  fetch('http://127.0.0.1:3100/api/socialV2/facts?token='+t,{method:'POST',
  headers:{'content-type':'application/json','x-agent-token':'x'},
  body:JSON.stringify({action:'list',limit:10})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"

# 手动老化一条，看它会不会被忘掉（改完删掉 state/facts.tick 让扫描立刻跑）
#   at / touched 改成 40 天前、str 保持原值即可；然后 POST list 触发 archiveFactsV2
```

日志关键字：`[facts] 淡忘了 N 条` / `[facts] 想起来了` / `[facts] 又记了一遍`。

## 6. 一个坑

`curl` 在 Windows 的 git-bash 下会把中文参数按 GBK 发出去，桥收到的是乱码，
搜不到任何东西还以为是匹配写错了。**测中文查询一律用 node 的 fetch**。

## 7. 参数在哪改

全部在 `src/bridge.js` 的「── 长期记忆（会淡忘的事实）」段（约 L10667 起）：
`FACT_HALF_LIFE_DAYS`、`FACT_INIT_STR`、`FACTS_FORGET_BELOW`、`FACTS_LONG_FLOOR`、
`FACTS_DECAY_TICK_MS`、`FACTS_INJECT_LONG/NORMAL`、`FACTS_MAX`(80)、`FACTS_FORGOTTEN_MAX`(300)。
改完 `node --check` + `bin\restart-detached.ps1 -Part bridge`。
