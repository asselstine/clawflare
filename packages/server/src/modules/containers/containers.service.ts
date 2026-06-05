import {
  ContainerRepository,
  SessionRepository,
  type ContainerRecord,
  type SessionContainerLink,
} from "../../data/index.js";
import type { Env } from "../../internal-types/index.js";
import { destroyContainer, getContainerHealth } from "../tools/container/client.js";

export interface CreateContainerInput {
  id?: string;
  description?: string;
  sessionId?: string;
}

export interface CreateContainerResult {
  container: ContainerRecord;
  sessionLink?: SessionContainerLink;
  runtimeStatus?: string;
}

export async function createContainerModel(
  env: Env,
  workspaceId: string,
  input: CreateContainerInput,
  signal?: AbortSignal
): Promise<CreateContainerResult> {
  const id = input.id || crypto.randomUUID();
  const repository = new ContainerRepository(env.DB);
  const container = await repository.create({
    id,
    workspaceId,
    description: input.description,
  });

  let sessionLink: SessionContainerLink | undefined;
  if (input.sessionId) {
    sessionLink = await repository.linkSession({
      workspaceId,
      sessionId: input.sessionId,
      containerId: id,
      role: "attached",
    });
  }

  const health = await getContainerHealth(env, id, signal);
  return {
    container,
    sessionLink,
    runtimeStatus: health.status,
  };
}

export async function listContainers(env: Env, workspaceId: string): Promise<ContainerRecord[]> {
  return new ContainerRepository(env.DB).list(workspaceId);
}

export async function getContainerModel(
  env: Env,
  workspaceId: string,
  id: string
): Promise<ContainerRecord | null> {
  return new ContainerRepository(env.DB).get(workspaceId, id);
}

export async function listSessionContainers(
  env: Env,
  workspaceId: string,
  sessionId: string
): Promise<ContainerRecord[]> {
  const sessions = new SessionRepository(env.DB);
  const session = await sessions.findByIdInWorkspace(workspaceId, sessionId);
  if (!session) throw new Error("Session not found");
  return new ContainerRepository(env.DB).listForSession(workspaceId, sessionId);
}

export async function linkContainerToSession(
  env: Env,
  workspaceId: string,
  containerId: string,
  sessionId: string
): Promise<SessionContainerLink> {
  return new ContainerRepository(env.DB).linkSession({
    workspaceId,
    sessionId,
    containerId,
    role: "attached",
  });
}

export async function unlinkContainerFromSession(
  env: Env,
  workspaceId: string,
  containerId: string,
  sessionId: string
): Promise<void> {
  await new ContainerRepository(env.DB).unlinkSession(workspaceId, sessionId, containerId);
}

export async function destroyContainerModel(
  env: Env,
  workspaceId: string,
  id: string,
  signal?: AbortSignal
): Promise<void> {
  const repository = new ContainerRepository(env.DB);
  const container = await repository.get(workspaceId, id);
  if (!container) throw new Error("Container not found");
  if (signal?.aborted) throw new Error("Container destroy aborted");
  await destroyContainer(env, id);
  await repository.markDestroyed(workspaceId, id);
}
