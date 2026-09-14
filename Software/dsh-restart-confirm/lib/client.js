// dsh-restart-confirm: CLIENT half.
//
// A top-of-page confirmation bar for the restart that the host half detects
// when the profile changes. The bar polls the host and, once a change is
// pending, offers [Restart now] / [Later]; the host restarts the service on
// "now" and the page disconnects a moment later.
//
// Bundle protocol (client-modules): a classic script that registers a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns the plugin exports. Only baseline platform modules are
// required (react, react/jsx-runtime), so nothing needs bundling.
window.__ModuleLoader__.load({
  id: 'dsh-restart-confirm',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')

    const STATE_URL = '/__restart-confirm/state'
    const RESPOND_URL = '/__restart-confirm/respond'
    const POLL_MS = 3000

    // --- copy -----------------------------------------------------------------

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
          title: '检测到插件变更',
          desc: '重启服务后，新安装或更新的插件才会生效',
          restartNow: '立即重启',
          later: '稍后',
          restarting: '正在重启…',
          auto: (seconds) => `${seconds} 秒后自动重启`,
        }
      : {
          title: 'Plugin changes detected',
          desc: 'The service must restart for installed or updated plugins to take effect',
          restartNow: 'Restart now',
          later: 'Later',
          restarting: 'Restarting…',
          auto: (seconds) => `restarts automatically in ${seconds}s`,
        }

    // --- poll state -----------------------------------------------------------

    /**
     * Poll the host and derive the bar's state.
     *
     * Two things have to survive the restart itself, which is why this keeps
     * more than the latest server snapshot:
     * - the countdown is anchored to a deadline captured when the pending
     *   change first appears, so it decreases monotonically instead of jumping
     *   forward with every poll;
     * - the bar is dismissed when the service comes back, which is observable
     *   as "the endpoint stops answering, then answers again". Without that,
     *   the page would keep polling the brand-new process and a stale bar could
     *   never clear, because the page is not reloaded by the restart.
     */
    function useRestartState() {
      const [snapshot, setSnapshot] = React.useState({ pending: false })
      const [confirmed, setConfirmed] = React.useState(false)
      const [done, setDone] = React.useState(false)
      const [now, setNow] = React.useState(() => Date.now())
      /** @type {{ deadline: number | null, wasDown: boolean, confirmed: boolean, done: boolean }} */
      const state = React.useRef({ deadline: null, wasDown: false, confirmed: false, done: false })

      React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          let data
          try {
            const res = await fetch(STATE_URL, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            data = await res.json()
          } catch {
            // The service is down: that is the restart in progress, not a
            // reason to drop the bar.
            state.current.wasDown = true
            return
          }
          if (cancelled) return

          const pending = data !== null && typeof data === 'object' && data.pending === true
          if (state.current.wasDown) {
            // The endpoint answered again after being unreachable, so the
            // service has restarted and any pending change was consumed.
            state.current.wasDown = false
            state.current.confirmed = false
            state.current.done = true
            setConfirmed(false)
            setDone(true)
          }
          if (pending) {
            // A new change supersedes a finished restart: show the bar again.
            if (state.current.done) {
              state.current.done = false
              setDone(false)
            }
            if (state.current.deadline === null && typeof data.autoRestartAt === 'number') {
              state.current.deadline = data.autoRestartAt
            }
          } else if (!state.current.confirmed) {
            state.current.deadline = null
          }
          // While the user has confirmed, the pending flag from the old process
          // is stale information: the restart is already under way.
          setSnapshot(state.current.confirmed ? { pending: false, restarting: true } : data)
        }
        void tick()
        const timer = setInterval(() => {
          setNow(Date.now())
          void tick()
        }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      const confirmRestart = React.useCallback(() => {
        state.current.confirmed = true
        state.current.done = false
        state.current.deadline = null
        setConfirmed(true)
        setDone(false)
        setSnapshot({ pending: false, restarting: true })
      }, [])

      return { snapshot, confirmed, done, confirmRestart, now, deadline: state.current.deadline }
    }

    // --- bar ------------------------------------------------------------------

    const barStyle = {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 2147483000,
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'none',
      padding: '10px 16px 0',
      boxSizing: 'border-box',
      fontFamily:
        "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
    }

    const pillStyle = {
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      flexWrap: 'wrap',
      padding: '10px 16px',
      borderRadius: '10px',
      boxShadow: '0 6px 24px rgba(0, 0, 0, .35)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .35))',
      background: 'var(--dsw-alias-bg-layer-2, #1f1f24)',
      color: 'var(--dsw-alias-label-primary, #ececec)',
      fontSize: '13px',
      lineHeight: '20px',
      maxWidth: '640px',
      boxSizing: 'border-box',
    }

    const secondaryButtonStyle = {
      padding: '6px 14px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, .4))',
      background: 'transparent',
      color: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    }

    const primaryButtonStyle = {
      padding: '6px 14px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
      fontSize: '13px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function RestartConfirmBar() {
      const { snapshot, confirmed, done, confirmRestart, now, deadline } = useRestartState()
      const [busy, setBusy] = React.useState(false)

      const isRestarting = confirmed || snapshot.restarting === true
      const secondsLeft = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000))

      // The restart finished: the service answered again after being
      // unreachable, so there is nothing left to confirm.
      if (done) return null
      if (snapshot.pending !== true && !isRestarting) return null

      const send = (action) => {
        if (busy) return
        setBusy(true)
        if (action === 'now') confirmRestart()
        void fetch(RESPOND_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        }).catch(() => {
          // "now" tears the connection down mid-request; that is expected.
        })
      }

      const text = jsxs('div', {
        style: { minWidth: 0 },
        children: [
          jsx('div', {
            style: { fontWeight: 600, fontSize: '13px', lineHeight: '20px' },
            children: isRestarting ? T.restarting : T.title,
          }),
          jsx('div', {
            style: {
              color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
              fontSize: '12px',
              lineHeight: '18px',
            },
            children: isRestarting
              ? T.desc
              : `${T.desc}${secondsLeft === null ? '' : ` · ${T.auto(secondsLeft)}`}`,
          }),
        ],
      })

      const actions = isRestarting
        ? null
        : jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px' },
            children: [
              jsx('button', {
                type: 'button',
                style: { ...secondaryButtonStyle, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: () => send('later'),
                children: T.later,
              }),
              jsx('button', {
                type: 'button',
                style: { ...primaryButtonStyle, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: () => send('now'),
                children: T.restartNow,
              }),
            ],
          })

      return jsx('div', {
        style: barStyle,
        'data-dsh-restart-confirm': '',
        children: jsxs('div', { style: pillStyle, children: [text, actions] }),
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      // `shell.overlay` is the full-page list slot: the bar floats above the
      // app instead of displacing the session header. Both the wait and the
      // registration are owned by this fiber through `ctx.effect`.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'restart-confirm', order: 100 },
          RestartConfirmBar
        )
      )
    }

    return { apply, inject: ['slots'] }
  },
})
