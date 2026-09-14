/**
 * dsh-webchat-entry: HOST half.
 *
 * Owns one durable settings namespace so the browser half has a place to store
 * whether the sidebar entry is visible. That is the entire host surface — the
 * button itself is a pure client contribution, so nothing here touches HTTP,
 * the filesystem, or the network.
 *
 * ESM module format (cordis bundle rule): named exports apply/name.
 *
 * @module dsh-webchat-entry
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-webchat-entry'

/** Settings namespace owned by this plugin; the client half binds the same id. */
const SETTINGS_NAMESPACE = 'dsh-webchat-entry'

/** Field carrying the sidebar-entry visibility preference. */
const SHOW_ENTRY_FIELD = 'showEntry'

/**
 * Durable entry preferences. `showEntry` defaults to `true`, so a fresh install
 * shows the entry without any configuration; `applies` stays at the settings
 * service default (`live`) so toggling it takes effect without a restart.
 */
const EntrySettingsSchema = z.object({
  [SHOW_ENTRY_FIELD]: z.boolean().default(true),
})

/**
 * Register the durable settings section when a settings provider exists.
 *
 * The registration is owned by this plugin's fiber through `ctx.inject`, so an
 * unloaded plugin withdraws its namespace instead of leaving a stale section
 * behind.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, EntrySettingsSchema)
  })
}
