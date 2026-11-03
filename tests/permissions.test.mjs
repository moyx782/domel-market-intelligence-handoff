import test from 'node:test';
import assert from 'node:assert/strict';
import {can, canSwitchTo, requiredRole} from '../server/permissions.mjs';

test('role capabilities follow the four-tier matrix', () => {
 assert.equal(can('viewer', 'business:read'), true);
 assert.equal(can('viewer', 'business:write'), false);
 assert.equal(can('viewer', 'settings:toggle'), false);

 assert.equal(can('user', 'business:write'), true);
 assert.equal(can('user', 'agent:chat'), true);
 assert.equal(can('user', 'settings:toggle'), true);
 assert.equal(can('user', 'settings:manage'), false);
 assert.equal(can('user', 'roles:manage'), false);

 assert.equal(can('admin', 'settings:manage'), true);
 assert.equal(can('admin', 'roles:manage'), true);
 assert.equal(can('admin', 'cli:manage'), false);

 assert.equal(can('system', 'cli:manage'), true);
 assert.equal(can('system', 'settings:manage'), true);

 assert.equal(requiredRole('cli:manage'), 'system');
 assert.equal(requiredRole('settings:toggle'), 'user');
});

test('only system can assign system; admin assigns the other roles', () => {
 assert.equal(canSwitchTo('admin', 'user'), true);
 assert.equal(canSwitchTo('admin', 'admin'), true);
 assert.equal(canSwitchTo('admin', 'viewer'), true);
 assert.equal(canSwitchTo('admin', 'system'), false);
 assert.equal(canSwitchTo('user', 'admin'), false);
 assert.equal(canSwitchTo('system', 'system'), true);
});

test('task, event, source and recipe actions keep the four-tier boundaries', () => {
 // viewer: read only
 assert.equal(can('viewer', 'business:read'), true);
 assert.equal(can('viewer', 'agent:read'), true);
 assert.equal(can('viewer', 'tasks:write'), false);
 assert.equal(can('viewer', 'events:write'), false);
 assert.equal(can('viewer', 'sources:toggle'), false);
 // user: create tasks, correct events, toggle sources and agent settings
 assert.equal(can('user', 'tasks:write'), true);
 assert.equal(can('user', 'events:write'), true);
 assert.equal(can('user', 'sources:toggle'), true);
 assert.equal(can('user', 'sources:manage'), false);
 assert.equal(can('user', 'recipes:manage'), false);
 // admin: manage sources/recipes/settings but not the CLI
 assert.equal(can('admin', 'sources:manage'), true);
 assert.equal(can('admin', 'recipes:manage'), true);
 assert.equal(can('admin', 'cli:manage'), false);
 assert.equal(requiredRole('tasks:write'), 'user');
 assert.equal(requiredRole('events:write'), 'user');
 assert.equal(requiredRole('sources:toggle'), 'user');
 assert.equal(requiredRole('sources:manage'), 'admin');
 assert.equal(requiredRole('recipes:manage'), 'admin');
});
