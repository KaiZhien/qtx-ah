import { describe, it, expect } from 'vitest'
import {
  SETTING_REGISTRY, knownSetting, isKnownSetting, parseSettingValue,
  SETTING_KEY_PATTERN, describeSettingValue,
} from '@/modules/shared/settings/domain/settingRegistry'
import { FINANCE_APPROVAL_THRESHOLD_SGD } from '@/modules/shared/settings/services/settingService'

describe('the registry', () => {
  it('declares the finance threshold, the one knob the platform already reads', () => {
    const entry = knownSetting(FINANCE_APPROVAL_THRESHOLD_SGD)
    expect(entry).toBeTruthy()
    expect(entry!.type).toBe('number')
    expect(entry!.label).toMatch(/\S/)
    expect(entry!.description).toMatch(/\S/)
  })

  it('uses keys the database CHECK will actually accept', () => {
    // app_setting.key is CHECKed to ^[a-z][a-z0-9_]*$ — a key that fails it is a
    // knob nothing can ever store, which is silent until someone tries.
    for (const key of Object.keys(SETTING_REGISTRY)) {
      expect(key).toMatch(SETTING_KEY_PATTERN)
    }
  })

  it('treats an unregistered key as unknown rather than guessing a type', () => {
    expect(isKnownSetting('finance_approval_threshold_sgd')).toBe(true)
    expect(isKnownSetting('something_nobody_declared')).toBe(false)
    expect(knownSetting('something_nobody_declared')).toBeNull()
  })

  it('is own-property guarded, so an inherited member is not a setting', () => {
    // The key reaches this from a form post and from a jsonb row: "constructor"
    // and "toString" are plausible inputs and a prototype walk would return a
    // function typed as a registry entry.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isKnownSetting(key)).toBe(false)
      expect(knownSetting(key)).toBeNull()
    }
  })
})

describe('parseSettingValue — a threshold that becomes "abc" is refused at WRITE time', () => {
  const key = FINANCE_APPROVAL_THRESHOLD_SGD

  it('accepts a plain decimal and stores it as a JSON number', () => {
    // The seed comment is explicit: scalar knobs are bare JSON scalars — the
    // threshold is the number 5000, not {"amount": 5000}.
    expect(parseSettingValue(key, '5000')).toEqual({ ok: true, value: 5000 })
    expect(parseSettingValue(key, '12500.50')).toEqual({ ok: true, value: 12500.5 })
    expect(parseSettingValue(key, '0')).toEqual({ ok: true, value: 0 })
  })

  it('tolerates surrounding whitespace from a form field', () => {
    expect(parseSettingValue(key, '  5000  ')).toEqual({ ok: true, value: 5000 })
  })

  it('REFUSES a non-numeric threshold, which is the whole point of typing this', () => {
    // Discovered at write time, not at issue time. The alternative is a knob that
    // reads "abc" and fails closed on every invoice until someone finds the row.
    for (const bad of ['abc', '', '   ', 'NaN', 'Infinity', '1e5', '1,000', '0x10',
                       'true', 'null', '5000abc']) {
      const result = parseSettingValue(key, bad)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`expected ${JSON.stringify(bad)} to be refused`)
      expect(result.error).toMatch(/\S/)
    }
  })

  it('REFUSES a negative threshold — an amount below zero gates nothing', () => {
    const result = parseSettingValue(key, '-1')
    expect(result.ok).toBe(false)
  })

  it('refuses a value too large to hold exactly, rather than rounding it silently', () => {
    // The threshold is compared against numeric(12,2) in SQL. A value beyond what
    // a double represents exactly would compare against a number nobody typed.
    const result = parseSettingValue(key, '99999999999999999999')
    expect(result.ok).toBe(false)
  })

  it('refuses to parse a value for a key it does not know', () => {
    // Unknown keys are READ-ONLY in the console: inventing a type for one would
    // let the UI rewrite a knob whose meaning it does not know.
    const result = parseSettingValue('something_nobody_declared', '5000')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.toLowerCase()).toContain('not a setting this console knows')
  })
})

describe('parseSettingValue — the other declared types', () => {
  // Exercised through whatever the registry happens to declare, so the tests keep
  // meaning as keys are added rather than pinning a snapshot of today's list.
  const entriesOfType = (type: string) =>
    Object.entries(SETTING_REGISTRY).filter(([, e]) => e.type === type)

  it('accepts only true/false for a boolean knob', () => {
    for (const [key] of entriesOfType('boolean')) {
      expect(parseSettingValue(key, 'true')).toEqual({ ok: true, value: true })
      expect(parseSettingValue(key, 'false')).toEqual({ ok: true, value: false })
      expect(parseSettingValue(key, 'yes').ok).toBe(false)
      expect(parseSettingValue(key, '1').ok).toBe(false)
    }
  })

  it('accepts whole numbers only for an integer knob, and enforces its bounds', () => {
    for (const [key, entry] of entriesOfType('integer')) {
      expect(parseSettingValue(key, '7')).toEqual({ ok: true, value: 7 })
      expect(parseSettingValue(key, '7.5').ok).toBe(false)
      if (entry.min !== undefined) {
        expect(parseSettingValue(key, String(entry.min - 1)).ok).toBe(false)
      }
      if (entry.max !== undefined) {
        expect(parseSettingValue(key, String(entry.max + 1)).ok).toBe(false)
      }
    }
  })

  it('refuses a blank string knob rather than storing an empty setting', () => {
    for (const [key] of entriesOfType('string')) {
      expect(parseSettingValue(key, '   ').ok).toBe(false)
    }
  })
})

describe('describeSettingValue — rendering a stored jsonb value for the form', () => {
  it('renders a number without JSON quotes so the input round-trips', () => {
    expect(describeSettingValue(5000)).toBe('5000')
    expect(describeSettingValue(12500.5)).toBe('12500.5')
  })

  it('renders a string as itself, not as a quoted JSON literal', () => {
    expect(describeSettingValue('daily')).toBe('daily')
  })

  it('renders a boolean as true/false', () => {
    expect(describeSettingValue(true)).toBe('true')
    expect(describeSettingValue(false)).toBe('false')
  })

  it('renders a structured value as JSON so nothing is silently lost', () => {
    expect(describeSettingValue({ a: 1 })).toBe('{"a":1}')
    expect(describeSettingValue([1, 2])).toBe('[1,2]')
  })

  it('never renders undefined or throws on an odd value', () => {
    expect(describeSettingValue(null)).toBe('null')
    expect(describeSettingValue(undefined)).toBe('')
  })
})

describe('the fail-closed contract the console must not undo', () => {
  it('declares no DEFAULT for any knob', () => {
    // Deliberate, and load-bearing: a missing or non-numeric knob fails closed
    // and loudly at the reader. A UI default would quietly reintroduce the silent
    // fallback that decision removed — a control that switches itself off when its
    // row is deleted is invisible.
    for (const entry of Object.values(SETTING_REGISTRY)) {
      expect(entry).not.toHaveProperty('default')
      expect(entry).not.toHaveProperty('fallback')
    }
  })
})
