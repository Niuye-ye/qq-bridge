// 社交与内容工具族：图片/表情查看、表情包体系、发图片、QQ 空间说说、活动状态、目标与时间线、
// 长期记忆（remember / recall / forget）、情绪、语音、自画像、看屏幕、合并转发查看。
//
// 职责：把「她在 QQ 里怎么表达自己」的动作与只读视图包成工具；重活（合成图片/语音）在桥接侧，
// 这里只透传参数并把结果序列化给模型。
//
// 明确不做：不做二代会话收发（见 chat-tools.mjs）、不做本地文件读写（见 file-tools.mjs）、
// 不直接连 OneBot。
//
// 状态归属：无模块级可变状态；cfg 决定各子系统开关（sticker / image / qzone / voice 等）。
//
// 接口约定：registerSocialTools(server, ctx) —— 注册期同步调用一次；
// ctx = { cfg, agentApi, errorText, serializeModelData }。
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';

export function registerSocialTools(server, ctx) {
  const { cfg, agentApi, errorText, serializeModelData } = ctx;
  // 2026-11-09：链路也能跑在 Android 手机上（Termux + proot），文案别一直说「模拟器」
  const DEVICE_WORD = process.platform === 'android' ? '手机' : '模拟器';
// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().optional().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）。也可以不给，改用 query 按分类挑一张'),
      query: z.string().optional().describe('按分类/关键词挑表情（例如"笑死""阴阳怪气""看热闹""无语"）。按表情的备注、标签、用法匹配，命中同分时随机取一张；stickerId 和 query 至少给一个'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, query, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: stickerId ? String(stickerId) : '', query: query ?? '', replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 发普通图片（照片 / 截图 / 自画像） ───────────────────────────────────────
if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '在指定会话发一张普通图片（照片、截图、你自己的形象图），跟表情包不是一回事（表情包用 qq_send_sticker）。三种来源任选：① path 传 qq-bridge 目录下的图片相对路径，例如 assets/deepseek娘.png、diary/x.png；② url 传网络图片地址；③ screenshot: true 现拍一张模拟器当前屏幕发过去。图片本身不带文字；想说的话先单独发一条。真人发图前会说一句、发完可能补一句，别连着甩好几张。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      path: z.string().optional().describe('qq-bridge 下的图片路径，如 assets/deepseek娘.png（只允许 assets/ diary/ state/ memory/ 里的 png/jpg/jpeg/gif/webp/bmp）'),
      url: z.string().optional().describe('网络图片地址（http/https）'),
      screenshot: z.boolean().optional().describe('传 true 就现拍一张模拟器（MuMu）当前屏幕发过去，不用给 path/url'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, path: imgPath, url: imgUrl, screenshot, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({
            key,
            path: imgPath ? String(imgPath) : '',
            url: imgUrl ? String(imgUrl) : '',
            screenshot: screenshot === true,
            replyToMessageId,
            atUserId: atUserId ?? null
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── QQ 空间（说说） ──────────────────────────────────────────────────────────
if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.sendQzone !== false) {
  server.tool(
    'qq_send_mood',
    '发一条 QQ 空间说说（发动态）。日常碎碎念、突然想到的事、心情低谷时的独白都可以发；不是任务汇报，也别每天硬凑。有每日条数上限，超了会被拒（返回里带 usedToday / maxPerDay）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号（说说发在你自己空间，这里只用来校验令牌）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      content: z.string().describe('说说正文（纯文本，最多 1000 字）'),
      images: z.array(z.string()).optional().describe('配图地址数组（http(s):// 或 file://），可选'),
      ugc_right: z.number().optional().describe('可见范围：1=所有人（默认）4=好友 16=部分好友可见 64=仅自己可见 128=部分好友不可见'),
      targetUins: z.array(z.string()).optional().describe('ugc_right 为 16/128 时的目标 QQ 号数组')
    },
    async ({ key, token, content, images, ugc_right, targetUins }) => {
      try {
        const data = await agentApi('/api/socialV2/send-qzone', {
          method: 'POST',
          body: JSON.stringify({ key, token, content, images, ugc_right, targetUins }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.setActivity !== false) {
  server.tool(
    'qq_set_activity',
    '记下你「现在在干嘛」：干嘛、心里想着什么、接下来打算干嘛。定时自醒时会读出来，让你接着上一件事继续。只传想改的字段。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      doing: z.string().optional().describe('在干什么，比如「刷小黑盒」「看B站」「发呆」'),
      note: z.string().optional().describe('心里想着什么，比如「刚看到个离谱帖子」'),
      plan: z.string().optional().describe('接下来打算干嘛，比如「再刷十分钟去吃饭」')
    },
    async ({ key, token, doing, note, plan }) => {
      try {
        const data = await agentApi('/api/socialV2/now', {
          method: 'POST',
          body: JSON.stringify({ key, token, doing, note, plan }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记活动失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getActivity !== false) {
  server.tool(
    'qq_get_activity',
    '看你上次记的「现在在干嘛」（不传任何字段就是读）。',
    { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号') },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/now', {
          method: 'POST',
          body: JSON.stringify({ key, token }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读活动状态失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 她自己的目标和时间线 ────────────────────────────────────────────────
// 这是「主观能动性」的载体：目标由她自己写，醒来自动带进 prompt（【你自己想干的事】）。
if (cfg.socialV2?.tools?.goals !== false) {
  server.tool(
    'qq_add_goal',
    '记下一件你自己想干的事（不是别人派的）。醒来时这些会出现在【你自己想干的事】里，提醒你接着做。想到什么记什么，别客气。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      text: z.string().describe('想干的事，一句话，具体些，比如「看完那个显卡评测，去评论区看看有没有人吵架」'),
      want: z.number().optional().describe('有多想干，0~1，默认 0.5；越想要越靠前')
    },
    async ({ key, token, text, want }) => {
      try {
        const data = await agentApi('/api/socialV2/goals', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: 'add', text, want }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记目标失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_close_goal',
    '把一件想干的事收掉：干完了用 done，不想干了用 drop。传目标的文字片段或 id 都行。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      text: z.string().describe('目标 id 或其中一段文字'),
      done: z.boolean().optional().describe('true=干完了（默认），false=不想干了')
    },
    async ({ key, token, text, done }) => {
      try {
        const data = await agentApi('/api/socialV2/goals', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: done === false ? 'drop' : 'done', text }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收目标失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_append_life',
    '往「今天的时间线」里写一行：刚才干了什么。醒来时会看到【今天早些时候】，让你记着自己今天过到哪儿了。一轮结束前写一条。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      text: z.string().describe('一行，比如「13:40 刷小黑盒，看到有人在吵显卡」（时间会自己加）')
    },
    async ({ key, token, text }) => {
      try {
        const data = await agentApi('/api/socialV2/goals', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: 'life', text }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `写时间线失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.remember !== false) {
  server.tool(
    'qq_remember',
    '记一件事到长期记忆。每轮会自动带出几条，不用主动查。像人一样会淡忘：normal 随时间变淡（见闻约 12 天、事实 45 天、喜好 90 天、约定 120 天半衰期），淡到一定程度就想不起来了（qq_recall 还能翻回来）；被反复想起的事会越记越牢（复习间隔 1/2/4/7/15/30/60 天，每复习一次忘得更慢）。tier=long 是画像/约定，半衰期一年、永不彻底遗忘——别什么都标 long，一次性的见闻和事件一律 normal。带时间点的事（明天、周六、下周）一定要传 expiresAt，过期后它自己会淡出，你就不会一直催一件已经过去的事。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      text: z.string().describe('记什么，一句话，比如「YG 讨厌被叫主人」「说好了明天聊那个游戏」'),
      kind: z.enum(['fact', 'pref', 'event', 'promise']).optional().describe('fact=事实 pref=喜好 event=见闻 promise=约定'),
      tier: z.enum(['long', 'normal']).optional().describe('long=画像/约定（半衰期一年、永不彻底遗忘） normal=会变淡（默认，见闻/事件都用这个）'),
      expiresAt: z.string().optional().describe('这件事到什么时候就过去了，比如 2026-11-01 或 2026-11-01 20:00。带时间点的事必填，长期画像不填')
    },
    async ({ key, token, text, kind, tier, expiresAt }) => {
      try {
        const data = await agentApi('/api/socialV2/facts', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: 'add', text, kind, tier, expiresAt }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记记忆失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.recall !== false) {
  server.tool(
    'qq_recall',
    '翻长期记忆。不传 query 就是按记性强弱列出来；传了就在记忆文本里搜——连已经淡忘、快想不起来的事也会一起翻，翻到就算想起来了，会重新记住（强度拉回 0.25）。返回里 expired=true 表示那件事已经过期了（别再当没发生），deleted=true 表示这条你自己删过；strength 越低越模糊。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      query: z.string().optional().describe('搜索词，比如「游戏」「吃饭」'),
      limit: z.number().optional().describe('最多几条，默认 20，上限 60')
    },
    async ({ key, token, query, limit }) => {
      try {
        const data = await agentApi('/api/socialV2/facts', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: 'list', query, limit }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `翻记忆失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.forget !== false) {
  server.tool(
    'qq_forget',
    '忘掉一条记忆（记错了、不该记的）。给 id 或原文里的关键词都行。默认是软删：挪进遗忘池，以后想翻还能翻回来。真想彻底抹掉，就再删一次同一条。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      remove: z.string().describe('要删的记忆 id，或原文里的关键词')
    },
    async ({ key, token, remove }) => {
      try {
        const data = await agentApi('/api/socialV2/facts', {
          method: 'POST',
          body: JSON.stringify({ key, token, action: 'remove', remove }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删记忆失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.listQzone !== false) {
  server.tool(
    'qq_list_moods',
    '看看自己最近在 QQ 空间发过哪些说说（含今天已发条数）。发之前不确定会不会重复，或者想知道上次什么时候发的，先看这个。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号（只用来校验令牌）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      page_num: z.number().optional().describe('第几页，从 1 开始'),
      count: z.number().optional().describe('每页条数（1~50，默认 10）')
    },
    async ({ key, token, page_num, count }) => {
      try {
        const data = await agentApi('/api/socialV2/qzone-list', {
          method: 'POST',
          body: JSON.stringify({ key, token, page_num, count }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拉说说列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 2026-10-27 修：这个工具原来被误写在 getSelfImage 的 if 块里，关“自画像”会连带关掉“看屏幕”
if (cfg.socialV2?.tools?.seeScreen !== false) {
server.tool(
  'qq_see_screen',
  '看一眼手机/模拟器现在的屏幕，返回真正的画面（图片会直接进入你的视觉上下文，你能看见）。刷 feed、看视频、玩游戏、任何需要知道「屏幕现在长什么样」的时候都用它。**看画面一律用它**。mcp__android__screenshot 也能看图，但它是 adb 抓屏，**网页类页面（WebView，比如小黑盒帖子详情、B站部分页）会截成白屏**，而且抓的是独立图层、不保证和你眼睛看到的一致。只有在需要精确像素坐标时才用 android 那个，判断白屏或卡住一律以 qq_see_screen 为准。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/screen', {
        method: 'POST',
        body: JSON.stringify({ key, token }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      if (!data?.data) {
        return { content: [{ type: 'text', text: `看屏幕失败：${errorText(data?.error, '没拿到画面')}` }], isError: true };
      }
      return {
        content: [
          { type: 'text', text: `${DEVICE_WORD}当前屏幕（约 ${Math.round((data.bytes || 0) / 1024)} KB${data.rawBytes && data.rawBytes > (data.bytes || 0) ? `，已从 ${Math.round(data.rawBytes / 1024)} KB 缩图` : ''}）` },
          { type: 'image', mimeType: data.mimeType || 'image/png', data: data.data }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `看屏幕失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

}
