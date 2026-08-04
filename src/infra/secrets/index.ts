// Secrets adapter — module code never reads process.env for credentials.
// Dev/MVP: env-backed. Production: swap for a cloud secrets-manager implementation
// behind the same interface (refs like `env:NAME` stay stable in the DB).

export interface Secrets {
  /** Resolve a secret by reference, e.g. "env:EHR_JWT_PRIVATE_KEY". Throws if missing. */
  get(ref: string): Promise<string>;
}

export class EnvSecrets implements Secrets {
  get(ref: string): Promise<string> {
    const name = ref.startsWith('env:') ? ref.slice(4) : ref;
    const value = process.env[name];
    if (value === undefined || value === '') {
      return Promise.reject(new Error(`Secret not found: ${ref}`));
    }
    return Promise.resolve(value);
  }
}

export const secrets: Secrets = new EnvSecrets();
