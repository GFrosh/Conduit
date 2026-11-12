import type { ProcessingSuccessResponse } from '../../contracts/response.js';

/**
 * The presenter is deliberately thin. It exists so that a future transport
 * (e.g. a different envelope or a v2 shape) has one place to change, and so the
 * orchestrator never knows how its output is framed.
 */
export function presentSuccess(response: ProcessingSuccessResponse): ProcessingSuccessResponse {
  return response;
}
