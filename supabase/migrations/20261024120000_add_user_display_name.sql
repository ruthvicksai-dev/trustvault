-- TrustVault — Add display_name column to public.users
-- Migration: 20261024120000_add_user_display_name.sql

ALTER TABLE public.users
ADD COLUMN IF NOT EXISTS display_name TEXT
CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 100);
