// Capture intent before the SDK consumes and clears the callback URL.
export function passwordIntent(href) {
 const u = new URL(href);
 const type = new URLSearchParams(u.hash.slice(1)).get('type');
 return u.searchParams.get('auth') === 'set-password' || type === 'invite' || type === 'recovery';
}
export function passwordError(password, confirmation) {
 if (password.length < 12) return 'Use at least 12 characters.';
 if (password !== confirmation) return 'Passwords do not match.';
 return '';
}
export function authRedirect(origin) {
 return new URL('/?auth=set-password', origin).href;
}
