// Error type shared by every AI provider adapter.
//
// It lives in its own module (rather than in provider.ts) so the adapters
// under providers/ can import it without creating an import cycle back
// through the provider factory.

/**
 * Thrown when the configured provider cannot be reached *at all* on this
 * machine: the CLI binary isn't installed, the API key env var is unset, the
 * local server isn't listening. This is a permanent, per-process condition -
 * retrying every 30 minutes would only produce the same error - so
 * provider.ts catches it and switches the process to no-AI mode (see
 * `disableAi`), where letters fall back to the template.
 *
 * A transient failure (timeout, HTTP 500, malformed model output) must NOT
 * use this type: those are worth retrying on the next pass.
 */
export class ProviderUnavailableError extends Error {
  readonly providerName: string;

  constructor(providerName: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
    this.providerName = providerName;
  }
}
