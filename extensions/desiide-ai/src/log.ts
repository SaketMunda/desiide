/** Minimal logger surface so host logic stays testable without `vscode`. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
