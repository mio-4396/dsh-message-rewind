# dsh-message-rewind

Withdraw a message you just sent in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): **stop the answer that is being written, put the text back in the composer, and leave the row marked as withdrawn.**

在 DSH 对话里撤回自己发出的消息：**停止本轮回复 → 原文放回输入框 → 这条消息显示为「已撤回」**。

## What it looks like / 效果

- 你自己发的消息下方操作条里，时间与复制按钮之间多一个撤回图标（与复制按钮同尺寸、同配色，悬停显示黑底「撤回」）。
- 点它：正在输出的这一轮立刻停住，原文回到输入框；这条消息的气泡换成右对齐的灰色「已撤回」，发送时间与复制按钮保留。
- 轮结束标签（原本的「已停止」）在撤回后也会显示「已撤回」。

## Install / 安装

This is a standard DSH bundle: the `dsh.bundle.patch` in `package.json` inserts one row, and `dsh.client` declares the browser half.

```powershell
# from the DSH Plugins page, install by directory; or
dsh plugin install <path-to-this-directory>
```

Then reload the DSH page once. Host-side changes (`src/index.js` → `lib/index.js`) need a DSH restart, or toggling the plugin off and on in the Plugins page.

## Develop / 开发

```powershell
npm run build   # copy src/ -> lib/, then check manifest, patch, locales, icon, syntax
npm test        # build + the manifest/output suite
```

`lib/` is generated and committed: DSH loads `lib/index.js` and `lib/client.js`, so a change is not live until `npm run build` has run.

## How it works / 实现

| Step | Entry point |
| --- | --- |
| 操作条里的入口 | `conversation.chat.user.before` chain slot. The button's square, colour and hover bubble follow the shipped copy action; its position is CSS-anchored one copy-width plus one gap from the row's right edge, and only the vertical offset is measured |
| 读原文 | the Chat node is read off the React fiber above the bubble (`data.content`) |
| 停止本轮 | `POST /.dsh-message-rewind/cancel` → Host `sessionController.cancel({ sessionId })` |
| 原文放回 | `ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'replace' })`, with `setDraft` and then clipboard as fallbacks |
| 行内「已撤回」 | remembered in `localStorage` per Session and message id; the row hides its bubble and keeps its action strip |
| 轮结束标签 | after a withdrawal, intercepts one locale lookup (`chat` / `message.stopped`) for 60 seconds and returns “已撤回” |

## Why not delete the message / 为什么不做删除

DSH keeps an append-only session log, and the chat transcript is built **only from append-origin surface events** (`isAppendSurfaceEvent()`). A `surfaceOp: 'replace'` event deliberately affects the model context only — as the engine's own doc comment puts it, a landed replacement would erase conversation the user already saw. There is therefore no API that removes an already-sent message from the record. This plugin does what is possible: it stops the answer, hands the text back, and marks the row.

## Limits / 边界

- Only your own messages; steering rows and pending rows have no affordance.
- Only the last user message shows the action — the same visibility rule the shipped copy action follows.
- Images and files are not carried back into the draft; text is. Re-attach them by hand.
- The “已撤回” mark lives in `localStorage` (200 messages per Session, 20 Sessions). Clearing browser storage forgets it; the conversation record itself is never modified.
- The turn-end label override lasts 60 seconds, so a manual Stop right after a withdrawal keeps its own wording afterwards.

## Layout

```
package.json            bundle manifest: patch row + dsh.client entry
cordis.patch.yml        inserts the Host row
src/index.js            Host half: the cancel route
src/client.js           browser half: the action, the row mark, the notices
scripts/build.mjs       src/ -> lib/, then manifest/patch/locale/icon and syntax checks
tests/manifest.test.mjs manifest, output freshness and agreement tests
lib/index.js            built Host half (loaded by the Loader)
lib/client.js           built browser half (loaded as a classic script)
locale/{en,zh}.json     Plugin Manager title and description
icon.svg                plugin icon
.github/workflows/      CI: build + test on every push
CHANGELOG.md            release notes
```

## License

MIT
