// Functional role model for the demo. Transport security, token handling and
// storage encryption are handled separately; this module only decides which
// actions a role may perform.

export const ROLES = ['viewer', 'user', 'admin', 'system'];
const RANK = {viewer: 0, user: 1, admin: 2, system: 3};

export const ACTIONS = {
 'business:read': 'viewer',
 'business:write': 'user',
 'agent:chat': 'user',
 'settings:toggle': 'user',
 'settings:manage': 'admin',
 'roles:manage': 'admin',
 'cli:manage': 'system',
};

export function requiredRole(action) {
 return ACTIONS[action] ?? 'system';
}

export function can(role, action) {
 const actual = RANK[role] ?? -1;
 return actual >= RANK[requiredRole(action)];
}

export function canSwitchTo(role, target) {
 if (!ROLES.includes(target)) return false;
 if (target === 'system') return role === 'system';
 return can(role, 'roles:manage');
}

export function describe(role) {
 return {role, rank: RANK[role] ?? -1};
}
