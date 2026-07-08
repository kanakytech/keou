import { AsyncLocalStorage } from 'async_hooks';

// Per-request context — carries the caller's own provider key (opensource
// edition BYOK) from the HTTP layer down to the provider layer without
// threading it through every executor signature.
const als = new AsyncLocalStorage();

/** Express middleware: capture request-scoped values for downstream layers. */
export function requestContext(req, res, next) {
  als.run({ providerKey: req.get('X-Provider-Key') || null }, next);
}

/** The provider key the caller supplied for this request, if any. */
export function getRequestProviderKey() {
  return als.getStore()?.providerKey || null;
}
