// dsh-restart-confirm: CLIENT half.
//
// A slim top-of-page confirmation bar. Every few seconds the plugin polls the
// host's /__restart-confirm/state endpoint; when the systemd helper has
// advertised a pending post-plugin-install restart, the bar appears with
// [重启现在] / [稍后]. The answer is posted back to
// /__restart-confirm/respond; "now" restarts the service within ~2s (the page
// will disconnect), "later" cancels this restart. After the timeout with no
// answer the helper restarts anyway.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports (apply etc.).
// No JSX, no framework deps: plain DOM + theme tokens (--dsw-*), so it works
// in any web-shell client without additional packages.
window.__ModuleLoader__.load({
  id: 'dsh-restart-confirm',
  factory: (require) => {
    const STATE_URL = '/__restart-confirm/state'
    const RESPOND_URL = '/__restart-confirm/respond'
    const POLL_MS = 3000

    // --- copy (browser-language sniff) --------------------------------------

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
          desc: '重启服务后，新安装的插件才会生效',
          restartNow: '立即重启',
          later: '稍后',
          restarting: '正在重启…',
          auto: '超过 3 分钟未操作将自动重启',
        }
      : {
          title: 'Plugin changes detected',
          desc: 'The service must restart for newly installed plugins to take effect',
          restartNow: 'Restart now',
          later: 'Later',
          restarting: 'Restarting…',
          auto: 'Will restart automatically after 3 minutes',
        }

    // --- bar state -----------------------------------------------------------

    let bar = null
    let timer = null
    let responding = false

    function removeBar() {
      if (bar) {
        bar.remove()
        bar = null
      }
    }

    function setBusy() {
      if (!bar) return
      const btn = bar.querySelector('[data-rc-action="now"]')
      const later = bar.querySelector('[data-rc-action="later"]')
      if (btn) {
        btn.disabled = true
        btn.textContent = T.restarting
      }
      if (later) later.disabled = true
    }

    function ensureBar() {
      if (bar) return
      bar = document.createElement('div')
      bar.setAttribute('data-rc-bar', '')
      const style = (el, css) => {
        for (const [k, v] of Object.entries(css)) el.style[k] = v
      }

      // full-width overlay strip pinned to the top of the page; clicks pass
      // through the empty sides and land on the pill only
      style(bar, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: '2147483000',
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        padding: '10px 16px 0',
        boxSizing: 'border-box',
        fontFamily:
          "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
      })

      const pill = document.createElement('div')
      style(pill, {
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        padding: '10px 16px',
        borderRadius: '10px',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, #1f1f24)',
        color: 'var(--dsw-alias-label-primary, #ececec)',
        fontSize: '13px',
        lineHeight: '20px',
        maxWidth: '640px',
        boxSizing: 'border-box',
      })

      const text = document.createElement('div')
      text.style.minWidth = '0'
      const title = document.createElement('div')
      title.textContent = T.title
      style(title, {
        fontWeight: '600',
        fontSize: '13px',
        lineHeight: '20px',
      })
      const desc = document.createElement('div')
      desc.textContent = T.desc + ' · ' + T.auto
      style(desc, {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: '12px',
        lineHeight: '18px',
      })
      text.appendChild(title)
      text.appendChild(desc)
      pill.appendChild(text)

      const actions = document.createElement('div')
      style(actions, { display: 'flex', alignItems: 'center', gap: '8px' })

      const later = document.createElement('button')
      later.type = 'button'
      later.setAttribute('data-rc-action', 'later')
      later.textContent = T.later
      style(later, {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        cursor: 'pointer',
      })
      later.addEventListener('click', () => respond('later'))

      const now = document.createElement('button')
      now.type = 'button'
      now.setAttribute('data-rc-action', 'now')
      now.textContent = T.restartNow
      style(now, {
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)',
        color: '#fff',
        fontSize: '13px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      })
      now.addEventListener('click', () => respond('now'))

      actions.appendChild(later)
      actions.appendChild(now)
      pill.appendChild(actions)
      bar.appendChild(pill)
      document.body.appendChild(bar)
    }

    async function poll() {
      try {
        const res = await fetch(STATE_URL, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) {
          removeBar()
          return
        }
        const data = await res.json()
        if (data && data.pending === true) {
          ensureBar()
        } else {
          removeBar()
        }
      } catch {
        // server restarting / transient network error: keep the current state
      }
    }

    async function respond(action) {
      if (responding) return
      responding = true
      setBusy()
      try {
        await fetch(RESPOND_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
      } catch {
        // ignore: "now" will tear the connection down mid-request anyway
      }
      if (action === 'later') {
        responding = false
        removeBar()
      }
      // action === 'now': the service restarts within ~2s; the page disconnects
    }

    function apply() {
      timer = setInterval(poll, POLL_MS)
      poll()
      return () => {
        if (timer) clearInterval(timer)
        removeBar()
      }
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  },
})
