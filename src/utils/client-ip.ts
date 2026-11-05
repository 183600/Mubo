/** WeakMap storing client IPs keyed by Request, allowing middleware to reuse
 * the resolved IP without re-resolving the socket address. */
const clientIps = new WeakMap<Request, string>();

/**
 * Stores the client IP resolved for a request so middleware can reuse it
 * without resolving the socket address a second time.
 */
export function attachClientIp(request: Request, ip: string): void {
  clientIps.set(request, ip);
}

/** Returns the client IP previously attached to a request, if any. */
export function readClientIp(request: Request): string | undefined {
  return clientIps.get(request);
}
