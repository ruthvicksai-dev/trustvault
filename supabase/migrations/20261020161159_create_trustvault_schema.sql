CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Users and application roles
CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL
        CHECK (role IN ('admin', 'owner', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_lower_unique
    ON public.users (lower(email));

-- 2. Documents
CREATE TABLE public.documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES public.users(id),
    title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 100),
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX documents_owner_created_idx
    ON public.documents (owner_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX documents_category_idx
    ON public.documents (category)
    WHERE deleted_at IS NULL;

-- 3. Per-document grants
CREATE TABLE public.document_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.documents(id),
    user_id UUID NOT NULL REFERENCES public.users(id),
    permission TEXT NOT NULL
        CHECK (permission IN ('read', 'edit')),
    granted_by UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

-- Permit only one active grant per user/document pair.
CREATE UNIQUE INDEX document_grants_one_active_idx
    ON public.document_grants (document_id, user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX document_grants_user_active_idx
    ON public.document_grants (user_id, document_id)
    WHERE revoked_at IS NULL;

-- 4. Append-oriented audit events
CREATE TABLE public.audit_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    document_id UUID,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL
        CHECK (outcome IN ('success', 'denied', 'failure')),
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_document_time_idx
    ON public.audit_events (document_id, occurred_at DESC);

CREATE INDEX audit_events_actor_time_idx
    ON public.audit_events (actor_id, occurred_at DESC);

CREATE INDEX audit_events_time_idx
    ON public.audit_events (occurred_at DESC);

-- 5. PostgreSQL-backed sessions for Express session storage
CREATE TABLE public.sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_expire_idx ON public.sessions (expire);