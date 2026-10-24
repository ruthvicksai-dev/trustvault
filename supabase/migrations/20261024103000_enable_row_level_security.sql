-- TrustVault — Row Level Security (RLS) & Access Control Migration
-- Migration: 20261024103000_enable_row_level_security.sql
-- Idempotent definition of Row Level Security policies for TrustVault tables.

-- -----------------------------------------------------------------------------
-- 1. Helper function: auth.uid()
-- Compatible with Supabase PostgREST (request.jwt.claim.sub) and standard PostgreSQL test sessions.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
      CREATE SCHEMA auth;
    END IF;

    CREATE FUNCTION auth.uid()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    AS $func$
      SELECT COALESCE(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'),
        nullif(current_setting('trustvault.current_user_id', true), '')
      )::uuid;
    $func$;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Helper security functions in public schema (SECURITY DEFINER to avoid recursion)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin' AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.user_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT role FROM public.users WHERE id = auth.uid() AND status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.is_document_owner(p_document_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.documents
    WHERE id = p_document_id
      AND owner_id = p_user_id
      AND deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.document_owner(p_document_id uuid)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT owner_id FROM public.documents WHERE id = p_document_id;
$$;

CREATE OR REPLACE FUNCTION public.has_document_grant(p_document_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_grants
    WHERE document_id = p_document_id
      AND user_id = p_user_id
      AND revoked_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.has_document_edit_grant(p_document_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.document_grants
    WHERE document_id = p_document_id
      AND user_id = p_user_id
      AND permission = 'edit'
      AND revoked_at IS NULL
  );
$$;

-- -----------------------------------------------------------------------------
-- 3. Enable RLS on all sensitive tables
-- -----------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;

ALTER TABLE public.document_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4. Policies for public.users
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS users_select_policy ON public.users;
CREATE POLICY users_select_policy ON public.users
  FOR SELECT TO public
  USING (
    auth.uid() = id OR public.is_admin()
  );

DROP POLICY IF EXISTS users_insert_policy ON public.users;
CREATE POLICY users_insert_policy ON public.users
  FOR INSERT TO public
  WITH CHECK (
    public.is_admin() OR (role = 'viewer' AND status = 'active')
  );

DROP POLICY IF EXISTS users_update_policy ON public.users;
CREATE POLICY users_update_policy ON public.users
  FOR UPDATE TO public
  USING (
    auth.uid() = id OR public.is_admin()
  )
  WITH CHECK (
    -- Prevent unauthorized privilege escalation or role change by non-admin
    (auth.uid() = id AND (public.is_admin() OR role = public.user_role()))
    OR public.is_admin()
  );

DROP POLICY IF EXISTS users_delete_policy ON public.users;
CREATE POLICY users_delete_policy ON public.users
  FOR DELETE TO public
  USING (
    public.is_admin()
  );

-- -----------------------------------------------------------------------------
-- 5. Policies for public.documents
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS documents_select_policy ON public.documents;
CREATE POLICY documents_select_policy ON public.documents
  FOR SELECT TO public
  USING (
    deleted_at IS NULL AND (
      owner_id = auth.uid()
      OR public.has_document_grant(documents.id, auth.uid())
    )
  );

DROP POLICY IF EXISTS documents_insert_policy ON public.documents;
CREATE POLICY documents_insert_policy ON public.documents
  FOR INSERT TO public
  WITH CHECK (
    owner_id = auth.uid()
    AND deleted_at IS NULL
    AND public.user_role() IN ('owner', 'admin')
  );

DROP POLICY IF EXISTS documents_update_policy ON public.documents;
CREATE POLICY documents_update_policy ON public.documents
  FOR UPDATE TO public
  USING (
    deleted_at IS NULL AND (
      owner_id = auth.uid()
      OR public.has_document_edit_grant(documents.id, auth.uid())
    )
  )
  WITH CHECK (
    -- Original owner can update title/category, transfer, or soft-delete
    (public.is_document_owner(documents.id, auth.uid()))
    OR
    -- Edit grantees can update title/category, but cannot change ownership or soft-delete
    (
      public.has_document_edit_grant(documents.id, auth.uid())
      AND deleted_at IS NULL
      AND owner_id = public.document_owner(documents.id)
    )
  );

DROP POLICY IF EXISTS documents_delete_policy ON public.documents;
CREATE POLICY documents_delete_policy ON public.documents
  FOR DELETE TO public
  USING (
    owner_id = auth.uid()
  );

-- -----------------------------------------------------------------------------
-- 6. Policies for public.document_grants
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS document_grants_select_policy ON public.document_grants;
CREATE POLICY document_grants_select_policy ON public.document_grants
  FOR SELECT TO public
  USING (
    -- Document owner can view all grants on non-deleted documents
    public.is_document_owner(document_grants.document_id, auth.uid())
    OR
    -- Grantee can view their own active grant
    (
      user_id = auth.uid()
      AND revoked_at IS NULL
    )
  );

DROP POLICY IF EXISTS document_grants_insert_policy ON public.document_grants;
CREATE POLICY document_grants_insert_policy ON public.document_grants
  FOR INSERT TO public
  WITH CHECK (
    -- Only the document owner can grant access to non-deleted documents
    public.is_document_owner(document_grants.document_id, auth.uid())
    AND granted_by = auth.uid()
    AND user_id != auth.uid()
    AND revoked_at IS NULL
  );

DROP POLICY IF EXISTS document_grants_update_policy ON public.document_grants;
CREATE POLICY document_grants_update_policy ON public.document_grants
  FOR UPDATE TO public
  USING (
    -- Only document owner can update or revoke grants
    public.is_document_owner(document_grants.document_id, auth.uid())
  )
  WITH CHECK (
    public.is_document_owner(document_grants.document_id, auth.uid())
  );

DROP POLICY IF EXISTS document_grants_delete_policy ON public.document_grants;
CREATE POLICY document_grants_delete_policy ON public.document_grants
  FOR DELETE TO public
  USING (
    public.is_document_owner(document_grants.document_id, auth.uid())
  );

-- -----------------------------------------------------------------------------
-- 7. Policies for public.audit_events (Append-only)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_events_select_policy ON public.audit_events;
CREATE POLICY audit_events_select_policy ON public.audit_events
  FOR SELECT TO public
  USING (
    -- Admins have system oversight
    public.is_admin()
    OR
    -- Document owners can view audit logs for their documents
    (
      document_id IS NOT NULL
      AND public.is_document_owner(audit_events.document_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS audit_events_insert_policy ON public.audit_events;
CREATE POLICY audit_events_insert_policy ON public.audit_events
  FOR INSERT TO public
  WITH CHECK (
    actor_id IS NULL OR actor_id = auth.uid() OR public.is_admin()
  );

-- Zero UPDATE or DELETE policies for audit_events to guarantee append-only integrity.

-- -----------------------------------------------------------------------------
-- 8. Policies for public.sessions
-- Zero policies for public/anon/authenticated: Default Deny.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- Defense-in-depth: Revoke direct table privileges on sessions from public/anon/authenticated
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.sessions FROM authenticated;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 9. Supabase Storage: Document storage security configuration
-- -----------------------------------------------------------------------------
-- In Supabase, the 'storage.objects' table is managed by 'supabase_storage_admin'
-- and has Row Level Security enabled by default.
--
-- The TrustVault storage bucket ('trustvault-private') is created as private (public: false).
-- Because no permissive policies exist on 'storage.objects' for 'trustvault-private',
-- direct client access (anon / authenticated) is denied by default at the storage layer.
-- All upload, download, and delete operations are safely mediated server-side by the
-- Express API using the service-role secret key after performing database-level
-- authorization checks in authorizeDocumentAccess().

