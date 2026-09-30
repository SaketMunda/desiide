/**
 * App-only first-run behavior. The Desiide desktop app ships this extension built in; the same
 * build also runs in stock VS Code (Beta standalone channel), where none of this may happen.
 */

/** `vscode.env.appName` in the Desiide app (product.json `nameLong`). */
export const DESIIDE_APP_NAME = 'Desiide';

/** Walkthrough contributed in package.json; its full ID is `<extension id>#<this>`. */
export const WALKTHROUGH_ID = 'desiide.welcome';

/** globalState key: set once the walkthrough has been opened for this user. */
export const WELCOME_SHOWN_KEY = 'desiide.app.welcomeShown';

export function isDesiideApp(appName: string): boolean {
  return appName === DESIIDE_APP_NAME;
}

/** Open the walkthrough exactly once, and only inside the Desiide app. */
export function shouldOpenWelcome(appName: string, alreadyShown: boolean): boolean {
  return isDesiideApp(appName) && !alreadyShown;
}
