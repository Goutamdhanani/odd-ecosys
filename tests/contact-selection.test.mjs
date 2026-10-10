import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTACT_SELECTION,
  toggleContactSelection,
  setContactPageSelection,
  getContactPageSelection,
} from '../js/contact-selection.js';

test('contact selection stays selected across cursor pages and only deselects the current page', () => {
  const selected = new Set();
  assert.equal(setContactPageSelection(selected, [10, 9], true), true);
  assert.deepEqual(getContactPageSelection(selected, [10, 9]), {
    selected: 2, total: 2, allSelected: true, indeterminate: false,
  });

  assert.equal(setContactPageSelection(selected, [8, 7], true), true);
  assert.equal(selected.size, 4, 'IDs from the first cursor page remain selected after the next page is selected');
  assert.deepEqual(getContactPageSelection(selected, [7, 6]), {
    selected: 1, total: 2, allSelected: false, indeterminate: true,
  });

  assert.equal(setContactPageSelection(selected, [8, 7], false), true);
  assert.deepEqual([...selected].sort((a, b) => a - b), [9, 10]);
  assert.deepEqual(getContactPageSelection(selected, [10, 9]), {
    selected: 2, total: 2, allSelected: true, indeterminate: false,
  });
});

test('bulk contact selection rejects overflow without partially selecting a page', () => {
  assert.equal(MAX_CONTACT_SELECTION, 500);
  const selected = new Set(Array.from({ length: 499 }, (_, index) => index + 1));
  assert.equal(toggleContactSelection(selected, 500, true), true);
  assert.equal(toggleContactSelection(selected, 501, true), false);
  assert.equal(setContactPageSelection(selected, [502, 503], true), false);
  assert.equal(selected.size, 500);
  assert.deepEqual([...selected].slice(-2), [499, 500]);
  assert.equal(toggleContactSelection(selected, 1, false), true);
  assert.equal(toggleContactSelection(selected, 'invalid', true), false);
});
