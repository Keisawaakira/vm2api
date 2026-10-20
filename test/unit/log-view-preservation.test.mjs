import test from 'node:test'
import assert from 'node:assert/strict'
import { toUsageLogRow } from '../../src/lib/db/repos/usage-logs-view.mjs'

const names = { users: new Map(), keys: new Map(), vms: new Map(), accounts: new Map() }
for (const [requested, upstream, mismatch] of [
  ['claude-opus-4-6(60000)', 'claude-opus-4-6', false],
  ['Anthropic/claude-opus-4-6[1m](max)', 'claude-opus-4-6', false],
  ['claude-opus-4-6(60000)', 'claude-sonnet-4-6', true],
  ['claude-opus-4-6(custom)', 'claude-opus-4-6', true],
])
  test(`new log view preserves model audit ${requested} -> ${upstream}`, () => {
    const original = { id: 'fixture', model_mismatch: 1, requested_model: requested, upstream_model: upstream }
    const row = toUsageLogRow(original, names)
    assert.equal(
      row.specialSettings.some((setting) => setting.key === 'mismatch'),
      mismatch,
    )
    assert.equal(row.originalModel, requested)
    assert.equal(row.actualResponseModel, upstream)
    assert.equal(original.model_mismatch, 1, 'historical storage is not migrated')
  })
