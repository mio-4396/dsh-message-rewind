/**
 * dsh-message-rewind — browser half.
 *
 * Withdraw one of your own messages from a conversation and keep editing it:
 *
 *   1. `conversation.chat.user.before` is a chain seat that the official user
 *      row renders directly above its bubble. Selecting `kind === 'user'` puts a
 *      small chip in that seat for every durable message you sent; steering and
 *      pending rows never reach the slot.
 *   2. Clicking it reads the row's Chat node through its React fiber — the node
 *      carries `anchorSeq` (the `user/message` event seq) and the message
 *      content — then forks the Session at `anchorSeq - 1`, so the new branch is
 *      exactly the conversation *before* this message. The original Session is
 *      untouched and stays in the sidebar.
 *   3. The Client opens the fork and seeds its composer draft with the original
 *      text through `ctx.conversation.input.requestDraftInitialization` — the
 *      same door `uiWorkspace.startSession({ prompt })` uses. You edit and press
 *      Enter.
 *
 * A first message has no prefix to fork, so that case opens a blank Session in
 * the same workspace with the text staged instead. Either way nothing is lost.
 *
 * The whole file is one IIFE: the shell evaluates this script in the page realm
 * again on a plugin rebuild, and a top-level `const` would die with "already
 * declared" before anything registered.
 */

(function () {
  'use strict'

  window.__ModuleLoader__.load({
    id: 'dsh-message-rewind',

    factory: (require) => {
      const React = require('react')
      const h = React.createElement

      /** Injected style element id, so a second evaluation reuses one sheet. */
      const STYLE_ID = 'dsh-message-rewind-style'

      /** How far up the React tree to look for the Chat row that owns the bubble. */
      const MAX_FIBER_HOPS = 60

      /** How long to wait for the new Session's binding before giving up on the draft. */
      const BINDING_WAIT_MS = 5000

      const COPY = {
        zh: {
          withdraw: '撤回',
          busy: '撤回中',
          tip: '撤回这条消息：停止本轮回复，并把原文放回输入框给你修改。',
          withdrawnMark: '已撤回',
          emptyNoText: '这条消息没有文字内容，无法放回输入框',
          copied: '原文已复制到剪贴板，可直接粘贴',
          noDraft: '原文既没能放回输入框也没能复制；请手动输入',
          lost: '无法定位这条消息（界面结构可能已变化）',
          failed: '撤回失败：',
          noService: '会话服务不可用，撤回没有执行',
        },
        en: {
          withdraw: 'Withdraw',
          busy: 'Withdrawing',
          tip: 'Withdraw this message: stop the running answer and put the text back in the composer to edit.',
          withdrawnMark: 'Withdrawn',
          emptyNoText: 'This message has no text to put back',
          copied: 'The text is on the clipboard',
          noDraft: 'The text could be neither restored nor copied; type it again',
          lost: 'This message could not be located (the UI structure may have changed)',
          failed: 'Withdraw failed: ',
          noService: 'The session services are unavailable, so nothing was withdrawn',
        },
      }

      /** Mutable state the slot components close over; filled in `apply`. */
      const runtime = {
        ctx: null,
        language: 'zh',
      }

      /**
       * Live composer facades, one per Session, recorded by the capture seat.
       *
       * The `conversation` service is the primary way to seed a draft, but it is
       * a scoped service: if a shell does not expose it from the plugin context,
       * the facade the composer hands to this seat is the fallback.
       * @type {Map<string, { actions: unknown, draft: string }>}
       */
      const captures = new Map()

      /** This package's Host route: the only thing here the browser cannot do itself. */
      const ROUTE = '/.dsh-message-rewind'

      /** Copy for the active language, read at render time so a switch is live. */
      function t(key) {
        const dict = COPY[runtime.language] ?? COPY.zh
        const text = dict[key]
        return typeof text === 'string' ? text : key
      }

      /* ------------------------------------------------------------------- *
       * Locale and toast stores
       * ------------------------------------------------------------------- */

      let localeVersion = 0
      const localeListeners = new Set()

      function subscribeLocale(listener) {
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      }

      function bumpLocale() {
        localeVersion += 1
        for (const listener of localeListeners) listener()
      }

      /** Re-render a component when the interface language changes. */
      function useLocale() {
        return React.useSyncExternalStore(
          subscribeLocale,
          () => localeVersion,
          () => localeVersion,
        )
      }

      const toast = {
        state: { text: '', tone: 'plain' },
        listeners: new Set(),
        subscribe(listener) {
          toast.listeners.add(listener)
          return () => {
            toast.listeners.delete(listener)
          }
        },
        getSnapshot() {
          return toast.state
        },
        set(text, tone) {
          toast.state = { text, tone: tone ?? 'plain' }
          for (const listener of toast.listeners) listener()
        },
      }

      let toastTimer = null

      /** Show one short-lived notice at the bottom of the page. */
      function notify(text, tone) {
        toast.set(text, tone)
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = setTimeout(() => {
          toastTimer = null
          toast.set('', 'plain')
        }, 4200)
      }

      /* ------------------------------------------------------------------- *
       * Reading the Chat node that owns the clicked row
       * ------------------------------------------------------------------- */

      /** The React fiber attached to one DOM element, if React kept one. */
      function fiberOf(element) {
        let keys
        try {
          keys = Object.keys(element)
        } catch {
          return null
        }
        for (const key of keys) {
          if (!key.startsWith('__reactFiber$')) continue
          try {
            return element[key]
          } catch {
            return null
          }
        }
        return null
      }

      /**
       * The Chat node rendered by this row.
       *
       * The user renderer hands its node to `UserStyleBubble` and from there down
       * to this seat, so a short walk up the return path reaches the props that
       * carry it: `{ key, kind, anchorSeq, data: { content, time, seq } }`.
       */
      function chatNodeAbove(element) {
        let fiber = fiberOf(element)
        let hops = 0
        while (fiber !== null && fiber !== undefined && hops < MAX_FIBER_HOPS) {
          const props = fiber.memoizedProps
          if (props !== null && typeof props === 'object') {
            const node = props.node
            if (node !== null && typeof node === 'object' && typeof node.anchorSeq === 'number') {
              const data = node.data
              if (data !== null && typeof data === 'object' && Array.isArray(data.content)) {
                return node
              }
            }
          }
          fiber = fiber.return
          hops += 1
        }
        return null
      }

      /** Concatenated text blocks of one message, exactly as the bubble shows them. */
      function textOfNode(node) {
        const content = Array.isArray(node?.data?.content) ? node.data.content : []
        let text = ''
        for (const block of content) {
          if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            text += block.text
          }
        }
        return text
      }

      /** Whether the message also carried images or files a restored draft cannot replay. */
      function hasAttachments(node) {
        const content = Array.isArray(node?.data?.content) ? node.data.content : []
        return content.some(
          (block) => block !== null && typeof block === 'object' && (block.type === 'image' || block.type === 'file'),
        )
      }

      /* ------------------------------------------------------------------- *
       * Withdrawing
       * ------------------------------------------------------------------- */

      const delay = (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms)
        })

      function messageOf(error) {
        if (error === null || error === undefined) return 'unknown'
        if (typeof error === 'string') return error
        if (typeof error.message === 'string' && error.message !== '') return error.message
        return String(error)
      }

      /** Last resort: keep the text reachable when the draft cannot be seeded. */
      async function copyToClipboard(text) {
        if (text === '') return false
        try {
          if (navigator?.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch {
          // A denied clipboard is not something the user can act on here.
        }
        return false
      }

      /** Wait for the Client to publish the binding of a Session it just opened. */
      async function waitForBinding(sessions, sessionId) {
        const deadline = Date.now() + BINDING_WAIT_MS
        while (Date.now() < deadline) {
          let binding
          try {
            binding = sessions.binding(sessionId)
          } catch {
            binding = undefined
          }
          if (binding !== undefined && binding !== null) return binding
          await delay(50)
        }
        return null
      }

      /**
       * Put `text` into the composer of an already-open Session.
       *
       * `requestDraftInitialization` is the supported entry point: it resolves the
       * resident input shell for that binding (importing any persisted draft
       * first) and applies the requested text as one non-undoable seed.
       */
      async function seedDraft(ctx, sessionId, text) {
        if (await seedThroughConversation(ctx, sessionId, text)) return true
        return await seedThroughComposer(sessionId, text)
      }

      /** Primary seeding path: the scoped conversation service, by binding. */
      async function seedThroughConversation(ctx, sessionId, text) {
        const sessions = ctx.get('sessions')
        const conversation = ctx.get('conversation')
        if (sessions === undefined || conversation === undefined) return false
        const input = conversation?.input
        if (input === undefined || typeof input.requestDraftInitialization !== 'function') return false

        const binding = await waitForBinding(sessions, sessionId)
        if (binding === null) return false

        for (let attempt = 0; attempt < 25; attempt += 1) {
          let result
          try {
            result = input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'replace' })
          } catch {
            return false
          }
          if (result === 'applied') return true
          if (result !== 'blocked') return false
          await delay(120)
        }
        return false
      }

      /**
       * Fallback seeding path: the composer facade this plugin already receives
       * as a standard prop for whichever Session is open. `setDraft` is the same
       * write the seeded path ends in; the published draft confirms it landed.
       */
      async function seedThroughComposer(sessionId, text) {
        const deadline = Date.now() + BINDING_WAIT_MS
        let record
        while (Date.now() < deadline) {
          record = captures.get(sessionId)
          if (record !== undefined && typeof record.actions?.setDraft === 'function') break
          record = undefined
          await delay(50)
        }
        if (record === undefined) return false

        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            record.actions.setDraft(text)
          } catch {
            return false
          }
          await delay(120)
          const latest = captures.get(sessionId)
          if (latest !== undefined && latest.draft === text) return true
        }
        return false
      }

      /**
       * Withdraw one message: stop the running turn and put the message back in
       * the composer.
       *
       * The transcript is append-only by design — the engine renders it only from
       * append-origin surface events, and a landed surface replacement is
       * model-only — so the message cannot be erased from the conversation it was
       * sent in. What a withdrawal can honestly do is stop the answer that is
       * being written for it and hand the text back, in the same Session, so the
       * next thing sent replaces it.
       */
      async function withdraw(ctx, options) {
        const { sessionId, node } = options
        const sessions = ctx.get('sessions')
        if (sessions === undefined) {
          notify(t('noService'), 'error')
          return false
        }

        const text = textOfNode(node)
        if (text.trim() === '') {
          notify(t('emptyNoText'), 'plain')
          return false
        }

        const cancelled = await cancelTurn(sessionId)
        if (cancelled) markWithdrawalLabel()
        // Give the Session a moment to leave its frozen submission phase before
        // the draft write; the seeding loop retries anyway.
        if (cancelled) await delay(120)

        const seeded = await seedDraft(ctx, sessionId, text)
        // Success is visible in the composer itself, so it gets no notice; only a
        // withdrawal that could not hand the text back needs to say so.
        if (seeded) return true
        const copied = await copyToClipboard(text)
        notify(copied ? t('copied') : t('noDraft'), copied ? 'plain' : 'error')
        return false
      }

      /**
       * Stop the turn that is running for this Session.
       *
       * Cancellation is a Host concern (the Agent owns the turn), and a plain-JS
       * Client half has no Remote namespace, so the request goes through this
       * package's own Host route.
       */
      async function cancelTurn(sessionId) {
        try {
          const response = await fetch(`${ROUTE}/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          })
          if (response.ok !== true) return false
          const payload = await response.json()
          return payload?.ok === true
        } catch {
          return false
        }
      }

      /* ------------------------------------------------------------------- *
       * Components
       * ------------------------------------------------------------------- */

      /** Small undo glyph; the chip's accessible name comes from its label. */
      function UndoGlyph() {
        return h(
          'svg',
          { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
          h('path', {
            d: 'M6.4 4.1 3.1 7.4l3.3 3.3',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M3.2 7.4h6.1a3.5 3.5 0 1 1 0 7H6.6',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
          }),
        )
      }

      /**
       * The per-message withdraw action.
       *
       * The extension seat sits above the bubble, but the action belongs in the
       * row's own action strip below it — the line that already carries the send
       * time and the copy action. Rather than introduce a second visual language,
       * this button is measured against the shipped copy action: same square, same
       * colour, same hover fill, placed one gap to its left. The offset comes from
       * the live layout, so theme font deltas and any later spacing change carry
       * over instead of being hard-coded here.
       *
       * The seat's owner props only carry the message source and row kind, so the
       * Chat node — with the event seq and the content — is read off the React
       * tree after mount (for the tooltip and the first-message case) and again on
       * click, in case the row was recycled.
       */
      function RewindChip(props) {
        useLocale()
        const sessionId = props.sessionId
        const kind = props.kind
        const [busy, setBusy] = React.useState(false)
        const [node, setNode] = React.useState(null)
        const [placement, setPlacement] = React.useState(null)
        const [marked, setMarked] = React.useState(false)
        const buttonRef = React.useRef(null)
        const seatRef = React.useRef(null)

        const measure = React.useCallback(() => {
          const seat = seatRef.current
          const button = buttonRef.current
          if (seat === null || seat === undefined || button === null || button === undefined) return
          const row = seat.parentElement?.parentElement ?? null
          const actions = row === null ? null : row.querySelector('[data-clock]')
          const copy = actions === null ? null : actions.querySelector('button')
          if (copy === null || copy === undefined) {
            setPlacement((prev) => (prev === null ? prev : null))
            return
          }
          const copyRect = copy.getBoundingClientRect()
          const seatRect = seat.getBoundingClientRect()
          if (copyRect.height <= 0 || seatRect.height > 100000) {
            setPlacement((prev) => (prev === null ? prev : null))
            return
          }
          // Only the vertical offset is measured. The horizontal anchor is pure CSS
          // (one copy width plus one gap from the row's right edge), because the
          // seat's own width is not settled when this first runs — measuring it
          // there is what once put the button in the middle of the row.
          const top = Math.round(copyRect.top - seatRect.top)
          if (!Number.isFinite(top)) {
            setPlacement((prev) => (prev === null ? prev : null))
            return
          }
          setPlacement((prev) => (prev !== null && prev.top === `${top}px` ? prev : { top: `${top}px` }))
        }, [])

        React.useLayoutEffect(() => {
          measure()
          if (typeof requestAnimationFrame !== 'function') return undefined
          const frame = requestAnimationFrame(measure)
          return () => {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          }
        }, [measure, sessionId, kind])

        // The bubble can re-wrap after a font loads or the column resizes; a stale
        // vertical offset would put the button on the wrong line.
        React.useEffect(() => {
          const seat = seatRef.current
          const row = seat?.parentElement?.parentElement ?? null
          if (row === null || typeof ResizeObserver !== 'function') return undefined
          const observer = new ResizeObserver(() => {
            measure()
          })
          observer.observe(row)
          return () => {
            observer.disconnect()
          }
        }, [measure])

        React.useEffect(() => {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
          window.addEventListener('resize', measure)
          return () => {
            window.removeEventListener('resize', measure)
          }
        }, [measure])

        React.useEffect(() => {
          const element = seatRef.current ?? buttonRef.current
          if (element === null || element === undefined) return
          const found = chatNodeAbove(element)
          setNode(found)
          setMarked(isWithdrawn(sessionId, messageIdOf(found)))
        }, [sessionId, kind])

        if (kind !== 'user' || sessionId === undefined) return null

        const onClick = (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (busy) return
          const element = buttonRef.current
          const target = node ?? (element === null || element === undefined ? null : chatNodeAbove(element))
          if (target === null) {
            notify(t('lost'), 'error')
            return
          }
          setBusy(true)
          Promise.resolve()
            .then(() => withdraw(runtime.ctx, { sessionId, node: target }))
            .then((done) => {
              if (done !== true) return
              rememberWithdrawn(sessionId, messageIdOf(target))
              setMarked(true)
            })
            .catch((error) => {
              notify(t('failed') + messageOf(error), 'error')
              notify(t('failed') + messageOf(error), 'error')
            })
            .finally(() => {
              setBusy(false)
            })
        }

        return h(
          'div',
          { className: marked ? 'dsh-rewind-seat is-marked' : 'dsh-rewind-seat', ref: seatRef },
          marked
            ? h('span', { className: 'dsh-rewind-mark' }, t('withdrawnMark'))
            : h(
                'button',
                {
                  type: 'button',
                  ref: buttonRef,
                  className: 'dsh-rewind-chip',
                  style: placement ?? undefined,
                  'data-tip': t('withdraw'),
                  'aria-label': t('withdraw'),
                  'aria-description': t('tip'),
                  disabled: busy,
                  onClick,
                },
                h(UndoGlyph),
              ),
        )
      }

      /**
       * Invisible composer seat.
       *
       * Every slot entry receives the open Session's `inputActions` and a
       * `useInput` hook over its published state, so this entry records the live
       * composer facade for the Session on screen. It renders nothing and exists
       * only to make `seedThroughComposer` possible.
       */
      function ComposerCapture(props) {
        const sessionId = props.sessionId
        const readInput = typeof props.useInput === 'function' ? props.useInput : null
        const draft = readInput === null ? '' : readInput(draftOf)
        if (typeof sessionId === 'string' && sessionId !== '') {
          captures.set(sessionId, { actions: props.inputActions, draft: typeof draft === 'string' ? draft : '' })
        }
        return null
      }

      /** Plain-text projection of the composer state, tolerant of any shell shape. */
      function draftOf(state) {
        return state !== null && typeof state === 'object' && typeof state.draft === 'string' ? state.draft : ''
      }


      /** Where the per-Session set of withdrawn message ids is remembered. */
      const MARKS_KEY = 'dsh-message-rewind:withdrawn:v1'

      /** Every withdrawn message id, keyed by Session, as last written. */
      function readMarks() {
        try {
          const raw = window.localStorage.getItem(MARKS_KEY)
          if (typeof raw !== 'string' || raw === '') return {}
          const parsed = JSON.parse(raw)
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        } catch {
          return {}
        }
      }

      /** Whether this exact message was withdrawn in this Session. */
      function isWithdrawn(sessionId, messageId) {
        if (typeof messageId !== 'string' || messageId === '') return false
        const ids = readMarks()[sessionId]
        return Array.isArray(ids) && ids.includes(messageId)
      }

      /**
       * Remember one withdrawn message.
       *
       * The log keeps the message, so the mark is what makes the row read as
       * withdrawn after a reload; it is capped per Session and in Session count so
       * it stays a small preference record rather than conversation storage.
       */
      function rememberWithdrawn(sessionId, messageId) {
        if (typeof messageId !== 'string' || messageId === '') return
        try {
          const marks = readMarks()
          const ids = Array.isArray(marks[sessionId]) ? marks[sessionId].filter((id) => typeof id === 'string') : []
          if (ids.includes(messageId)) return
          ids.push(messageId)
          marks[sessionId] = ids.slice(-200)
          const sessions = Object.keys(marks)
          if (sessions.length > 20) delete marks[sessions[0]]
          window.localStorage.setItem(MARKS_KEY, JSON.stringify(marks))
        } catch {
          // Storage may be unavailable; the current row still shows its marker.
        }
      }

      /** The durable identity of one user message row. */
      function messageIdOf(node) {
        const id = node?.data?.messageId ?? node?.id
        return typeof id === 'string' ? id : ''
      }

      /** Wall-clock window in which a stopped turn's label reads as withdrawn. */
      const WITHDRAW_LABEL_MS = 60_000

      let withdrawLabelUntil = 0

      /**
       * Mark the turn that is about to end as withdrawn rather than stopped.
       *
       * The row's label is a plain locale lookup (`chat` / `message.stopped`) with
       * no per-turn context, and the locale service refuses to re-register a
       * locale a namespace already owns. So the one word is intercepted at the
       * translate call instead — briefly, so an unrelated manual stop keeps its
       * own wording.
       */
      function markWithdrawalLabel() {
        withdrawLabelUntil = Date.now() + WITHDRAW_LABEL_MS
      }

      /** Intercept the stopped-turn label while a withdrawal is what ended it. */
      function installStoppedLabelPatch(ctx) {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale === undefined || locale === null || typeof locale.translate !== 'function') return () => {}
        const original = locale.translate
        const patched = function translate(ns, key, params) {
          if (ns === 'chat' && key === 'message.stopped' && Date.now() < withdrawLabelUntil) {
            return runtime.language === 'en' ? 'Withdrawn' : '已撤回'
          }
          return original.call(this, ns, key, params)
        }
        try {
          locale.translate = patched
        } catch {
          return () => {}
        }
        return () => {
          if (locale.translate === patched) locale.translate = original
        }
      }

      /** One transient notice, mounted in the frame overlay. */
      function RewindToast() {
        useLocale()
        const state = React.useSyncExternalStore(toast.subscribe, toast.getSnapshot, toast.getSnapshot)
        if (state.text === '') return null
        return h(
          'div',
          {
            className: 'dsh-rewind-toast',
            'data-tone': state.tone,
            role: 'status',
            'aria-live': 'polite',
          },
          state.text,
        )
      }

      /* ------------------------------------------------------------------- *
       * Styles
       * ------------------------------------------------------------------- */

      const STYLES = `
.dsh-rewind-seat {
  position: relative;
  display: block;
  height: 0;
  /* Full row width (the row aligns its children to the end), so the seat can
     measure the action strip it places the button against. */
  align-self: stretch;
  /* Keeps the row's own 6px gap from moving the bubble. */
  margin-bottom: -6px;
  pointer-events: none;
}
.dsh-rewind-chip {
  position: absolute;
  top: 2px;
  /* One copy action plus one gap from the row's right edge: the action strip is
     right-aligned, so this lands exactly between the send time and the copy
     action without depending on any measured horizontal offset. */
  right: calc(36px + var(--dsh-content-font-delta, 0px));
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  box-sizing: border-box;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #a0a5ad);
  cursor: pointer;
  pointer-events: auto;
  opacity: 1;
  transition: opacity 80ms ease, background-color 80ms ease, color 80ms ease;
}
.dsh-rewind-chip svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
  flex: none;
}
/* A withdrawn row keeps its send time and copy action; only the bubble steps
   aside, so the note reads in the message's place above the usual strip. */
.dsh-rewind-seat.is-marked {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  height: auto;
  margin-bottom: 0;
  padding-right: 2px;
}
.dsh-rewind-mark {
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary, #a0a5ad);
  white-space: nowrap;
  user-select: none;
}
[data-slot="conversation.chat.user.before"]:has(.dsh-rewind-mark) ~ *:not([data-clock]) {
  display: none;
}
/* Reserve one cell inside the shipped action strip: the send time moves one
   button-width left, the copy action keeps its place, and the withdraw action
   lands between them (time · withdraw · copy). The reservation is dropped on
   rows where the strip itself is hidden for a following message. */
[data-chat-flow-kind="user"] [data-clock="start"] > span:first-child {
  margin-right: calc(28px + var(--dsh-content-font-delta, 0px) + 8px);
}
[data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]) [data-clock="start"] > span:first-child,
[data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="steering"]) [data-clock="start"] > span:first-child {
  margin-right: 0;
}
/* Mirror the shipped action strip's reveal rule with the same selectors, so the
   withdraw action and the copy action disappear and return together. */@media (hover: hover) {
  [data-actions-reveal="hover"] .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]) .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="steering"]) .dsh-rewind-chip {
    opacity: 0;
  }
  [data-actions-reveal="hover"]:hover .dsh-rewind-chip,
  [data-actions-reveal="hover"]:focus-within .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]):hover .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="user"]):focus-within .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="steering"]):hover .dsh-rewind-chip,
  [data-chat-flow-kind="user"]:has(~ [data-chat-flow-kind="steering"]):focus-within .dsh-rewind-chip,
  .dsh-rewind-chip:focus-visible {
    opacity: 1;
  }
}
.dsh-rewind-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--dsw-alias-label-secondary, #646a73);
}
.dsh-rewind-chip:disabled { opacity: 0.4; cursor: default; }
.dsh-rewind-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #247bbf); outline-offset: -2px; }
/* Same dark label bubble the shipped copy action shows on hover: the shell's own
   tooltip metrics (3px/7px padding, 13px/20px type), so the two read identically. */
.dsh-rewind-chip::after {
  content: attr(data-tip);
  position: absolute;
  /* The shipped bubble clears the 28px action by 8px; measured against the send
     time's text, that puts its top 26px below the time's top on the same row. */
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 3px 7px;
  box-sizing: border-box;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-tooltip-bg, rgba(18, 20, 24, 0.92));
  color: var(--dsw-static-neutral-bluish-00, #ffffff);
  font-family: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  white-space: pre-line;
  overflow-wrap: break-word;
  width: max-content;
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
  z-index: 2;
}
.dsh-rewind-chip:hover::after,
.dsh-rewind-chip:focus-visible::after { opacity: 1; }
@media (hover: none) { .dsh-rewind-chip::after { display: none; } }
.dsh-rewind-toast {
  position: fixed;
  left: 50%;
  bottom: 34px;
  transform: translateX(-50%);
  max-width: 440px;
  padding: 7px 14px;
  box-sizing: border-box;
  pointer-events: none;
  background: var(--dsw-alias-bg-overlay, #ffffff);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #646a73);
  z-index: 2147483000;
}
.dsh-rewind-toast[data-tone="error"] { color: var(--dsw-alias-state-error-primary, #d33b3b); }
`

      function installStyles() {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) {
          existing.textContent = STYLES
          return () => {}
        }
        const tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.textContent = STYLES
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }

      /** Active language of the interface, read from the locale service. */
      function readLanguage(ctx) {
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.()
          const active = typeof snapshot?.active === 'string' ? snapshot.active.toLowerCase() : ''
          if (active.startsWith('en')) return 'en'
          if (active !== '') return 'zh'
        } catch {
          // A shell without the locale service keeps the default language.
        }
        return runtime.language
      }

      /* ------------------------------------------------------------------- *
       * Activation
       * ------------------------------------------------------------------- */

      function apply(ctx) {
        runtime.ctx = ctx
        runtime.language = readLanguage(ctx)

        const slots = ctx.get('slots')
        if (slots === undefined || slots === null) {
          console.error('[dsh-message-rewind] no slot registry: the withdraw chip stays unregistered')
          return
        }

        ctx.effect(() => {
          const removeStyles = installStyles()
          const restoreLabel = installStoppedLabelPatch(ctx)

          let unsubscribeLocale = () => {}
          try {
            const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
            if (locale !== undefined && locale !== null && typeof locale.subscribe === 'function') {
              const stop = locale.subscribe(() => {
                runtime.language = readLanguage(ctx)
                bumpLocale()
              })
              unsubscribeLocale = () => stop?.()
            }
          } catch {
            // The chip label follows the boot language; nothing else depends on this.
          }

          const disposeChip = slots.inject('conversation.chat.user.before', () =>
            slots.register(
              {
                name: 'conversation.chat.user.before',
                // Elected for durable user rows only: the seat renders above the
                // bubble, and steering or pending rows never reach this slot.
                select: (owner) => (owner?.kind === 'user' ? true : null),
              },
              RewindChip,
            ),
          )

          const disposeToast = slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: 'dsh-message-rewind-toast', order: 60 }, RewindToast),
          )

          // Renders nothing; it only keeps the open Session's composer facade
          // reachable for the fallback draft seeding path.
          const disposeCapture = slots.inject('conversation.composer.dock', () =>
            slots.register({ name: 'conversation.composer.dock', id: 'dsh-message-rewind-capture', order: 90 }, ComposerCapture),
          )

          return () => {
            disposeChip?.()
            disposeToast?.()
            disposeCapture?.()
            unsubscribeLocale()
            restoreLabel?.()
            removeStyles()
            captures.clear()
            if (toastTimer !== null) {
              clearTimeout(toastTimer)
              toastTimer = null
            }
            toast.set('', 'plain')
          }
        }, 'dsh-message-rewind: withdraw chip and notices')
      }

      // Only `slots` is a hard dependency: every other service is resolved at
      // click time with `ctx.get`, so the plugin still activates in a shell that
      // composes differently.
      return { name: 'dsh-message-rewind', inject: ['slots'], apply }
    },
  })
})()
