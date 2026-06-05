import { Hono } from "hono";
import type { AppBindings } from "../../http/app-bindings.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  handleDeviceApprove,
  handleDeviceAuthPoll,
  handleDeviceAuthStart,
  handleDeviceVerify,
  handleForgotPassword,
  handleGetCurrentUser,
  handleGithubCallback,
  handleLogin,
  handleLogout,
  handleMockOAuthAutoApprove,
  handleRegister,
  handleResetPassword,
  handleVerifyEmail,
} from "./auth.handlers.js";

export const authRoutes = new Hono<AppBindings>();

authRoutes.post("/register", (c) => handleRegister(c.req.raw, c.env));
authRoutes.post("/login", (c) => handleLogin(c.req.raw, c.env));
authRoutes.post("/device/start", (c) => handleDeviceAuthStart(c.req.raw, c.env));
authRoutes.post("/device/poll", (c) => handleDeviceAuthPoll(c.req.raw, c.env));
authRoutes.get("/device/verify", (c) => handleDeviceVerify(c.req.raw, c.env));
authRoutes.post("/device/approve", (c) => handleDeviceApprove(c.req.raw, c.env));
authRoutes.get("/github/callback", (c) => handleGithubCallback(c.req.raw, c.env));
authRoutes.get("/mock/auto-approve", (c) => handleMockOAuthAutoApprove(c.req.raw, c.env));
authRoutes.post("/password/forgot", (c) => handleForgotPassword(c.req.raw, c.env));
authRoutes.post("/password/reset", (c) => handleResetPassword(c.req.raw, c.env));
authRoutes.get("/email/verify", (c) => handleVerifyEmail(c.req.raw, c.env));

authRoutes.post("/logout", requireAuth, (c) =>
  handleLogout(c.req.raw, c.env, c.get("requestContext")!)
);

export const usersRoutes = new Hono<AppBindings>();

usersRoutes.use("*", requireAuth);
usersRoutes.get("/me", (c) =>
  handleGetCurrentUser(c.req.raw, c.env, c.get("requestContext")!)
);
