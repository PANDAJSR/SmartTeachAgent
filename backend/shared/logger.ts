export function createLogger(prefix: string) {
  const logInfo = (message: string, extra?: unknown): void => {
    if (typeof extra === "undefined") {
      console.info(`${prefix} ${message}`);
      return;
    }
    console.info(`${prefix} ${message}`, extra);
  };

  const logError = (message: string, error?: unknown): void => {
    if (!error) {
      console.error(`${prefix} ${message}`);
      return;
    }
    if (error instanceof Error) {
      console.error(`${prefix} ${message}: ${error.message}`);
      if (error.stack) {
        console.error(`${prefix} stack: ${error.stack}`);
      }
      return;
    }
    console.error(`${prefix} ${message}`, error);
  };

  return { logInfo, logError };
}
