export class CliError extends Error {
  constructor(message, { exitCode = 1, details = [] } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export class ConfigError extends CliError {
  constructor(message, details = []) {
    super(message, { exitCode: 1, details });
    this.name = "ConfigError";
  }
}

export class ConflictError extends CliError {
  constructor(message, details = []) {
    super(message, { exitCode: 2, details });
    this.name = "ConflictError";
  }
}
