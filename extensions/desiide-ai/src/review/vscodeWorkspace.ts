import * as vscode from 'vscode';
import { minimalReplace } from '../../shared/review/blocks.ts';
import type { Logger } from '../log.ts';
import type { FileChange, ReviewWorkspace } from './service.ts';

/** Workspace paths resolve against the first folder, like the orchestrator's (COR-6 adds multi-root). */
export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'file')?.uri;
}

/**
 * ADR-004 with VS Code: reads go through text documents, so an open buffer, dirty or not, is what
 * gets validated and edited, never a stale disk copy. All changes go in one `WorkspaceEdit`, which
 * VS Code undoes as one step. Files that were clean are saved afterwards so the agent's checks
 * (tests, lint) see the change on disk; a buffer that already had unsaved edits is left for the
 * user to save, since saving it would write their unfinished work too.
 */
export function vscodeReviewWorkspace(log: Logger): ReviewWorkspace {
  const uriOf = (path: string): vscode.Uri => {
    const root = workspaceRoot();
    if (!root) throw new Error('Open a folder to apply edits.');
    return vscode.Uri.joinPath(root, ...path.split('/'));
  };

  async function open(path: string): Promise<vscode.TextDocument | null> {
    const uri = uriOf(path);
    const loaded = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (loaded) return loaded;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return null;
    }
    return vscode.workspace.openTextDocument(uri);
  }

  return {
    async read(paths) {
      const out = new Map<string, string | null>();
      for (const path of paths) out.set(path, (await open(path))?.getText() ?? null);
      return out;
    },

    async apply(changes: readonly FileChange[], label: string) {
      const docs = new Map<string, vscode.TextDocument | null>();
      for (const c of changes) docs.set(c.path, await open(c.path));
      // From here to applyEdit nothing awaits, so what we checked is what gets edited.
      const conflicts = changes
        .filter((c) => (docs.get(c.path)?.getText() ?? null) !== c.before)
        .map((c) => c.path);
      if (conflicts.length > 0) return { applied: false, conflicts };

      const edit = new vscode.WorkspaceEdit();
      const meta: vscode.WorkspaceEditEntryMetadata = { label, needsConfirmation: false };
      const wasClean = new Set<string>();
      for (const c of changes) {
        const doc = docs.get(c.path);
        const uri = uriOf(c.path);
        if (!doc) {
          edit.createFile(
            uri,
            { ignoreIfExists: false, contents: new TextEncoder().encode(c.after) },
            meta,
          );
          wasClean.add(c.path);
          continue;
        }
        if (!doc.isDirty) wasClean.add(c.path);
        const r = minimalReplace(c.before ?? '', c.after);
        edit.replace(
          uri,
          new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)),
          r.text,
          meta,
        );
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) return { applied: false, conflicts: [] };

      for (const c of changes) {
        if (!wasClean.has(c.path)) continue;
        try {
          const doc = await vscode.workspace.openTextDocument(uriOf(c.path));
          if (doc.isDirty && !(await doc.save())) log.warn(`Applied but couldn't save ${c.path}`);
        } catch (err) {
          log.warn(`Applied but couldn't save ${c.path}: ${String(err)}`);
        }
      }
      return { applied: true, conflicts: [] };
    },
  };
}
