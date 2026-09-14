// dsh-webchat-entry: CLIENT half.
//
// One sidebar footer action that opens chat.deepseek.com in a NEW browser tab.
//
// Design constraints, all deliberate:
//
// 1. Official slot, no DOM patching. The entry registers into
//    `sidebar.footer.action` — the sidebar's free `list` slot, rendered by the
//    shell with `{ wide }`. Nothing here queries the document, inserts nodes by
//    hand, or observes mutations, so a shell re-render, a locale change or a
//    DOM restructure cannot make the entry drift or disappear.
//
// 2. A declarative anchor, so "new tab" is structural rather than a promise.
//    `target="_blank"` + `rel="noopener noreferrer"` on a user-initiated click
//    opens a new tab and cannot be popup-blocked. There is deliberately NO
//    `window.location` fallback: a failure must never navigate the harness page
//    away from the user's session.
//
// 3. Only platform seed words are required (react, react/jsx-runtime,
//    @deepseek-ai/dsh-client-store), so this bundle needs no bundler and cannot
//    drift with internal client packages.
//
// Bundle protocol (client-modules): a classic script that registers a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns the plugin exports.
window.__ModuleLoader__.load({
  id: 'dsh-webchat-entry',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    /** Destination of the entry. A constant: never built from user input. */
    const CHAT_URL = 'https://chat.deepseek.com/'

    /** Settings namespace shared with the host half. */
    const SETTINGS_NAMESPACE = 'dsh-webchat-entry'

    /** Field carrying the visibility preference. */
    const SHOW_ENTRY_FIELD = 'showEntry'

    // --- copy -----------------------------------------------------------------
    // Localized from the browser preference, matching the shell's own two-locale
    // set. Importing the locale service would add a dependency for two strings.

    const isZh =
      typeof navigator !== 'undefined' &&
      /^zh/i.test(
        String(
          (navigator.languages && navigator.languages[0]) ||
            navigator.language ||
            ''
        )
      )

    const T = isZh
      ? {
          label: '网页对话',
          hint: '在新标签页打开 chat.deepseek.com',
          settingTitle: '网页对话入口',
          settingDesc: '在侧边栏底部（设置按钮上方）显示 chat.deepseek.com 的入口，点击后在新标签页打开。',
        }
      : {
          label: 'Web Chat',
          hint: 'Open chat.deepseek.com in a new tab',
          settingTitle: 'DeepSeek web chat entry',
          settingDesc:
            'Show a chat.deepseek.com entry in the sidebar footer (above Settings). Clicking it opens a new browser tab.',
        }

    // --- settings policy ------------------------------------------------------

    /**
     * Durable visibility preference backed by the host settings section.
     *
     * Mirrors the shell's own policy shape: a reactive local store seeded from
     * the host section, so the switch repaints instantly while the write drains
     * in the background. When no settings scope exists the entry simply stays
     * visible instead of failing to mount.
     */
    class EntryPolicy {
      show = createSnapshotStore(true)
      host

      /**
       * @param host - durable settings scope owned by this plugin, or `undefined`.
       */
      constructor(host) {
        this.host = host
        if (host === undefined) return
        host.subscribe(() => {
          this.adopt()
        })
        this.adopt()
      }

      /**
       * Publish and persist one explicit user choice.
       * @param next - whether the entry is visible.
       */
      setShow(next) {
        if (this.show.getSnapshot() === next) return
        this.show.set(next)
        void this.host?.set(SHOW_ENTRY_FIELD, next)
      }

      /** Adopt the latest accepted host section without writing it back. */
      adopt() {
        const section = this.host.getSnapshot().value
        if (section === undefined || this.show.getSnapshot() === section[SHOW_ENTRY_FIELD]) return
        this.show.set(section[SHOW_ENTRY_FIELD])
      }
    }

    // --- entry ----------------------------------------------------------------

    /**
     * Shared geometry, mirroring the shell's own footer control so the click
     * target and the visual weight match the Settings row beside it:
     *
     *   .VOzbGW_trigger      { height:42px; border-radius:12px; flex:1;
     *                          padding:0 10px 0 8px; font-size:14px;
     *                          line-height:22px; gap:8px }
     *   .VOzbGW_triggerRow   { width:calc(100% + 4px); margin:4px -2px }
     *   .VOzbGW_trigger:hover{ background:var(--dsw-alias-interactive-bg-hover) }
     *
     * The wide variants below apply that verbatim. No `font-weight` is set
     * because the shell's row does not set one either.
     */
    const baseStyle = {
      display: 'flex',
      alignItems: 'center',
      boxSizing: 'border-box',
      color: 'var(--dsw-alias-label-primary)',
      textDecoration: 'none',
      fontFamily: 'inherit',
      fontSize: '14px',
      lineHeight: '22px',
      cursor: 'pointer',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      // Matches the shell's own control transition.
      transition: 'background-color 120ms ease',
    }

    /**
     * One glyph, sized for the current state. Built as elements rather than
     * `innerHTML` so no markup string is ever parsed.
     * @param size - Rendered glyph size in pixels.
     * @returns The chat-bubble icon.
     */
    function Glyph(size) {
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '3 3 18 18',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { flex: 'none', display: 'block' },
        children: [
          jsx('path', { d: 'M21 12a8 8 0 0 1-8 8H5l-3 2 1.5-4A8 8 0 1 1 21 12z' }),
          jsx('path', { d: 'M8.5 10h7' }),
          jsx('path', { d: 'M8.5 13.5h4.5' }),
        ],
      })
    }

    /**
     * The sidebar footer action.
     *
     * Rendered as an anchor, so "open in a new tab" is the browser's own
     * behaviour for a modified or plain click alike — no popup heuristics, no
     * navigation of the current page under any failure mode.
     *
     * @param props - Slot props: the shell's `wide` flag plus the settings hook.
     * @returns The anchor, or `null` when the entry is hidden.
     */
    function WebChatEntry({ wide, useShow }) {
      const show = useShow((value) => value)
      const [hover, setHover] = React.useState(false)

      if (!show) return null

      const style = wide
        ? {
            ...baseStyle,
            // Fill the footer row. `footerActions` is a row flex container, so
            // without `flex` the anchor would shrink to its content (106px
            // instead of the row's full width). The negative inline margin is
            // how the shell's own Settings row bleeds 2px past the column
            // padding to reach x=10 / width=260.
            flex: 1,
            margin: '0 -2px',
            gap: '8px',
            // Height is deliberately left at the shell footer-action default
            // rather than the 42px Settings row: the two controls keep their
            // own heights, and the footer stays exactly as tall as it is now.
            height: '34px',
            padding: '0 10px 0 8px',
            borderRadius: '12px',
            justifyContent: 'flex-start',
            background: hover
              ? 'var(--dsw-alias-interactive-bg-hover)'
              : 'transparent',
          }
        : {
            ...baseStyle,
            width: '36px',
            height: '36px',
            padding: 0,
            margin: '0 auto',
            borderRadius: '8px',
            justifyContent: 'center',
            background: hover
              ? 'var(--dsw-alias-interactive-bg-hover)'
              : 'transparent',
          }

      return jsxs('a', {
        href: CHAT_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: T.hint,
        'aria-label': T.hint,
        'data-dsh-webchat-entry': '',
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style,
        children: [
          // 16px matches the primitive icon set the Settings row uses; the
          // lighter stroke keeps the same optical weight at that size.
          Glyph(wide ? 16 : 18),
          wide
            ? jsx('span', {
                style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
                children: T.label,
              })
            : null,
        ],
      })
    }

    // --- settings row ---------------------------------------------------------

    /**
     * Visibility switch rendered in Settings -> General.
     * @param props - The settings hook plus its setter.
     * @returns The settings row.
     */
    function WebChatEntryToggle({ useShow, setShow }) {
      const show = useShow((value) => value)

      return jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          padding: '12px 0',
          width: '100%',
          boxSizing: 'border-box',
        },
        children: [
          jsxs('div', {
            style: { minWidth: 0 },
            children: [
              jsx('div', {
                style: {
                  fontSize: '14px',
                  fontWeight: 500,
                  lineHeight: '20px',
                  color: 'var(--dsw-alias-label-primary)',
                },
                children: T.settingTitle,
              }),
              jsx('div', {
                style: {
                  fontSize: '12px',
                  lineHeight: '18px',
                  marginTop: '2px',
                  color: 'var(--dsw-alias-label-secondary)',
                },
                children: T.settingDesc,
              }),
            ],
          }),
          jsx('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': show,
            'aria-label': T.settingTitle,
            onClick: () => setShow(!show),
            style: {
              flex: 'none',
              width: '38px',
              height: '22px',
              padding: 0,
              cursor: 'pointer',
              position: 'relative',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: show
                ? 'var(--dsw-alias-brand-primary)'
                : 'var(--dsw-alias-bg-layer-2)',
              transition: 'background-color 120ms ease',
            },
            children: jsx('span', {
              style: {
                position: 'absolute',
                top: '1px',
                left: '1px',
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                background: '#fff',
                transform: show ? 'translateX(16px)' : 'translateX(0)',
                transition: 'transform 120ms ease',
              },
            }),
          }),
        ],
      })
    }

    // --- plugin ---------------------------------------------------------------

    /** Client services this plugin needs. `slots` is the registration seam. */
    const inject = ['slots', 'settingsScope']

    /**
     * Mount the footer entry and its settings row.
     *
     * Registration is a one-line contribution per slot; both are owned by this
     * fiber, so unloading the plugin withdraws both entries with no cleanup
     * left to the plugin itself.
     *
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      const policy = new EntryPolicy(
        ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      )

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'webchat-entry',
            order: 20,
            inject: () => ({ hooks: { show: policy.show } }),
          },
          WebChatEntry
        )
      )

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'webchat-entry-toggle',
            order: 30,
            inject: () => ({
              hooks: { show: policy.show },
              setShow: (next) => {
                policy.setShow(next)
              },
            }),
          },
          WebChatEntryToggle
        )
      )
    }

    return { apply, inject }
  },
})
