/** Prefix for all multi-agent manager engine IDs: AQM-{machine-guid}. */
export const MANAGER_ENGINE_PREFIX = 'AQM-';

/** Returns true when the engine_id belongs to a multi-agent manager. */
export function isManagerEngineId(id: string | null | undefined): id is string {
  return !!id && id.startsWith(MANAGER_ENGINE_PREFIX);
}
