import React, { useState } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth-context";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RiShieldCheckLine,
  RiLock2Line,
  RiMailLine,
  RiAlertLine,
  RiCheckLine,
  RiInformationLine,
} from "@remixicon/react";

export function LoginPage() {
  const { isAuthenticated, loading, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [activeTab, setActiveTab] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // If already authenticated, redirect to destination or overview
  if (!loading && isAuthenticated) {
    const from = (location.state as any)?.from?.pathname || "/overview";
    return <Navigate to={from} replace />;
  }

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Please enter your email address.");
      return;
    }
    if (!password) {
      setError("Please enter your password.");
      return;
    }

    setIsSubmitting(true);
    try {
      await login({ email: trimmedEmail, password });
      navigate("/overview", { replace: true });
    } catch (err: any) {
      setError(err?.message || "Invalid email or password.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Email is required.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }
    if (password.length < 12) {
      setError("Password must be at least 12 characters long according to security policy.");
      return;
    }
    if (password.length > 128) {
      setError("Password cannot exceed 128 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await register({ email: trimmedEmail, password });
      setSuccess(`${res.message} You can now sign in with your credentials.`);
      setPassword("");
      setConfirmPassword("");
      setActiveTab("login");
    } catch (err: any) {
      setError(err?.message || "Registration failed. An account with this email may already exist.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background relative overflow-hidden">
      {/* Subtle decorative background gradient */}
      <div className="absolute inset-0 bg-radial-[at_top_right] from-primary/5 via-transparent to-transparent pointer-events-none" />

      <div className="w-full max-w-md z-10 space-y-6">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex items-center justify-center size-12 rounded-2xl bg-primary text-primary-foreground shadow-md shadow-primary/20">
            <RiShieldCheckLine className="size-7" />
          </div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-foreground">
            TrustVault
          </h1>
          <p className="text-xs text-muted-foreground max-w-xs">
            Enterprise document security with per-document authorization and immutable auditing
          </p>
        </div>

        {/* Auth Card */}
        <Card className="border-border/80 shadow-lg shadow-foreground/5">
          <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as any); setError(null); setSuccess(null); }} className="w-full">
            <CardHeader className="pb-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Sign In</TabsTrigger>
                <TabsTrigger value="register">Register</TabsTrigger>
              </TabsList>
            </CardHeader>

            {/* Error & Success Messages */}
            <div className="px-6">
              {error && (
                <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-destructive/10 text-destructive text-xs border border-destructive/20 mb-3 animate-in fade-in-50">
                  <RiAlertLine className="size-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
              {success && (
                <div className="flex items-start gap-2.5 p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs border border-emerald-500/20 mb-3 animate-in fade-in-50">
                  <RiCheckLine className="size-4 shrink-0 mt-0.5" />
                  <span>{success}</span>
                </div>
              )}
            </div>

            {/* Sign In Form */}
            <TabsContent value="login" className="m-0">
              <form onSubmit={handleLoginSubmit}>
                <CardContent className="space-y-4 pt-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-email">Email Address</Label>
                    <div className="relative">
                      <RiMailLine className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        id="login-email"
                        type="email"
                        className="pl-9"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={isSubmitting}
                        autoComplete="email"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="login-password">Password</Label>
                    <div className="relative">
                      <RiLock2Line className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        id="login-password"
                        type="password"
                        className="pl-9"
                        placeholder="••••••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={isSubmitting}
                        autoComplete="current-password"
                        required
                      />
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="flex flex-col gap-3 pt-2">
                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? "Authenticating…" : "Sign In to Vault"}
                  </Button>
                </CardFooter>
              </form>
            </TabsContent>

            {/* Register Form */}
            <TabsContent value="register" className="m-0">
              <form onSubmit={handleRegisterSubmit}>
                <CardContent className="space-y-4 pt-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-email">Work Email</Label>
                    <div className="relative">
                      <RiMailLine className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        id="reg-email"
                        type="email"
                        className="pl-9"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={isSubmitting}
                        autoComplete="email"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-password">Password</Label>
                    <div className="relative">
                      <RiLock2Line className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        id="reg-password"
                        type="password"
                        className="pl-9"
                        placeholder="Min. 12 characters"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={isSubmitting}
                        autoComplete="new-password"
                        required
                        minLength={12}
                        maxLength={128}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Minimum 12 characters. Full Unicode & spaces supported.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="reg-confirm">Confirm Password</Label>
                    <div className="relative">
                      <RiLock2Line className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <Input
                        id="reg-confirm"
                        type="password"
                        className="pl-9"
                        placeholder="Re-enter password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        disabled={isSubmitting}
                        autoComplete="new-password"
                        required
                      />
                    </div>
                  </div>

                  <div className="p-3 rounded-2xl bg-muted/50 border border-border/50 text-[11px] text-muted-foreground flex items-start gap-2">
                    <RiInformationLine className="size-4 shrink-0 text-primary mt-0.5" />
                    <span>
                      New accounts are provisioned with the <strong>viewer</strong> role. Document upload capabilities can be granted by an administrator or document owner.
                    </span>
                  </div>
                </CardContent>

                <CardFooter className="flex flex-col gap-3 pt-2">
                  <Button type="submit" className="w-full" disabled={isSubmitting}>
                    {isSubmitting ? "Creating Account…" : "Create Account"}
                  </Button>
                </CardFooter>
              </form>
            </TabsContent>
          </Tabs>
        </Card>

        {/* Security Disclosures */}
        <div className="text-center text-[11px] text-muted-foreground/80 space-y-1">
          <p>Protected by Argon2id password hashing, session fixation defense, and strict origin validation.</p>
        </div>
      </div>
    </div>
  );
}
