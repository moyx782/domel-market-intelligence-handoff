-- Matches managed cloud migration version 20261027083440.
-- Event-trigger helper is internal, not an application RPC.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
