/**
 * dsh-revive browser half: the one-click revive widget on the composer dock.
 * The widget polls the host `/revive` snapshot and drives the revive-all
 * action — no model involvement, no per-session UI.
 * @module
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'conversation.composer.dock' SlotMap merge declared by
// the web conversation owner package into this compilation unit.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ReviveDock } from './ReviveDock.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle

  // Mount inside the owner's declaration lifetime: the widget registers only
  // while the composer dock slot exists, and unloads with this plugin.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'revive',
    order: 20,
    inject: () => ({ connection }),
  }, ReviveDock))
}
