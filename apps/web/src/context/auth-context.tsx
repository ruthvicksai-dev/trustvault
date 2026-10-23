import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { User } from "@/types";
import { authApi, setOnUnauthorizedHandler } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (credentials: { email: string; password: string }) => Promise<void>;
  register: (data: { email: string; password: string }) => Promise<{ message: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const refreshUser = useCallback(async () => {
    try {
      const res = await authApi.getMe();
      setUser(res.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Hook up unauthorized handler so session expiration automatically clears user
    setOnUnauthorizedHandler(() => {
      setUser(null);
    });

    let isMounted = true;
    authApi
      .getMe()
      .then((res) => {
        if (isMounted) setUser(res.user);
      })
      .catch(() => {
        if (isMounted) setUser(null);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const login = async (credentials: { email: string; password: string }) => {
    const res = await authApi.login(credentials);
    setUser(res.user);
  };

  const register = async (data: { email: string; password: string }) => {
    const res = await authApi.register(data);
    return { message: res.message };
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
