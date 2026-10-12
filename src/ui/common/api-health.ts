// The extension pages' own GET {baseUrl}/models: the endpoint's readiness shows even when the engine is not running,
// and Options uses it for "Test connection". The mapping is core/health's, the same the engine uses.

import { classifyFetchError } from "../../shared/core/api-errors.ts";
import {
  configProblem,
  INITIAL_HEALTH,
  listedModels,
  modelsUrl,
  readinessFrom,
  readinessFromFetchError,
  type HealthReading,
} from "../../shared/core/health.ts";

export interface ApiEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  healthTimeoutMs: number;
}

export interface HealthResult {
  reading: HealthReading;
  /** Model ids the server listed (null when it has no /models route or the answer was not a list). */
  models: string[] | null;
}

export async function fetchApiHealth(
  endpoint: ApiEndpoint,
  options: { fetch?: typeof fetch } = {},
): Promise<HealthResult> {
  const problem = configProblem(endpoint.baseUrl, endpoint.model);
  if (problem !== null) {
    return {
      reading: {
        ...INITIAL_HEALTH,
        readiness: "misconfigured",
        model: endpoint.model.trim() || null,
        cause: problem,
      },
      models: null,
    };
  }
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = {};
  if (endpoint.apiKey.trim() !== "") headers["Authorization"] = `Bearer ${endpoint.apiKey.trim()}`;
  try {
    const response = await doFetch(modelsUrl(endpoint.baseUrl), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers,
      signal: AbortSignal.timeout(endpoint.healthTimeoutMs),
    });
    const body: unknown = await response.json().catch(() => null);
    return {
      reading: readinessFrom({ status: response.status, body }, endpoint.model),
      models: response.ok ? listedModels(body) : null,
    };
  } catch (error) {
    return { reading: readinessFromFetchError(classifyFetchError(error), endpoint.model), models: null };
  }
}

/** The endpoint fields of the settings (settings.api). */
export function endpointOf(api: ApiEndpoint): ApiEndpoint {
  return { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model, healthTimeoutMs: api.healthTimeoutMs };
}
