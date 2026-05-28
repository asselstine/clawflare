/**
 * Workspace Data Types
 * 
 * Domain types for workspace and user management.
 */

/**
 * User entity
 */
export interface User {
  id: string;
  email: string;
  displayName?: string;
  emailVerifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Parameters for creating a user
 */
export interface CreateUserParams {
  email: string;
  displayName?: string;
  emailVerifiedAt?: number;
}

/**
 * Workspace entity
 */
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description?: string;
  defaultModelConnectionId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace membership role
 */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/**
 * Workspace membership
 */
export interface WorkspaceMembership {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAt: number;
  updatedAt: number;
}

/**
 * User repository - manages users
 */
export interface UserRepository {
  /** Get user by ID */
  getById(id: string): Promise<User | null>;

  /** Get user by email */
  getByEmail(email: string): Promise<User | null>;

  /** Create new user */
  create(id: string, params: CreateUserParams): Promise<User>;

  /** Update user's email verified timestamp */
  setEmailVerified(userId: string): Promise<void>;
}

/**
 * Workspace repository - manages workspaces and memberships
 */
export interface WorkspaceRepository {
  /** Get workspace by ID */
  getById(id: string): Promise<Workspace | null>;

  /** Get workspace by slug */
  getBySlug(slug: string): Promise<Workspace | null>;

  /** Create new workspace */
  create(workspace: Omit<Workspace, "createdAt" | "updatedAt">): Promise<Workspace>;

  /** List workspaces for a user */
  listForUser(userId: string): Promise<Workspace[]>;

  /** Check if user is member of workspace */
  isMember(workspaceId: string, userId: string): Promise<boolean>;

  /** Get user's role in workspace */
  getUserRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;

  /** Add user to workspace */
  addMembership(membership: Omit<WorkspaceMembership, "joinedAt" | "updatedAt">): Promise<void>;

  /** Remove user from workspace */
  removeMembership(workspaceId: string, userId: string): Promise<void>;
}
